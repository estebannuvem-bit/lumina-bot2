import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

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
    console.error("WhatsApp reminder send error:", err);
  }
}

function formatTime(isoDate) {
  const date = new Date(isoDate);
  return date.toLocaleString("es-VE", {
    timeZone: "America/Caracas",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { clientId, phone, name, startTime, meetingUrl, closer } = req.body;

  if (!phone || !startTime) {
    return res.status(400).json({ error: "Missing params" });
  }

  try {
    const time = formatTime(startTime);
    let message = `Hola${name ? ` ${name.split(" ")[0]}` : ""}! 😊 Te recuerdo que en una hora tenemos nuestra reunión a las ${time} con ${closer}.`;
    if (meetingUrl) {
      message += ` Te dejo el link por acá: ${meetingUrl}`;
    }
    message += ` ¡Nos vemos pronto! 🙌`;

    await sendWhatsAppMessage(phone, message);
    return res.status(200).json({ status: "ok" });

  } catch (error) {
    console.error("Reminder error:", error);
    return res.status(200).json({ status: "error" });
  }
}
