import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

const HUMAN_TIMEOUT = 10 * 60 * 1000;
const HISTORY_TTL = 60 * 60 * 24 * 3;
const MAX_HISTORY = 10;
const MAX_BOT_MESSAGES = 10;
const MAX_RETRIES = 3;

// ─── UTILIDADES ───────────────────────────────────────────────

function parseEvents(text) {
  let clean = text;
  let event = null;
  if (text.includes("[[LEAD_CALIFICADO]]")) {
    clean = text.replace("[[LEAD_CALIFICADO]]", "").trim();
    event = "calificado";
  } else if (text.includes("[[LEAD_URGENTE]]")) {
    clean = text.replace("[[LEAD_URGENTE]]", "").trim();
    event = "urgente";
  } else if (text.includes("[[LEAD_DESCALIFICADO]]")) {
    clean = text.replace("[[LEAD_DESCALIFICADO]]", "").trim();
    event = "descalificado";
  }
  return { clean, event };
}

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

async function callClaude(system, messages, retries = 0) {
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 200,
        system,
        messages,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || "API error");
    return data.content?.[0]?.text || null;
  } catch (err) {
    if (retries < MAX_RETRIES - 1) {
      const wait = (retries + 1) * 1000;
      await new Promise((r) => setTimeout(r, wait));
      return callClaude(system, messages, retries + 1);
    }
    throw err;
  }
}

// ─── ENVIAR MENSAJE VÍA WHATSAPP API ──────────────────────────

async function sendWhatsAppMessage(to, text) {
  const token = process.env.META_PAGE_ACCESS_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_ID;

  const res = await fetch(`https://graph.facebook.com/v19.0/${phoneId}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: to,
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

  // Verificación del webhook de Meta (GET)
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === process.env.META_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).json({ error: "Forbidden" });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Obtener clientId desde query param: /api/whatsapp?client=nuvem
  const clientId = req.query.client || "nuvem";

  try {
    const body = req.body;

    // Verificar que sea un mensaje de WhatsApp
    const entry = body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const message = value?.messages?.[0];

    // Ignorar si no es mensaje
    if (!message) {
      return res.status(200).json({ status: "no message" });
    }

    // Solo procesar mensajes de texto
    if (message.type !== "text") {
      return res.status(200).json({ status: "non-text ignored" });
    }

    const senderId = message.from;
    const messageText = message.text?.body;

    if (!messageText || !senderId) {
      return res.status(200).json({ status: "invalid message" });
    }

    // Evitar procesar mensajes duplicados
    const msgId = message.id;
    const dedupKey = `dedup:${msgId}`;
    const alreadyProcessed = await redis.get(dedupKey);
    if (alreadyProcessed) {
      return res.status(200).json({ status: "duplicate" });
    }
    await redis.set(dedupKey, true, { ex: 60 });

    const botKey = `bot:${clientId}:${senderId}`;
    const humanKey = `last_human:${clientId}:${senderId}`;

    // Reactivar bot si pasaron 10 min sin respuesta humana
    const lastHuman = await redis.get(humanKey);
    if (lastHuman) {
      const diff = Date.now() - Number(lastHuman);
      if (diff > HUMAN_TIMEOUT) {
        await redis.set(botKey, true);
        await redis.del(humanKey);
      }
    }

    const botActive = await redis.get(botKey);
    if (botActive === false) {
      return res.status(200).json({ status: "bot paused" });
    }

    const historyKey = `history:${clientId}:${senderId}`;
    const countKey = `count:${clientId}:${senderId}`;

    let history = (await redis.get(historyKey)) || [];
    let botMessageCount = (await redis.get(countKey)) || 0;

    if (botMessageCount >= MAX_BOT_MESSAGES) {
      return res.status(200).json({ status: "limit reached" });
    }

    // Obtener prompt del cliente desde Redis
    let systemPrompt = await redis.get(`prompt:${clientId}`);
    if (!systemPrompt) {
      await alertSlack(`⚠️ Cliente *${clientId}* no tiene prompt configurado en Redis.`);
      return res.status(200).json({ status: "no prompt" });
    }

    history.push({ role: "user", content: messageText });
    if (history.length > MAX_HISTORY) {
      history = history.slice(-MAX_HISTORY);
    }

    // Llamar a Claude con reintentos
    let raw;
    try {
      raw = await callClaude(systemPrompt, history);
      if (!raw) throw new Error("Empty response");
    } catch (err) {
      console.error("Claude failed:", err);
      await alertSlack(`🚨 Claude falló para cliente *${clientId}*, contacto *${senderId}*.`);
      await sendWhatsAppMessage(senderId, "perdoná, tuve un problema técnico 😅 escribime en unos minutos");
      return res.status(200).json({ status: "claude error" });
    }

    const { clean, event } = parseEvents(raw);

    history.push({ role: "assistant", content: clean });
    botMessageCount += 1;

    await redis.set(historyKey, history, { ex: HISTORY_TTL });
    await redis.set(countKey, botMessageCount, { ex: HISTORY_TTL });

    if (event === "calificado" || event === "urgente" || event === "descalificado") {
      await redis.del(historyKey);
      await redis.del(countKey);
      if (event !== "descalificado") {
        await alertSlack(`🔔 *${event.toUpperCase()}* — Cliente: *${clientId}* | Contacto: ${senderId}`);
      }
    }

    // Enviar respuesta por WhatsApp
    await sendWhatsAppMessage(senderId, clean);

    return res.status(200).json({ status: "ok" });
  } catch (error) {
    console.error("Handler error:", error);
    await alertSlack(`🚨 Error crítico en whatsapp webhook: ${error.message}`);
    return res.status(200).json({ status: "error" });
  }
}
