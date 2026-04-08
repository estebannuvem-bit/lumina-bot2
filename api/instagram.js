import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

const HUMAN_TIMEOUT    = 10 * 60 * 1000;
const DEBOUNCE_SECONDS = 15;

const DEFAULT_KEYWORDS = ["info", "precio", "servicios", "quiero", "ayuda", "marketing", "agencia", "cotizacion", "cotización", "negocio"];

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

function containsKeyword(text, keywords) {
  const lower = text.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return keywords.some(kw => {
    const normalizedKw = kw.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    return lower === normalizedKw;
  });
}

async function scheduleProcessing(clientId, senderId, channel) {
  const token     = process.env.QSTASH_TOKEN;
  const qstashUrl = process.env.QSTASH_URL || "https://qstash.upstash.io";
  const siteUrl   = process.env.SITE_URL;
  const destUrl   = `${siteUrl}/api/process`;

  const existingJobId = await redis.get(`qstash_job:${clientId}:${senderId}`);
  if (existingJobId) {
    try {
      await fetch(`${qstashUrl}/v2/messages/${existingJobId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (e) {}
  }

  const qstashRes = await fetch(`${qstashUrl}/v2/publish/${destUrl}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Upstash-Delay": `${DEBOUNCE_SECONDS}s`,
    },
    body: JSON.stringify({ clientId, senderId, channel }),
  });

  const data = await qstashRes.json();
  if (data.messageId) {
    await redis.set(`qstash_job:${clientId}:${senderId}`, data.messageId, { ex: 60 });
  }
}

// ─── RESPONDER COMENTARIO CON DM ──────────────────────────────

async function replyToCommentWithDM(senderId, commentText, clientId) {
  const token       = process.env.INSTAGRAM_ACCESS_TOKEN;
  const igAccountId = process.env.INSTAGRAM_ACCOUNT_ID;

  // Acumular en buffer para procesar con Claude
  const bufferKey = `buffer:${clientId}:${senderId}`;
  const buffer    = (await redis.get(bufferKey)) || [];
  buffer.push({ text: commentText, ts: Date.now(), channel: "instagram" });
  await redis.set(bufferKey, buffer, { ex: 60 });

  await scheduleProcessing(clientId, senderId, "instagram");
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
    const body  = req.body;
    const entry = body?.entry?.[0];

    // ── COMENTARIOS (instagram_business_manage_comments) ──────
    const changes = entry?.changes;
    if (changes && changes.length > 0) {
      for (const change of changes) {
        if (change.field === "comments" || change.field === "mention") {
          const value      = change.value;
          const commentId  = value?.id;
          const commentText = value?.text || value?.comment_text || "";
          const senderId   = value?.from?.id;

          console.log(`Instagram comment received [${clientId}]: "${commentText}" from ${senderId}`);

          if (!senderId || !commentText) continue;

          // Verificar keywords
          const savedKeywords = await redis.get(`instagram_keywords:${clientId}`);
          const keywords = savedKeywords ? JSON.parse(savedKeywords) : DEFAULT_KEYWORDS;
          const hasKeyword = containsKeyword(commentText, keywords);

          if (!hasKeyword) {
            console.log(`Comment ignored [${clientId}]: no keyword — "${commentText}"`);
            continue;
          }

          // Verificar modo humano
          const botKey  = `bot:${clientId}:${senderId}`;
          const botActive = await redis.get(botKey);
          if (botActive === false) continue;

          // Procesar comentario — enviar DM al usuario
          await replyToCommentWithDM(senderId, commentText, clientId);
        }
      }
      return res.status(200).json({ status: "comments processed" });
    }

    // ── MENSAJES DM (instagram_business_manage_messages) ──────
    const messaging = entry?.messaging?.[0];

    if (!messaging) return res.status(200).json({ status: "no event" });

    const senderId    = messaging.sender?.id;
    const messageText = messaging.message?.text;
    const isFromAd    = !!messaging.referral?.source_type;

    if (!messageText || !senderId) {
      return res.status(200).json({ status: "ignored" });
    }

    if (messaging.message?.is_echo) {
      return res.status(200).json({ status: "echo ignored" });
    }

    const savedKeywords = await redis.get(`instagram_keywords:${clientId}`);
    const keywords = savedKeywords ? JSON.parse(savedKeywords) : DEFAULT_KEYWORDS;
    const hasKeyword = containsKeyword(messageText, keywords);

    if (!isFromAd && !hasKeyword) {
      console.log(`Instagram DM ignored [${clientId}]: no ad, no keyword — "${messageText}"`);
      return res.status(200).json({ status: "filtered" });
    }

    const botKey   = `bot:${clientId}:${senderId}`;
    const humanKey = `last_human:${clientId}:${senderId}`;

    const lastHuman = await redis.get(humanKey);
    if (lastHuman && Date.now() - Number(lastHuman) > HUMAN_TIMEOUT) {
      await redis.set(botKey, true);
      await redis.del(humanKey);
    }

    const botActive = await redis.get(botKey);
    if (botActive === false) return res.status(200).json({ status: "bot paused" });

    const bufferKey = `buffer:${clientId}:${senderId}`;
    const buffer    = (await redis.get(bufferKey)) || [];
    buffer.push({ text: messageText, ts: Date.now(), channel: "instagram" });
    await redis.set(bufferKey, buffer, { ex: 60 });

    await scheduleProcessing(clientId, senderId, "instagram");

    return res.status(200).json({ status: "queued" });

  } catch (error) {
    console.error("Handler error:", error);
    await alertSlack(`🚨 Error critico en instagram webhook: ${error.message}`);
    return res.status(200).json({ status: "error" });
  }
}
