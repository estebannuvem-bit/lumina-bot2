// api/send-panel.js
import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function saveMessageToSupabase(clientId, senderId, role, content) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  try {
    const convRes = await fetch(
      `${SUPABASE_URL}/rest/v1/conversations?client_id=eq.${clientId}&contact_id=eq.${senderId}&channel=eq.whatsapp&limit=1`,
      { headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` } }
    );
    const convData = await convRes.json();
    const conversationId = convData?.[0]?.id;
    if (!conversationId) return;

    await fetch(`${SUPABASE_URL}/rest/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "apikey":         SUPABASE_KEY,
        "Authorization": `Bearer ${SUPABASE_KEY}`,
        "Prefer":        "return=minimal",
      },
      body: JSON.stringify({
        conversation_id: conversationId,
        client_id:       clientId,
        role,
        content,
        type: "text",
      }),
    });

    await fetch(`${SUPABASE_URL}/rest/v1/conversations?id=eq.${conversationId}`, {
      method: "PATCH",
      headers: {
        "Content-Type":  "application/json",
        "apikey":         SUPABASE_KEY,
        "Authorization": `Bearer ${SUPABASE_KEY}`,
      },
      body: JSON.stringify({
        last_message: content.slice(0, 120),
        last_seen:    new Date().toISOString(),
      }),
    });
  } catch (e) {
    console.error("Supabase save error:", e);
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { to, message, channel = "whatsapp", clientId } = req.body;

  if (!to || !message || !clientId) {
    return res.status(400).json({ error: "Missing params: to, message, clientId required" });
  }

  try {
    const waToken   = await redis.get(`config:${clientId}:wa_token`)      || process.env.META_PAGE_ACCESS_TOKEN;
    const waPhoneId = await redis.get(`config:${clientId}:wa_phone_id`)   || process.env.WHATSAPP_PHONE_ID;
    const igToken   = await redis.get(`config:${clientId}:ig_token`)      || process.env.INSTAGRAM_ACCESS_TOKEN;
    const igAccId   = await redis.get(`config:${clientId}:ig_account_id`) || process.env.INSTAGRAM_ACCOUNT_ID;

    console.log(`[${clientId}] Send to: ${to} via ${channel}`);
    console.log(`[${clientId}] phoneId: ${waPhoneId}, token starts: ${waToken?.slice(0, 20)}`);

    let sendRes;

    if (channel === "whatsapp") {
      if (!waToken || !waPhoneId) {
        console.error(`[${clientId}] Missing WhatsApp credentials`);
        return res.status(400).json({ error: "WhatsApp credentials not configured for this client" });
      }

      sendRes = await fetch(`https://graph.facebook.com/v19.0/${waPhoneId}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${waToken}`,
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to,
          type: "text",
          text: { body: message },
        }),
      });

    } else if (channel === "instagram") {
      if (!igToken || !igAccId) {
        return res.status(400).json({ error: "Instagram credentials not configured for this client" });
      }

      sendRes = await fetch(`https://graph.facebook.com/v19.0/${igAccId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipient: { id: to },
          message: { text: message },
          messaging_type: "RESPONSE",
          access_token: igToken,
        }),
      });

    } else {
      return res.status(400).json({ error: "Channel not supported" });
    }

    const data = await sendRes.json();
    console.log(`[${clientId}] WhatsApp API response:`, JSON.stringify(data));

    if (!sendRes.ok) {
      console.error(`[${clientId}] Send failed:`, JSON.stringify(data));
      return res.status(400).json({ error: data });
    }

    await saveMessageToSupabase(clientId, to, "human", message);

    console.log(`[${clientId}] Panel message sent successfully to ${to}`);
    return res.status(200).json({ status: "sent", messageId: data.messages?.[0]?.id });

  } catch (error) {
    console.error("Send panel error:", error);
    return res.status(500).json({ error: error.message });
  }
}
