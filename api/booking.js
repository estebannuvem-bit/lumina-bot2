import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

// ─── UTILIDADES ───────────────────────────────────────────────

async function alertSlack(message, channel) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: message, channel }),
    });
  } catch (e) {
    console.error("Slack alert failed:", e);
  }
}

async function sendWhatsAppMessage(to, text) {
  const token   = process.env.META_PAGE_ACCESS_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_ID;

  const phone = to.replace(/\D/g, "");

  const res = await fetch(`https://graph.facebook.com/v19.0/${phoneId}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: phone,
      type: "text",
      text: { body: text },
    }),
  });

  if (!res.ok) {
    const err = await res.json();
    console.error("WhatsApp booking send error:", err);
  }
}

function formatDate(isoDate) {
  const date = new Date(isoDate);
  return date.toLocaleString("es-VE", {
    timeZone: "America/Caracas",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function extractPhone(payload) {
  // Buscar en campos personalizados
  const responses = payload?.responses || {};
  for (const key of Object.keys(responses)) {
    const label = key.toLowerCase();
    if (label.includes("telefono") || label.includes("teléfono") || label.includes("phone") || label.includes("whatsapp")) {
      const val = responses[key]?.value;
      if (val) return String(val).replace(/\D/g, "");
    }
  }
  // Fallback — buscar en attendees
  const attendee = payload?.attendees?.[0];
  if (attendee?.phone) return String(attendee.phone).replace(/\D/g, "");
  return null;
}

// ─── HANDLER PRINCIPAL ────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const clientId = req.query.client || "nuvem";

  try {
    const { triggerEvent, payload } = req.body;

    if (triggerEvent !== "BOOKING_CREATED") {
      return res.status(200).json({ status: "ignored" });
    }

    const attendee   = payload?.attendees?.[0];
    const name       = attendee?.name || "Cliente";
    const phone      = extractPhone(payload);
    const startTime  = payload?.startTime;
    const meetingUrl = payload?.videoCallData?.url || payload?.metadata?.videoCallUrl || null;
    const closer     = payload?.organizer?.name || "nuestro equipo";
    const formattedDate = startTime ? formatDate(startTime) : "la fecha acordada";

    if (!phone) {
      console.error("No phone found in booking payload");
      await alertSlack(`⚠️ Reserva sin teléfono — ${name} agendó pero no encontramos su número`, "#alerts-criticos");
      return res.status(200).json({ status: "no phone" });
    }

    // Guardar reserva en Redis
    const bookingKey = `booking:${clientId}:${phone}`;
    await redis.set(bookingKey, {
      name,
      phone,
      startTime,
      meetingUrl,
      closer,
      status: "confirmed",
      createdAt: Date.now(),
    }, { ex: 60 * 60 * 24 * 7 }); // 7 días

    // Armar mensaje de confirmación al cliente
    let message = `¡Tu reunión está confirmada! 🙌\n📅 ${formattedDate}\n👤 Tu sesión será con ${closer}`;
    if (meetingUrl) {
      message += `\n🔗 ${meetingUrl}`;
    }
    message += `\n\nSi necesitás reprogramar o cancelar escribinos por acá 😊`;

    // Enviar confirmación por WhatsApp
    await sendWhatsAppMessage(phone, message);

    // Notificar a Slack
    await alertSlack(
      `📅 *NUEVA REUNIÓN AGENDADA*\n👤 Cliente: ${name} | ${phone}\n🕐 ${formattedDate}\n👔 Closer: ${closer}${meetingUrl ? `\n🔗 ${meetingUrl}` : ""}`,
      "#pedidos-" + clientId
    );

    // Programar recordatorio 1 hora antes con QStash
    if (startTime) {
      const token     = process.env.QSTASH_TOKEN;
      const qstashUrl = process.env.QSTASH_URL || "https://qstash.upstash.io";
      const siteUrl   = process.env.SITE_URL;
      const reminderTime = new Date(startTime).getTime() - 60 * 60 * 1000; // 1 hora antes
      const delaySeconds = Math.max(0, Math.floor((reminderTime - Date.now()) / 1000));

      if (delaySeconds > 0) {
        await fetch(`${qstashUrl}/v2/publish/${siteUrl}/api/reminder`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "Upstash-Delay": `${delaySeconds}s`,
          },
          body: JSON.stringify({ clientId, phone, name, startTime, meetingUrl, closer }),
        });
      }
    }

    return res.status(200).json({ status: "ok" });

  } catch (error) {
    console.error("Booking handler error:", error);
    await alertSlack(`🚨 Error en booking webhook: ${error.message}`, "#alerts-criticos");
    return res.status(200).json({ status: "error" });
  }
}
