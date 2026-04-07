import { Redis } from "@upstash/redis";
import { getCatalog } from "./catalog.js";

const redis = Redis.fromEnv();

const HISTORY_TTL      = 60 * 60 * 24 * 3;
const MAX_HISTORY      = 40;
const MAX_RETRIES      = 3;
const INACTIVITY_RESET = 4 * 60 * 60 * 1000;

// ─── SUPABASE ─────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function supabaseFetch(path, method = "GET", body = null) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
      method,
      headers: {
        "Content-Type":  "application/json",
        "apikey":         SUPABASE_KEY,
        "Authorization": `Bearer ${SUPABASE_KEY}`,
        "Prefer":        method === "POST" ? "return=representation" : "",
      },
      body: body ? JSON.stringify(body) : null,
    });
    if (!res.ok) {
      const err = await res.text();
      console.error("Supabase error:", err);
      return null;
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  } catch (e) {
    console.error("Supabase fetch failed:", e.message);
    return null;
  }
}

// Verifica si el cliente superó el límite mensual
async function checkMonthlyLimit(clientId) {
  const firstOfMonth = new Date();
  firstOfMonth.setDate(1);
  firstOfMonth.setHours(0, 0, 0, 0);

  // Obtener límite del cliente
  const clients = await supabaseFetch(`/clients?client_id=eq.${clientId}&select=monthly_limit`, "GET");
  const limit = clients?.[0]?.monthly_limit ?? 1000;

  // Contar mensajes del bot este mes
  const msgs = await supabaseFetch(
    `/messages?client_id=eq.${clientId}&role=eq.assistant&created_at=gte.${firstOfMonth.toISOString()}&select=id`,
    "GET"
  );
  const used = msgs?.length ?? 0;

  console.log(`[${clientId}] Mensajes usados este mes: ${used}/${limit}`);
  return { limit, used, exceeded: used >= limit };
}

// Verifica si la conversación está en modo humano
async function isHumanMode(senderId, channel) {
  const conv = await supabaseFetch(
    `/conversations?contact_id=eq.${senderId}&channel=eq.${channel}&select=human_mode&limit=1`,
    "GET"
  );
  return conv?.[0]?.human_mode === true;
}

async function upsertConversation(clientId, senderId, channel, contactName) {
  const existing = await supabaseFetch(
    `/conversations?client_id=eq.${clientId}&contact_id=eq.${senderId}&channel=eq.${channel}&limit=1`,
    "GET"
  );

  if (existing && existing.length > 0) {
    const conv = existing[0];
    await supabaseFetch(`/conversations?id=eq.${conv.id}`, "PATCH", {
      last_seen:    new Date().toISOString(),
      contact_name: contactName || conv.contact_name,
    });
    return conv.id;
  }

  const result = await supabaseFetch("/conversations", "POST", {
    client_id:    clientId,
    contact_id:   senderId,
    channel,
    contact_name: contactName || senderId,
    status:       "open",
    human_mode:   false,
    last_seen:    new Date().toISOString(),
  });

  return result?.[0]?.id || null;
}

async function saveMessage(conversationId, clientId, role, content) {
  if (!conversationId) return;
  await supabaseFetch("/messages", "POST", {
    conversation_id: conversationId,
    client_id:       clientId,
    role,
    content,
  });
  await supabaseFetch(`/conversations?id=eq.${conversationId}`, "PATCH", {
    last_message: content.slice(0, 120),
    last_seen:    new Date().toISOString(),
  });
}

async function saveLead(clientId, senderId, contactName, channel, status) {
  await supabaseFetch("/leads", "POST", {
    client_id:    clientId,
    contact_id:   senderId,
    contact_name: contactName || senderId,
    channel,
    status,
  });
}

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

