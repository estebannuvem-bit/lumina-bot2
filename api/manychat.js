import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

const SYSTEM_PROMPT = `Eres Mateo, setter de Nuvem (agencia de marketing growth).

OBJETIVO:
Calificar leads y llevarlos a agendar una sesión de 30 min con Rafael.

ESTILO:
- Directo, humano, cercano
- Mensajes cortos (máx 3 líneas)
- 1 sola pregunta por mensaje
- Tuteo
- No digas que sos IA

REGLAS:
- Máximo 10 mensajes para cerrar
- Si hay interés antes, avanzar a agenda
- No expliques el servicio
- No dar precios
- Si no califica → cerrar

PROCESO:
1. A qué se dedica
2. Situación actual
3. Qué quiere lograr
4. Qué lo frena
5. Presupuesto
6. Urgencia

DETECCIÓN:
- Lead caliente → [[LEAD_URGENTE]]
- Lead calificado → [[LEAD_CALIFICADO]]
- No califica → [[LEAD_DESCALIFICADO]]`;

const HISTORY_TTL = 60 * 60 * 24 * 3;
const MAX_HISTORY = 10;
const MAX_BOT_MESSAGES = 10;

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

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { contact_id, last_input_text } = req.body;

  if (!contact_id || !last_input_text || last_input_text.length < 2) {
    return res.status(200).json({ content: { messages: [] } });
  }

  try {
    const botActive = await redis.get(`bot:${contact_id}`);

    if (botActive === false) {
      return res.status(200).json({
        version: "v2",
        content: { messages: [] },
      });
    }

    const historyKey = `history:${contact_id}`;
    const countKey = `count:${contact_id}`;

    let history = (await redis.get(historyKey)) || [];
    let botMessageCount = (await redis.get(countKey)) || 0;

    if (botMessageCount >= MAX_BOT_MESSAGES) {
      return res.status(200).json({
        version: "v2",
        content: { messages: [] },
      });
    }

    history.push({ role: "user", content: last_input_text });

    if (history.length > MAX_HISTORY) {
      history = history.slice(-MAX_HISTORY);
    }

    const model = botMessageCount > 5
      ? "claude-sonnet-4-20250514"
      : "claude-3-haiku";

    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 200,
        temperature: 0.7,
        system: SYSTEM_PROMPT,
        messages: history,
      }),
    });

    const data = await anthropicRes.json();

    if (!anthropicRes.ok) {
      console.error("Anthropic error:", data);
      return res.status(500).json({ error: "AI error" });
    }

    const raw = data.content?.[0]?.text || "Error";
    const { clean, event } = parseEvents(raw);

    history.push({ role: "assistant", content: clean });
    botMessageCount += 1;

    await redis.set(historyKey, history, { ex: HISTORY_TTL });
    await redis.set(countKey, botMessageCount, { ex: HISTORY_TTL });

    if (event === "urgente") {
      await redis.set(`bot:${contact_id}`, false);
    }

    if (event === "descalificado" || event === "calificado") {
      await redis.del(historyKey);
      await redis.del(countKey);
    }

    const response = {
      version: "v2",
      content: {
        messages: [{ type: "text", text: clean }],
      },
    };

    if (event) {
      response.content.actions = [
        {
          action: "set_field_value",
          field_name: "lead_status",
          value: event,
        },
      ];
    }

    return res.status(200).json(response);
  } catch (error) {
    console.error("Handler error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}
