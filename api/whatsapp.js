import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

const HUMAN_TIMEOUT    = 10 * 60 * 1000;
const HISTORY_TTL      = 60 * 60 * 24 * 3;
const DEBOUNCE_SECONDS = 4;

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

async function scheduleProcessing(clientId, senderId) {
  const token   = process.env.QSTASH_TOKEN;
  const siteUrl = process.env.SITE_URL;
  const destUrl = `${siteUrl}/api/process`;

  console.log("QStash scheduling to:", destUrl);

  const qstashUrl = process.env.QSTASH_URL || "https://qstash.upstash.io";

  // Cancelar job anterior si existe
  const existingJobId = await redis.get(`qstash_job:${clientId}:${senderId}`);
  if (existingJobId) {
    try {
      await fetch(`${qstashUrl}/v2/messages/${existingJobId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (e) {
      // Si ya se ejecutó no importa
    }
  }

  // Crear nuevo job con delay
  const qstashRes = await fetch(`${qstashUrl}/v2/publish/${destUrl}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Upstash-Delay": `${DEBOUNCE_SECONDS}s`,
    },
    body: JSON.stringify({ clientId, senderId }),
  });

  const data = await qstashRes.json();
  console.log("QStash response:", JSON.stringify(data));

  if (data.messageId) {
    await redis.set(`qstash_job:${clientId}:${senderId}`, data.messageId, { ex: 30 });
  }
}

// ─── ENVIAR MENSAJE VÍA WHATSAPP API ──────────────────────────

async function sendWhatsAppMessage(to, text) {
  const token   = process.env.META_PAGE_ACCESS_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_ID;

  const res = await fetch(`https://graph.facebook.com/v19.0/${phoneId}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    }),
  });

  if (!res.ok) {
    const err = await res.json();
    console.error("WhatsApp send error:", err);
  }
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
    const value   = changes?.value;
    const message = value?.messages?.[0];

    if (!message) return res.status(200).json({ status: "no message" });
    if (message.type !== "text") return res.status(200).json({ status: "non-text ignored" });

    const senderId    = message.from;
    const messageText = message.text?.body;

    if (!messageText || !senderId) {
      return res.status(200).json({ status: "invalid message" });
    }

    // Deduplicacion
    const dedupKey = `dedup:${message.id}`;
    const alreadyProcessed = await redis.get(dedupKey);
    if (alreadyProcessed) return res.status(200).json({ status: "duplicate" });
    await redis.set(dedupKey, true, { ex: 60 });

    const botKey   = `bot:${clientId}:${senderId}`;
    const humanKey = `last_human:${clientId}:${senderId}`;

    // Reactivar bot si pasaron 10 min sin respuesta humana
    const lastHuman = await redis.get(humanKey);
    if (lastHuman && Date.now() - Number(lastHuman) > HUMAN_TIMEOUT) {
      await redis.set(botKey, true);
      await redis.del(humanKey);
    }

    const botActive = await redis.get(botKey);
    if (botActive === false) return res.status(200).json({ status: "bot paused" });

    // Acumular mensaje en buffer
    const bufferKey = `buffer:${clientId}:${senderId}`;
    const buffer    = (await redis.get(bufferKey)) || [];
    buffer.push({ text: messageText, ts: Date.now() });
    await redis.set(bufferKey, buffer, { ex: 30 });

    // Programar procesamiento con debounce
    await scheduleProcessing(clientId, senderId);

    return res.status(200).json({ status: "queued" });

  } catch (error) {
    console.error("Handler error:", error);
    await alertSlack(`🚨 Error critico en whatsapp webhook: ${error.message}`);
    return res.status(200).json({ status: "error" });
  }
}
