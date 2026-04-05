import { Redis } from "@upstash/redis";
import { getCatalog } from "./catalog.js";

const redis = Redis.fromEnv();

const HISTORY_TTL      = 60 * 60 * 24 * 3;
const MAX_HISTORY      = 40;
const MAX_RETRIES      = 3;
const INACTIVITY_RESET = 4 * 60 * 60 * 1000;

// ─── UTILIDADES ───────────────────────────────────────────────

function getToken(channel) {
  return channel === "instagram"
    ? process.env.INSTAGRAM_ACCESS_TOKEN
    : process.env.META_PAGE_ACCESS_TOKEN;
}

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
  } else if (text.includes("[[PEDIDO_LISTO]]")) {
    clean = text.replace("[[PEDIDO_LISTO]]", "").trim();
    event = "pedido_listo";
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

// ─── OBTENER NOMBRE DEL CONTACTO ──────────────────────────────

async function getContactName(senderId, channel) {
  const token   = getToken(channel);
  const phoneId = process.env.WHATSAPP_PHONE_ID;
  try {
    if (channel === "instagram") {
      const res = await fetch(
        `https://graph.facebook.com/v19.0/${senderId}?fields=name&access_token=${token}`
      );
      const data = await res.json();
      return data?.name || null;
    } else {
      const res = await fetch(
        `https://graph.facebook.com/v19.0/${phoneId}/contacts?fields=profile&filtering=[{"field":"wa_id","operator":"EQUAL","value":"${senderId}"}]`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const data = await res.json();
      return data?.data?.[0]?.profile?.name || null;
    }
  } catch (e) {
    return null;
  }
}

// ─── LLAMADA A CLAUDE CON PROMPT CACHING ──────────────────────

async function callClaude(systemBase, catalogText, history, retries = 0) {
  try {
    const messages = [
      {
        role: "user",
        content: `[CATALOGO ACTUALIZADO]\n${catalogText}\n[FIN CATALOGO]\n\nConfirma que recibiste el catalogo.`,
      },
      {
        role: "assistant",
        content: "Catalogo recibido y listo para consultas.",
      },
      ...history,
    ];

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "prompt-caching-2024-07-31",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 400,
        system: [
          {
            type: "text",
            text: systemBase,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages,
      }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || "API error");
    return data.content?.[0]?.text || null;
  } catch (err) {
    if (retries < MAX_RETRIES - 1) {
      await new Promise((r) => setTimeout(r, (retries + 1) * 1000));
      return callClaude(systemBase, catalogText, history, retries + 1);
    }
    throw err;
  }
}

// ─── ENVIAR MENSAJE ───────────────────────────────────────────

async function sendMessage(senderId, text, channel) {
  const token   = getToken(channel);
  const phoneId = process.env.WHATSAPP_PHONE_ID;

  if (channel === "instagram") {
    const pageId = process.env.INSTAGRAM_PAGE_ID;
    const res = await fetch(`https://graph.facebook.com/v19.0/${pageId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: senderId },
        message: { text },
        messaging_type: "RESPONSE",
        access_token: token,
      }),
    });
    if (!res.ok) {
      const err = await res.json();
      console.error("Instagram send error:", err);
    }
  } else {
    const res = await fetch(`https://graph.facebook.com/v19.0/${phoneId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: senderId,
        type: "text",
        text: { body: text },
      }),
    });
    if (!res.ok) {
      const err = await res.json();
      console.error("WhatsApp send error:", err);
    }
  }
}

