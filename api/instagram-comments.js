import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

const DEFAULT_KEYWORDS = ["info", "precio", "servicios", "quiero", "ayuda", "marketing", "agencia", "cotizacion", "cotización", "negocio"];

const DEFAULT_REPLIES = [
  "¡Hola! Te escribimos por DM ahora mismo 😊",
  "Claro que sí, revisá tus mensajes directos 👋",
  "¡Con gusto! Te contactamos por privado ahora 😊",
  "Perfecto, te enviamos más info por DM 🙌",
];

// ─── UTILIDADES ───────────────────────────────────────────────

async function alertSlack(message) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: message }),
    });
  } catch (e) {
    console.error("Slack alert failed:", e);
  }
}

function isExactKeyword(text, keywords) {
  const lower = text.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return keywords.some(kw => {
    const normalizedKw = kw.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    return lower === normalizedKw;
  });
}

async function getNextReply(clientId, replies) {
  const indexKey = `comment_reply_index:${clientId}`;
  const current  = (await redis.get(indexKey)) || 0;
  const next     = (Number(current) + 1) % replies.length;
  await redis.set(indexKey, next);
  return replies[Number(current)];
}

// ─── RESPONDER COMENTARIO PÚBLICAMENTE ────────────────────────

async function replyToComment(commentId, text) {
  const token = process.env.INSTAGRAM_ACCESS_TOKEN;
  const res   = await fetch(`https://graph.facebook.com/v19.0/${commentId}/replies`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: text, access_token: token }),
  });
  if (!res.ok) {
    const err = await res.json();
    console.error("Comment reply error:", err);
  }
}

// ─── ENVIAR DM AL USUARIO ─────────────────────────────────────

async function sendDM(recipientId, text) {
  const token = process.env.INSTAGRAM_ACCESS_TOKEN;
  const res   = await fetch(`https://graph.facebook.com/v19.0/${process.env.INSTAGRAM_ACCOUNT_ID}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      recipient: { id: recipientId },
      message: { text },
      messaging_type: "RESPONSE",
      access_token: token,
    }),
  });
  if (!res.ok) {
    const err = await res.json();
    console.error("DM send error:", err);
  }
}

// ─── ACTIVAR SOFÍA EN EL DM VÍA QSTASH ───────────────────────

async function activateSofia(clientId, senderId) {
  const token     = process.env.QSTASH_TOKEN;
  const qstashUrl = process.env.QSTASH_URL || "https://qstash.upstash.io";
  const siteUrl   = process.env.SITE_URL;

  // Guardar en buffer para que process.js lo tome
  const bufferKey = `buffer:${clientId}:${senderId}`;
  const buffer    = (await redis.get(bufferKey)) || [];
  buffer.push({ text: "inicio_desde_comentario", ts: Date.now(), channel: "instagram" });
  await redis.set(bufferKey, buffer, { ex: 60 });

  await fetch(`${qstashUrl}/v2/publish/${siteUrl}/api/process`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Upstash-Delay": "3s",
    },
    body: JSON.stringify({ clientId, senderId, channel: "instagram" }),
  });
}

// ─── HANDLER PRINCIPAL ────────────────────────────────────────

export default async function handler(req, res) {

  if (req.method === "GET") {
    const mode      = req.query["hub.mode"];
    const token     = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === process.env.META_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).json({ error: "Forbidden" });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const clientId = req.query.client || "nuvem";

  try {
    const body    = req.body;
    const entry   = body?.entry?.[0];
    const changes = entry?.changes?.[0];

    if (changes?.field !== "comments") {
      return res.status(200).json({ status: "not a comment" });
    }

    const commentData = changes?.value;
    const commentId   = commentData?.id;
    const commentText = commentData?.text;
    const senderId    = commentData?.from?.id;

    if (!commentId || !commentText || !senderId) {
      return res.status(200).json({ status: "invalid comment" });
    }

    // Deduplicacion
    const dedupKey = `dedup:comment:${commentId}`;
    const already  = await redis.get(dedupKey);
    if (already) return res.status(200).json({ status: "duplicate" });
    await redis.set(dedupKey, true, { ex: 300 });

    // Verificar keyword exacta
    const savedKeywords = await redis.get(`instagram_keywords:${clientId}`);
    const keywords = savedKeywords ? JSON.parse(savedKeywords) : DEFAULT_KEYWORDS;

    if (!isExactKeyword(commentText, keywords)) {
      return res.status(200).json({ status: "no keyword match" });
    }

    // Obtener frases rotatorias
    const savedReplies = await redis.get(`instagram_comment_replies:${clientId}`);
    const replies = savedReplies ? JSON.parse(savedReplies) : DEFAULT_REPLIES;
    const replyText = await getNextReply(clientId, replies);

    // 1. Responder el comentario públicamente
    await replyToComment(commentId, replyText);

    // 2. Enviar DM inicial
    await sendDM(senderId, replyText);

    // 3. Activar a Sofía para continuar la conversación por DM
    await activateSofia(clientId, senderId);

    return res.status(200).json({ status: "ok" });

  } catch (error) {
    console.error("Comment handler error:", error);
    await alertSlack(`🚨 Error en instagram-comments: ${error.message}`);
    return res.status(200).json({ status: "error" });
  }
}
