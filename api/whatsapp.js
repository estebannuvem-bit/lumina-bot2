import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

const HUMAN_TIMEOUT    = 10 * 60 * 1000;
const HISTORY_TTL      = 60 * 60 * 24 * 3;
const DEBOUNCE_SECONDS = 15;

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
    body: JSON.stringify({ clientId, senderId }),
  });

  const data = await qstashRes.json();
  if (data.messageId) {
    await redis.set(`qstash_job:${clientId}:${senderId}`, data.messageId, { ex: 30 });
  }
}

// ─── OBTENER URL DE IMAGEN DESDE META ─────────────────────────

async function getMediaUrl(mediaId) {
  const token = process.env.META_PAGE_ACCESS_TOKEN;
  try {
    const res  = await fetch(`https://graph.facebook.com/v19.0/${mediaId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    return data?.url || null;
  } catch (e) {
    console.error("Error getting media URL:", e);
    return null;
  }
}

// ─── GUARDAR MENSAJE EN SUPABASE ──────────────────────────────

async function saveMessageToSupabase(clientId, senderId, conversationId, role, content, type = 'text', mediaUrl = null) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) return;

  try {
    await fetch(`${supabaseUrl}/rest/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "apikey":         supabaseKey,
        "Authorization": `Bearer ${supabaseKey}`,
        "Prefer":        "return=minimal",
      },
      body: JSON.stringify({
        conversation_id: conversationId,
        client_id:       clientId,
        role,
        content,
        type,
        media_url: mediaUrl,
      }),
    });

    // Actualizar ultimo mensaje
    await fetch(`${supabaseUrl}/rest/v1/conversations?id=eq.${conversationId}`, {
      method: "PATCH",
      headers: {
        "Content-Type":  "application/json",
        "apikey":         supabaseKey,
        "Authorization": `Bearer ${supabaseKey}`,
      },
      body: JSON.stringify({
        last_message: type === 'image' ? '📷 Imagen' : content.slice(0, 120),
        last_seen:    new Date().toISOString(),
      }),
    });
  } catch (e) {
    console.error("Supabase save error:", e);
  }
}

// ─── OBTENER O CREAR CONVERSACION EN SUPABASE ─────────────────

async function upsertConversation(clientId, senderId, contactName) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) return null;

  try {
    const existing = await fetch(
      `${supabaseUrl}/rest/v1/conversations?client_id=eq.${clientId}&contact_id=eq.${senderId}&channel=eq.whatsapp&limit=1`,
      { headers: { "apikey": supabaseKey, "Authorization": `Bearer ${supabaseKey}` } }
    );
    const data = await existing.json();

    if (data?.length > 0) {
      await fetch(`${supabaseUrl}/rest/v1/conversations?id=eq.${data[0].id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "apikey": supabaseKey, "Authorization": `Bearer ${supabaseKey}` },
        body: JSON.stringify({ last_seen: new Date().toISOString(), contact_name: contactName || data[0].contact_name }),
      });
      return data[0].id;
    }

    const created = await fetch(`${supabaseUrl}/rest/v1/conversations`, {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "apikey":         supabaseKey,
        "Authorization": `Bearer ${supabaseKey}`,
        "Prefer":        "return=representation",
      },
      body: JSON.stringify({
        client_id:    clientId,
        contact_id:   senderId,
        channel:      "whatsapp",
        contact_name: contactName || senderId,
        status:       "open",
        last_seen:    new Date().toISOString(),
      }),
    });
    const newConv = await created.json();
    return newConv?.[0]?.id || null;
  } catch (e) {
    console.error("Supabase upsert error:", e);
    return null;
  }
}

async function sendWhatsAppMessage(to, text) {
  const token   = process.env.META_PAGE_ACCESS_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_ID;

  const res = await fetch(`https://graph.facebook.com/v19.0/${phoneId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
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

    const senderId    = message.from;
    const messageType = message.type;

    if (!senderId) return res.status(200).json({ status: "invalid message" });

    // Deduplicacion
    const dedupKey = `dedup:${message.id}`;
    const alreadyProcessed = await redis.get(dedupKey);
    if (alreadyProcessed) return res.status(200).json({ status: "duplicate" });
    await redis.set(dedupKey, true, { ex: 60 });

    const botKey   = `bot:${clientId}:${senderId}`;
    const humanKey = `last_human:${clientId}:${senderId}`;

    const lastHuman = await redis.get(humanKey);
    if (lastHuman && Date.now() - Number(lastHuman) > HUMAN_TIMEOUT) {
      await redis.set(botKey, true);
      await redis.del(humanKey);
    }

    const botActive = await redis.get(botKey);
    if (botActive === false) return res.status(200).json({ status: "bot paused" });

    // Obtener nombre del contacto desde Redis
    const nameKey    = `name:${clientId}:${senderId}`;
    const contactName = await redis.get(nameKey);

    // Obtener o crear conversacion en Supabase
    const conversationId = await upsertConversation(clientId, senderId, contactName);

    // ── IMAGEN ───────────────────────────────────────────────
    if (messageType === "image") {
      const mediaId  = message.image?.id;
      const caption  = message.image?.caption || "";
      const mediaUrl = mediaId ? await getMediaUrl(mediaId) : null;

      console.log(`Image received from ${senderId}, mediaId: ${mediaId}, url: ${mediaUrl}`);

      // Guardar en Supabase con type=image y la URL
      if (conversationId) {
        await saveMessageToSupabase(
          clientId, senderId, conversationId,
          "user",
          caption || "📷 Imagen",
          "image",
          mediaUrl
        );
      }

      // Si tiene caption, procesarlo como texto también
      if (caption) {
        const bufferKey = `buffer:${clientId}:${senderId}`;
        const buffer    = (await redis.get(bufferKey)) || [];
        buffer.push({ text: `[El usuario envió una imagen con el mensaje: "${caption}"]`, ts: Date.now() });
        await redis.set(bufferKey, buffer, { ex: 30 });
        await scheduleProcessing(clientId, senderId);
      }

      return res.status(200).json({ status: "image saved" });
    }

    // ── TEXTO ────────────────────────────────────────────────
    if (messageType === "text") {
      const messageText = message.text?.body;
      if (!messageText) return res.status(200).json({ status: "empty text" });

      // Guardar en Supabase
      if (conversationId) {
        await saveMessageToSupabase(clientId, senderId, conversationId, "user", messageText, "text", null);
      }

      // Acumular en buffer para Claude
      const bufferKey = `buffer:${clientId}:${senderId}`;
      const buffer    = (await redis.get(bufferKey)) || [];
      buffer.push({ text: messageText, ts: Date.now() });
      await redis.set(bufferKey, buffer, { ex: 30 });

      await scheduleProcessing(clientId, senderId);
      return res.status(200).json({ status: "queued" });
    }

    // Otros tipos (audio, video, documento, etc.)
    console.log(`Message type ${messageType} from ${senderId} — not handled`);
    return res.status(200).json({ status: `${messageType} not handled` });

  } catch (error) {
    console.error("Handler error:", error);
    await alertSlack(`🚨 Error critico en whatsapp webhook: ${error.message}`);
    return res.status(200).json({ status: "error" });
  }
}