async function getContactName(senderId, channel) {
  const token   = getToken(channel);
  const phoneId = process.env.WHATSAPP_PHONE_ID;
  try {
    if (channel === "instagram") {
      const res  = await fetch(`https://graph.facebook.com/v19.0/${senderId}?fields=name&access_token=${token}`);
      const data = await res.json();
      return data?.name || null;
    } else {
      const res  = await fetch(
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

async function callClaude(systemBase, catalogText, history, retries = 0) {
  try {
    const messages = [
      { role: "user",      content: `[CATALOGO ACTUALIZADO]\n${catalogText}\n[FIN CATALOGO]\n\nConfirma que recibiste el catalogo.` },
      { role: "assistant", content: "Catalogo recibido y listo para consultas." },
      ...history,
    ];
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "anthropic-beta":    "prompt-caching-2024-07-31",
      },
      body: JSON.stringify({
        model:      "claude-haiku-4-5-20251001",
        max_tokens: 400,
        system: [{ type: "text", text: systemBase, cache_control: { type: "ephemeral" } }],
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

async function sendMessage(senderId, text, channel) {
  const token   = getToken(channel);
  const phoneId = process.env.WHATSAPP_PHONE_ID;
  if (channel === "instagram") {
    const igAccountId = process.env.INSTAGRAM_ACCOUNT_ID;
    const res = await fetch(`https://graph.facebook.com/v19.0/${igAccountId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: senderId },
        message: { text },
        messaging_type: "RESPONSE",
        access_token: token,
      }),
    });
    if (!res.ok) console.error("Instagram send error:", await res.json());
  } else {
    const res = await fetch(`https://graph.facebook.com/v19.0/${phoneId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: senderId,
        type: "text",
        text: { body: text },
      }),
    });
    if (!res.ok) console.error("WhatsApp send error:", await res.json());
  }
}

// ─── HANDLER PRINCIPAL ────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { clientId, senderId, channel = "whatsapp" } = req.body;
  if (!clientId || !senderId) return res.status(400).json({ error: "Missing params" });

  try {
    const bufferKey = `buffer:${clientId}:${senderId}`;
    const buffer    = (await redis.get(bufferKey)) || [];
    await redis.del(bufferKey);

    if (buffer.length === 0) return res.status(200).json({ status: "empty buffer" });

    const messageText = buffer.map(m => m.text).join("\n");
    const msgChannel  = buffer[0]?.channel || channel;

    const historyKey  = `history:${clientId}:${senderId}`;
    const activityKey = `last_activity:${clientId}:${senderId}`;
    const nameKey     = `name:${clientId}:${senderId}`;
    const botKey      = `bot:${clientId}:${senderId}`;
    const humanKey    = `last_human:${clientId}:${senderId}`;

    const lastActivity = await redis.get(activityKey);
    if (lastActivity && Date.now() - Number(lastActivity) > INACTIVITY_RESET) {
      await redis.del(historyKey);
    }
    await redis.set(activityKey, Date.now(), { ex: HISTORY_TTL });

    let history = (await redis.get(historyKey)) || [];

    let contactName = await redis.get(nameKey);
    if (!contactName) {
      contactName = await getContactName(senderId, msgChannel);
      if (contactName) await redis.set(nameKey, contactName, { ex: 60 * 60 * 24 * 30 });
    }

    // SUPABASE: guardar conversacion y mensaje del usuario
    const conversationId = await upsertConversation(clientId, senderId, msgChannel, contactName);
    await saveMessage(conversationId, clientId, "user", messageText);

    // ── VERIFICAR MODO HUMANO ──
    const humanMode = await isHumanMode(senderId, msgChannel);
    if (humanMode) {
      console.log(`[${clientId}] Conversación en modo humano para ${senderId} — bot silenciado`);
      return res.status(200).json({ status: "human_mode" });
    }

    // ── VERIFICAR LÍMITE MENSUAL ──
    const { exceeded, used, limit } = await checkMonthlyLimit(clientId);
    if (exceeded) {
      console.log(`[${clientId}] Límite mensual alcanzado (${used}/${limit}) — bot silenciado`);
      await alertSlack(`⚠️ *${clientId}* alcanzó el límite mensual de ${limit} mensajes.`);
      return res.status(200).json({ status: "limit_exceeded" });
    }

    let systemPrompt = await redis.get(`prompt:${clientId}`);
    if (!systemPrompt) {
      await alertSlack(`⚠️ Cliente *${clientId}* no tiene prompt configurado en Redis.`);
      return res.status(200).json({ status: "no prompt" });
    }

    if (contactName) {
      systemPrompt += `\n\nCONTEXTO: El nombre del contacto es ${contactName}. Úsalo en el saludo inicial y ocasionalmente en la conversación de forma natural.`;
    } else {
      systemPrompt += `\n\nCONTEXTO: No conoces el nombre del contacto. Pregúntalo de forma natural en el primer mensaje.`;
    }

    const vertical    = await redis.hget(`config:${clientId}`, "vertical") || "muebles";
    const catalogText = await getCatalog(clientId, vertical);
    if (!catalogText) systemPrompt += "\n\nIMPORTANTE: El catalogo no esta disponible ahora.";

    history.push({ role: "user", content: messageText });
    if (history.length > MAX_HISTORY) history = history.slice(-MAX_HISTORY);

    let raw;
    try {
      raw = await callClaude(systemPrompt, catalogText || "Sin catalogo disponible.", history);
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

    // SUPABASE: guardar respuesta del bot
    await saveMessage(conversationId, clientId, "assistant", clean);

    if (event === "pedido_listo") {
      await alertSlack(`🛒 *PEDIDO LISTO* — Cliente: *${clientId}* | Contacto: ${senderId}`);
      await redis.set(botKey, false);
      await redis.set(humanKey, Date.now());
    }

    if (event === "calificado" || event === "urgente") {
      await alertSlack(`🔔 *${event.toUpperCase()}* — Cliente: *${clientId}* | Canal: ${msgChannel} | Contacto: ${senderId}`);
      await saveLead(clientId, senderId, contactName, msgChannel, event);
    }

    if (event === "descalificado") {
      await redis.del(historyKey);
      await saveLead(clientId, senderId, contactName, msgChannel, "descalificado");
    }

    if (event === "pedido_listo") {
      await saveLead(clientId, senderId, contactName, msgChannel, "pedido_listo");
    }

    await sendMessage(senderId, clean, msgChannel);
    return res.status(200).json({ status: "ok" });

  } catch (error) {
    console.error("Process error:", error);
    await alertSlack(`🚨 Error critico en process: ${error.message}`);
    return res.status(200).json({ status: "error" });
  }
}
