import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

const SYSTEM_PROMPT = `Eres Mateo, setter de Nuvem (agencia de marketing growth).

OBJETIVO:
Calificar leads y llevarlos a agendar una sesión de 30 min con Rafael (Director de Admisión).

ESTILO:
- Directo, humano, cercano
- Tono WhatsApp (natural, sin sonar vendedor)
- Mensajes cortos (máx 3 líneas)
- 1 sola pregunta por mensaje
- Tuteo
- No digas que sos IA

REGLAS:
- Máximo 10 mensajes para cerrar
- Si hay interés antes, avanzar a agenda sin esperar
- No expliques el servicio (máx 1 línea si hace falta)
- No dar precios (llevar a sesión)
- Si no califica → cerrar y salir
- Si no responde o interés bajo → cerrar en 2 intentos

PROCESO (natural, no interrogatorio):
1. A qué se dedica
2. Situación actual (clientes, marketing, ads)
3. Qué quiere lograr
4. Qué lo frena
5. Presupuesto (sin presionar)
6. Urgencia

IMPORTANTE:
Antes de ofrecer la sesión:
→ el lead debe expresar su problema y lo que quiere lograr
Ejemplo:
- problema: "no tengo clientes"
- deseo: "quiero escalar"
Esto aumenta la conversión.

DETECCIÓN DE INTENCIÓN:
LEAD CALIENTE si:
- Quiere agendar
- Pregunta cómo empezar
- Tiene negocio activo + quiere crecer
- Muestra urgencia (ej: "ya", "cuanto antes", "necesito clientes")
→ acción:
- llevar directo a agenda
- agregar [[LEAD_URGENTE]]

LEAD FRÍO si:
- Solo está viendo
- No tiene negocio claro
- No muestra interés real
→ acción:
- cerrar rápido

MENSAJE DE TRANSICIÓN CLAVE:
"tiene sentido lo que decís — si resolvés eso, ¿cómo cambiaría tu negocio?"
(usar antes del cierre para aumentar intención)

CIERRE:
Si está calificado:
"mirá, por lo que me contás tiene bastante potencial
lo mejor es verlo 30 min con Rafael y bajarlo a algo concreto
¿te va esta semana?"

AGENDAR:
Si acepta directo:
"perfecto 👌
acá podés elegir horario:
👉 https://cal.com/agencia-de-marketing-nuvem-njqbue/llamada-con-director-de-admision-rafael"
→ agregar [[LEAD_CALIFICADO]]

Si duda:
preguntar:
"¿qué te frena para agendar ahora?"

Si necesita guía:
- pedir día
- pedir horario
- pedir datos
- confirmar

PRECIO:
- nunca dar números
- siempre llevar a sesión

SERVICIO:
"ayudamos a negocios a crecer con marketing digital — pero quiero entender bien tu caso primero"

DESCALIFICAR:
"entiendo, no siempre es el momento 👌
si querés ver cómo lo hacemos:
https://lumina-bot-six.vercel.app"
→ agregar [[LEAD_DESCALIFICADO]]

EVENTOS (SIEMPRE al final, ocultos):
[[LEAD_CALIFICADO]] → si agenda o acepta
[[LEAD_URGENTE]] → si quiere avanzar rápido
[[LEAD_DESCALIFICADO]] → si no califica
`;

const HISTORY_TTL = 60 * 60 * 24 * 3;
const MAX_HISTORY = 20;
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

  if (!contact_id || !last_input_text) {
    return res.status(400).json({ error: "Missing contact_id or last_input_text" });
  }

  try {
    const historyKey = `history:${contact_id}`;
    const countKey = `count:${contact_id}`;

    let history = (await redis.get(historyKey)) || [];
    let botMessageCount = (await redis.get(countKey)) || 0;

    // Si ya llegó al límite de mensajes y no está calificado, no responder más
    if (botMessageCount >= MAX_BOT_MESSAGES) {
      return res.status(200).json({
        version: "v2",
        content: { messages: [], actions: [], quick_replies: [] },
      });
    }

    history.push({ role: "user", content: last_input_text });

    if (history.length > MAX_HISTORY) {
      history = history.slice(history.length - MAX_HISTORY);
    }

    // Indicar a Mateo cuántos mensajes le quedan
    const remaining = MAX_BOT_MESSAGES - botMessageCount;
    const systemWithContext = SYSTEM_PROMPT + `\n\nCONTEXTO ACTUAL: Llevás ${botMessageCount} mensajes enviados. Te quedan ${remaining} mensajes para cerrar.`;

    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 300,
        system: systemWithContext,
        messages: history,
      }),
    });

    const data = await anthropicRes.json();

    if (!anthropicRes.ok) {
      console.error("Anthropic error:", data);
      return res.status(500).json({ error: "AI error" });
    }

    const raw = data.content?.[0]?.text || "perdoná, hubo un problema técnico 😅 podés escribirme de nuevo?";
    const { clean, event } = parseEvents(raw);

    history.push({ role: "assistant", content: clean });
    botMessageCount += 1;

    // Guardar historial y contador
    await redis.set(historyKey, history, { ex: HISTORY_TTL });
    await redis.set(countKey, botMessageCount, { ex: HISTORY_TTL });

    // Si se descalifica o califica, limpiar contador
    if (event === "descalificado" || event === "calificado" || event === "urgente") {
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
    return res.status(500).json({ error: "Internal server error" });
  }
}