// ─── HANDLER PRINCIPAL ────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { clientId, senderId, channel = "whatsapp" } = req.body;
  if (!clientId || !senderId) {
    return res.status(400).json({ error: "Missing params" });
  }

  try {
    // Leer y limpiar buffer
    const bufferKey = `buffer:${clientId}:${senderId}`;
    const buffer    = (await redis.get(bufferKey)) || [];
    await redis.del(bufferKey);

    if (buffer.length === 0) {
      return res.status(200).json({ status: "empty buffer" });
    }

    const messageText = buffer.map(m => m.text).join("\n");
    const msgChannel  = buffer[0]?.channel || channel;

    const historyKey  = `history:${clientId}:${senderId}`;
    const activityKey = `last_activity:${clientId}:${senderId}`;
    const nameKey     = `name:${clientId}:${senderId}`;
    const botKey      = `bot:${clientId}:${senderId}`;
    const humanKey    = `last_human:${clientId}:${senderId}`;

    // Resetear historial si estuvo inactivo más de 4 horas
    const lastActivity = await redis.get(activityKey);
    if (lastActivity && Date.now() - Number(lastActivity) > INACTIVITY_RESET) {
      await redis.del(historyKey);
    }
    await redis.set(activityKey, Date.now(), { ex: HISTORY_TTL });

    let history = (await redis.get(historyKey)) || [];

    // Obtener nombre del contacto
    let contactName = await redis.get(nameKey);
    if (!contactName) {
      contactName = await getContactName(senderId, msgChannel);
      if (contactName) {
        await redis.set(nameKey, contactName, { ex: 60 * 60 * 24 * 30 });
      }
    }

    // Prompt base del cliente
    let systemPrompt = await redis.get(`prompt:${clientId}`);
    if (!systemPrompt) {
      await alertSlack(`⚠️ Cliente *${clientId}* no tiene prompt configurado en Redis.`);
      return res.status(200).json({ status: "no prompt" });
    }

    // Inyectar nombre si está disponible
    if (contactName) {
      systemPrompt += `\n\nCONTEXTO: El nombre del contacto es ${contactName}. Úsalo en el saludo inicial y ocasionalmente en la conversación de forma natural.`;
    } else {
      systemPrompt += `\n\nCONTEXTO: No conoces el nombre del contacto. Pregúntalo de forma natural en el primer mensaje.`;
    }

    // Catalogo dinamico
    const vertical    = await redis.hget(`config:${clientId}`, "vertical") || "muebles";
    const catalogText = await getCatalog(clientId, vertical);

    if (!catalogText) {
      systemPrompt += "\n\nIMPORTANTE: El catalogo no esta disponible ahora.";
    }

    history.push({ role: "user", content: messageText });
    if (history.length > MAX_HISTORY) history = history.slice(-MAX_HISTORY);

    let raw;
    try {
      raw = await callClaude(
        systemPrompt,
        catalogText || "Sin catalogo disponible.",
        history
      );
      if (!raw) throw new Error("Empty response");
    } catch (err) {
      console.error("Claude failed:", err);
      await alertSlack(`🚨 Claude fallo para cliente *${clientId}*, contacto *${senderId}*.`);
      await sendMessage(senderId, "Disculpa, tuve un problema tecnico 😅 escribeme en unos minutos", msgChannel);
      return res.status(200).json({ status: "claude error" });
    }

    const { clean, event } = parseEvents(raw);

    history.push({ role: "assistant", content: clean });
    await redis.set(historyKey, history, { ex: HISTORY_TTL });

    // Eventos
    if (event === "pedido_listo") {
      await alertSlack(`🛒 *PEDIDO LISTO* — Cliente: *${clientId}* | Contacto: ${senderId}`);
      await redis.set(botKey, false);
      await redis.set(humanKey, Date.now());
    }

    if (event === "calificado" || event === "urgente") {
      await alertSlack(`🔔 *${event.toUpperCase()}* — Cliente: *${clientId}* | Canal: ${msgChannel} | Contacto: ${senderId}`);
    }

    if (event === "descalificado") {
      await redis.del(historyKey);
    }

    await sendMessage(senderId, clean, msgChannel);
    return res.status(200).json({ status: "ok" });

  } catch (error) {
    console.error("Process error:", error);
    await alertSlack(`🚨 Error critico en process: ${error.message}`);
    return res.status(200).json({ status: "error" });
  }
}
