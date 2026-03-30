import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

const HUMAN_TIMEOUT = 10 * 60 * 1000; // 10 minutos
const HISTORY_TTL = 60 * 60 * 24 * 3; // 3 días
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

// ─── VERIFICAR ESTADO DEL NEGOCIO ─────────────────────────────

async function checkBusinessStatus(clientId) {
  // 1. Cierre imprevisto
  const status = await redis.get(`status:${clientId}`);
  if (status === "cerrado") {
    const msg = await redis.get(`status_mensaje:${clientId}`);
    return { blocked: true, message: msg || "Hoy estamos cerrados 🙏 Mañana te atendemos." };
  }

  // 2. Cierre de un día
  const closedToday = await redis.get(`closed_today:${clientId}`);
  if (closedToday) {
    const today = new Date().toISOString().split("T")[0];
    if (closedToday === today) {
      const msg = await redis.get(`closed_today_msg:${clientId}`);
      return { blocked: true, message: msg || "Hoy cerramos antes 🙏 Mañana seguimos." };
    }
  }

  // 3. Modo vacaciones
  const vacStart = await redis.get(`vacation:${clientId}:start`);
  const vacEnd = await redis.get(`vacation:${clientId}:end`);
  if (vacStart && vacEnd) {
    const now = new Date().toISOString().split("T")[0];
    if (now >= vacStart && now <= vacEnd) {
      const msg = await redis.get(`vacation:${clientId}:mensaje`);
      return { blocked: true, message: msg || "Estamos de vacaciones 🌴 Volvemos pronto." };
    }
  }

  // 4. Horario normal
  const schedule = await redis.get(`schedule:${clientId}`);
  if (schedule) {
    const { days, open, close, timezone, offMessage } = schedule;
    const now = new Date().toLocaleString("en-US", { timeZone: timezone || "America/Argentina/Buenos_Aires" });
    const date = new Date(now);
    const day = date.getDay();
    const hour = date.getHours() + date.getMinutes() / 60;
    const [openH, openM] = open.split(":").map(Number);
    const [closeH, closeM] = close.split(":").map(Number);
    const openDecimal = openH + openM / 60;
    const closeDecimal = closeH + closeM / 60;
    const isWorkDay = days.includes(day);
    const isWorkHour = hour >= openDecimal && hour < closeDecimal;
    if (!isWorkDay || !isWorkHour) {
      return {
        blocked: false,
        offHours: true,
        message: offMessage || `Estamos fuera de horario (atendemos ${days.length === 5 ? "lunes a viernes" : "según nuestro horario"} de ${open} a ${close}hs) 👌 pero contame, ¿en qué te puedo ayudar?`,
      };
    }
  }

  return { blocked: false, offHours: false };
}

// ─── HANDLER PRINCIPAL ────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Obtener clientId desde query param: /api/manychat?client=nuvem
  const clientId = req.query.client;
  if (!clientId) {
    return res.status(400).json({ error: "Missing client param" });
  }

  const { contact_id, last_input_text, human_intervention } = req.body;

  if (!contact_id || !last_input_text || last_input_text.length < 2) {
    return res.status(200).json({ version: "v2", content: { messages: [] } });
  }

  try {
    const botKey = `bot:${clientId}:${contact_id}`;
    const humanKey = `last_human:${clientId}:${contact_id}`;

    // Humano interviene → pausar bot
    if (human_intervention === true) {
      await redis.set(botKey, false);
      await redis.set(humanKey, Date.now());
      return res.status(200).json({ version: "v2", content: { messages: [] } });
    }

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
      return res.status(200).json({ version: "v2", content: { messages: [] } });
    }

    // Verificar estado del negocio
    const bizStatus = await checkBusinessStatus(clientId);
    if (bizStatus.blocked) {
      return res.status(200).json({
        version: "v2",
        content: { messages: [{ type: "text", text: bizStatus.message }] },
      });
    }

    // Contador de mensajes
    const historyKey = `history:${clientId}:${contact_id}`;
    const countKey = `count:${clientId}:${contact_id}`;
    let history = (await redis.get(historyKey)) || [];
    let botMessageCount = (await redis.get(countKey)) || 0;

    if (botMessageCount >= MAX_BOT_MESSAGES) {
      return res.status(200).json({ version: "v2", content: { messages: [] } });
    }

    // Obtener prompt del cliente desde Redis
    let systemPrompt = await redis.get(`prompt:${clientId}`);
    if (!systemPrompt) {
      await alertSlack(`⚠️ Cliente *${clientId}* no tiene prompt configurado en Redis.`);
      return res.status(200).json({ version: "v2", content: { messages: [] } });
    }

    // Si está fuera de horario, agregar contexto al prompt
    if (bizStatus.offHours) {
      systemPrompt += `\n\nCONTEXTO: Estás fuera del horario de atención. Informá amablemente el horario pero seguí la conversación para no perder el lead.`;
    }

    history.push({ role: "user", content: last_input_text });
    if (history.length > MAX_HISTORY) {
      history = history.slice(-MAX_HISTORY);
    }

    // Llamar a Claude con reintentos
    let raw;
    try {
      raw = await callClaude(systemPrompt, history);
      if (!raw) throw new Error("Empty response");
    } catch (err) {
      console.error("Claude failed after retries:", err);
      await alertSlack(`🚨 Claude falló 3 veces para cliente *${clientId}*, contacto *${contact_id}*.\nMensaje: "${last_input_text}"`);
      return res.status(200).json({
        version: "v2",
        content: {
          messages: [{ type: "text", text: "perdoná, tuve un problema técnico 😅 escribime en unos minutos" }],
        },
      });
    }

    const { clean, event } = parseEvents(raw);

    history.push({ role: "assistant", content: clean });
    botMessageCount += 1;

    await redis.set(historyKey, history, { ex: HISTORY_TTL });
    await redis.set(countKey, botMessageCount, { ex: HISTORY_TTL });

    // Limpiar si la conversación terminó
    if (event === "calificado" || event === "urgente" || event === "descalificado") {
      await redis.del(historyKey);
      await redis.del(countKey);
    }

    const response = {
      version: "v2",
      content: {
        messages: [{ type: "text", text: clean }],
        actions: [],
        quick_replies: [],
      },
    };

    if (event) {
      response.content.actions.push({
        action: "set_field_value",
        field_name: "lead_status",
        value: event,
      });
    }

    return res.status(200).json(response);
  } catch (error) {
    console.error("Handler error:", error);
    await alertSlack(`🚨 Error crítico en webhook para cliente *${clientId}*: ${error.message}`);
    return res.status(500).json({ error: "Internal server error" });
  }
}
