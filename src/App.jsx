import { useState, useEffect, useRef } from "react";

const SYSTEM_PROMPT = `Eres "Sofi", asesora de ventas de la Clínica Estética Lumina. Estás respondiendo mensajes de personas que preguntaron por tratamientos estéticos a través de Instagram o WhatsApp.

TU PERSONALIDAD:
- Eres cálida, real y directa. Nada de frases corporativas.
- Escribes como una persona real en WhatsApp: oraciones cortas, algún emoji ocasional (no exageres), sin signos de puntuación perfectos.
- Nunca digas que eres una IA o bot. Si te preguntan si eres humana, decí que sí, sos asesora.
- Tuteá siempre.

TU OBJETIVO:
Calificar al lead de forma natural y, cuando sea el momento correcto, proponer una consulta gratuita o conectarlos con una especialista.

CÓMO CALIFICAR (sin que parezca un formulario):
- Entender qué tratamiento busca (puede mencionarlo suelto en la conversación)
- Entender urgencia: ¿está buscando algo para ya o está explorando?
- Si muestra interés real, proponé agendar una consulta gratis

REGLAS CRÍTICAS — seguirlas siempre, sin excepción:
1. NUNCA hagas más de UNA pregunta por mensaje. Si tenés varias, elegí la más importante.
2. Tus mensajes deben ser cortos: máximo 2-3 líneas.
3. No empieces NUNCA con "¡Hola!" si ya hay conversación en curso.
4. Si el lead es frío o no quiere avanzar, no insistas. Ofrecé info y dejalo en paz.
5. No uses signos de exclamación en exceso. Suena forzado.
6. Si no sabés el precio exacto de un tratamiento, no lo inventes. Decí que te lo confirman y ofrecé la consulta gratuita.
7. La dirección, horarios y datos de contacto solo los compartís si el lead los pide o si ya está listo para agendar.

SEÑALES DE EVENTOS (agregarlas al final de tu mensaje, el lead no las verá):
- Cuando el lead confirme que quiere la consulta gratuita → agregá al final: [[LEAD_CALIFICADO]]
- Cuando el lead diga que quiere comprar ya, pida precio urgente, o quiera hablar con alguien de inmediato → agregá al final: [[LEAD_URGENTE]]

INFORMACIÓN DE LA CLÍNICA:
- Nombre: Clínica Estética Lumina
- Dirección: Av. Santa Fe 2847, piso 3, Palermo, CABA (entre Coronel Díaz y Larrea)
- Horarios: lunes a viernes de 9 a 20hs, sábados de 9 a 14hs
- Teléfono / WhatsApp: +54 9 11 4823-7760
- Instagram: @clinicalumina
- Estacionamiento: no propio, pero hay cocheras en Coronel Díaz 1190 a media cuadra
- Cómo llegar: subte línea D estación Bulnes, a 3 cuadras
- Tratamientos principales: botox y toxina botulínica, rellenos con ácido hialurónico, lifting sin cirugía con hilos tensores, laser fraccionado CO2 para manchas y poros, hidratación profunda con skinbooster, mesoterapia facial y corporal, reducción de papada con lipolíticos
- Precios orientativos: botox desde $180.000, rellenos desde $250.000, consulta inicial sin cargo
- Especialistas: Dra. Valentina Rossi (médica estética, 12 años de experiencia), Lic. Camila Torres (cosmiatra especialista en láser)
- Financiación: hasta 12 cuotas sin interés con tarjetas Visa y Mastercard

Ejemplos de cómo hablás:
- "qué tratamiento te interesa más? 😊"
- "ah perfecto, tenemos varias opciones para eso, te cuento"
- "cuándo más o menos lo querrías hacer?"
- "mirá, si querés te puedo pasar con una de nuestras especialistas para una consulta sin costo"`;

const INITIAL_MESSAGE = {
  role: "assistant",
  content: "Hola! vi que preguntaste por nuestros tratamientos 😊 en qué te puedo ayudar?",
};

function parseResponse(text) {
  let clean = text;
  let event = null;
  if (text.includes("[[LEAD_CALIFICADO]]")) {
    clean = text.replace("[[LEAD_CALIFICADO]]", "").trim();
    event = "calificado";
  } else if (text.includes("[[LEAD_URGENTE]]")) {
    clean = text.replace("[[LEAD_URGENTE]]", "").trim();
    event = "urgente";
  }
  return { clean, event };
}

function formatTime() {
  return new Date().toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
}

export default function App() {
  const [messages, setMessages] = useState([{ ...INITIAL_MESSAGE, time: formatTime(), id: 0 }]);
  const [history, setHistory] = useState([INITIAL_MESSAGE]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [channel, setChannel] = useState("whatsapp");
  const [notification, setNotification] = useState(null);
  const [leadName, setLeadName] = useState("Lead");
  const bottomRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  const sendMessage = async () => {
    const text = input.trim();
    if (!text || loading) return;

    if (messages.filter((m) => m.role === "user").length === 0) {
      const nameMatch = text.match(/(?:soy|me llamo|mi nombre es)\s+([A-ZÁÉÍÓÚa-záéíóú][a-záéíóú]+)/i);
      if (nameMatch) setLeadName(nameMatch[1]);
    }

    const userMsg = { role: "user", content: text, time: formatTime(), id: Date.now() };
    const newHistory = [...history, { role: "user", content: text }];

    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setLoading(true);

    try {
      // Llama al backend propio — la API key nunca sale del servidor
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system: SYSTEM_PROMPT,
          messages: newHistory,
        }),
      });

      const data = await res.json();
      const raw = data.content?.[0]?.text || "perdón, hubo un problema 😅 podés escribirme de nuevo?";
      const { clean, event } = parseResponse(raw);

      const assistantMsg = {
        role: "assistant",
        content: clean,
        time: formatTime(),
        id: Date.now() + 1,
      };

      setMessages((prev) => [...prev, assistantMsg]);
      setHistory([...newHistory, { role: "assistant", content: clean }]);

      if (event === "calificado") {
        setTimeout(() => setNotification("calificado"), 800);
      } else if (event === "urgente") {
        setTimeout(() => setNotification("urgente"), 800);
      }
    } catch (e) {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: "uy, algo falló por mi lado 😅 escribime de nuevo",
          time: formatTime(),
          id: Date.now() + 1,
        },
      ]);
    }

    setLoading(false);
    inputRef.current?.focus();
  };

  const handleKey = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const reset = () => {
    setMessages([{ ...INITIAL_MESSAGE, time: formatTime(), id: 0 }]);
    setHistory([INITIAL_MESSAGE]);
    setInput("");
    setNotification(null);
    setLeadName("Lead");
    inputRef.current?.focus();
  };

  const isWA = channel === "whatsapp";

  return (
    <div
      style={{
        background: isWA
          ? "linear-gradient(135deg, #0a1014 0%, #111b21 100%)"
          : "linear-gradient(135deg, #000 0%, #0d0d0d 100%)",
        fontFamily: "'SF Pro Text', -apple-system, BlinkMacSystemFont, sans-serif",
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "16px",
      }}
    >
      <div style={{ textAlign: "center", marginBottom: 16 }}>
        <div style={{ color: "white", fontWeight: 700, fontSize: 17 }}>Simulador de Bot</div>
        <div style={{ color: "#8899aa", fontSize: 12, marginTop: 2 }}>
          Nuvem · Prototipo conversacional con IA
        </div>
        <div
          style={{
            display: "inline-flex",
            marginTop: 12,
            background: "#1a1a1a",
            borderRadius: 12,
            padding: 3,
            gap: 3,
            border: "1px solid #333",
          }}
        >
          {["whatsapp", "instagram"].map((ch) => (
            <button
              key={ch}
              onClick={() => { setChannel(ch); reset(); }}
              style={{
                padding: "6px 16px",
                borderRadius: 9,
                fontSize: 12,
                fontWeight: 600,
                border: "none",
                cursor: "pointer",
                transition: "all 0.2s",
                background: channel === ch ? "white" : "transparent",
                color: channel === ch ? "#000" : "#666",
              }}
            >
              {ch === "whatsapp" ? "💬 WhatsApp" : "📸 Instagram"}
            </button>
          ))}
        </div>
      </div>

      <div
        style={{
          width: "100%",
          maxWidth: 400,
          borderRadius: 24,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          height: 580,
          boxShadow: "0 30px 80px rgba(0,0,0,0.6)",
          border: "1px solid rgba(255,255,255,0.08)",
        }}
      >
        {/* Header */}
        <div
          style={{
            background: isWA ? "#1f2c33" : "#1a1a1a",
            padding: "12px 16px",
            display: "flex",
            alignItems: "center",
            gap: 10,
            borderBottom: `1px solid ${isWA ? "#2a3942" : "#2a2a2a"}`,
            flexShrink: 0,
          }}
        >
          <div
            style={{
              width: 38,
              height: 38,
              borderRadius: "50%",
              background: isWA
                ? "linear-gradient(135deg, #25d366, #128c7e)"
                : "linear-gradient(135deg, #f09433, #bc1888)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 18,
              flexShrink: 0,
            }}
          >
            ✨
          </div>
          <div>
            <div style={{ color: "white", fontWeight: 600, fontSize: 15 }}>Sofi · Lumina</div>
            <div style={{ color: "#25d366", fontSize: 12 }}>en línea</div>
          </div>
        </div>

        {/* Messages */}
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "16px 12px",
            display: "flex",
            flexDirection: "column",
            gap: 8,
            background: isWA ? "#0b141a" : "#000",
          }}
        >
          {messages.map((msg) => {
            const isBot = msg.role === "assistant";
            return (
              <div
                key={msg.id}
                style={{
                  display: "flex",
                  justifyContent: isBot ? "flex-start" : "flex-end",
                  alignItems: "flex-end",
                  gap: 6,
                }}
              >
                {isBot && (
                  <div
                    style={{
                      width: 26, height: 26, borderRadius: "50%", flexShrink: 0, marginBottom: 2,
                      background: isWA
                        ? "linear-gradient(135deg, #25d366, #128c7e)"
                        : "linear-gradient(135deg, #f09433, #bc1888)",
                      display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12,
                    }}
                  >
                    ✨
                  </div>
                )}
                <div
                  style={{
                    maxWidth: "72%",
                    padding: "8px 12px",
                    borderRadius: isBot ? "16px 16px 16px 4px" : "16px 16px 4px 16px",
                    background: isBot
                      ? isWA ? "#1f2c33" : "#262626"
                      : isWA ? "#005c4b" : "linear-gradient(135deg, #7928ca, #e1306c)",
                    color: "white",
                    fontSize: 14,
                    lineHeight: 1.45,
                  }}
                >
                  {msg.content}
                  <div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", textAlign: "right", marginTop: 3 }}>
                    {msg.time}{!isBot && " ✓✓"}
                  </div>
                </div>
              </div>
            );
          })}

          {loading && (
            <div style={{ display: "flex", alignItems: "flex-end", gap: 6 }}>
              <div
                style={{
                  width: 26, height: 26, borderRadius: "50%",
                  background: isWA
                    ? "linear-gradient(135deg, #25d366, #128c7e)"
                    : "linear-gradient(135deg, #f09433, #bc1888)",
                  display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12,
                }}
              >✨</div>
              <div
                style={{
                  padding: "10px 14px",
                  borderRadius: "16px 16px 16px 4px",
                  background: isWA ? "#1f2c33" : "#262626",
                  display: "flex", gap: 5, alignItems: "center",
                }}
              >
                {[0, 1, 2].map((i) => (
                  <div
                    key={i}
                    style={{
                      width: 7, height: 7, borderRadius: "50%", background: "#8899aa",
                      animation: "bounce 1.2s infinite",
                      animationDelay: `${i * 0.2}s`,
                    }}
                  />
                ))}
              </div>
            </div>
          )}

          {notification && (
            <div
              style={{
                margin: "10px 0", padding: "10px 14px",
                background: notification === "urgente" ? "rgba(255,59,48,0.15)" : "rgba(37,211,102,0.12)",
                border: `1px solid ${notification === "urgente" ? "rgba(255,59,48,0.4)" : "rgba(37,211,102,0.3)"}`,
                borderRadius: 12,
              }}
            >
              <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 4, color: notification === "urgente" ? "#ff3b30" : "#25d366" }}>
                {notification === "urgente" ? "🚨 Lead urgente detectado" : "🔔 Lead calificado"}
              </div>
              <div style={{ fontSize: 11, color: "rgba(255,255,255,0.6)", lineHeight: 1.5 }}>
                {notification === "urgente"
                  ? "El lead quiere avanzar ya. Notificación enviada a vendedor con prioridad alta."
                  : "El lead aceptó la consulta gratuita. María fue notificada para hacer seguimiento."}
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>

        {/* Input */}
        <div
          style={{
            background: isWA ? "#1f2c33" : "#1a1a1a",
            padding: "10px 12px",
            display: "flex", gap: 8, alignItems: "flex-end",
            borderTop: `1px solid ${isWA ? "#2a3942" : "#2a2a2a"}`,
            flexShrink: 0,
          }}
        >
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKey}
            placeholder="Escribe como si fueras el lead..."
            rows={1}
            style={{
              flex: 1, background: isWA ? "#2a3942" : "#262626",
              border: "none", borderRadius: 20, padding: "9px 14px",
              color: "white", fontSize: 14, resize: "none", outline: "none",
              lineHeight: 1.4, maxHeight: 80, overflowY: "auto", fontFamily: "inherit",
            }}
          />
          <button
            onClick={sendMessage}
            disabled={!input.trim() || loading}
            style={{
              width: 38, height: 38, borderRadius: "50%", border: "none",
              cursor: input.trim() && !loading ? "pointer" : "not-allowed",
              background: input.trim() && !loading
                ? isWA ? "#25d366" : "linear-gradient(135deg, #7928ca, #e1306c)"
                : "#333",
              color: "white", fontSize: 16, flexShrink: 0,
              display: "flex", alignItems: "center", justifyContent: "center",
              transition: "all 0.2s",
            }}
          >➤</button>
        </div>
      </div>

      <div style={{ marginTop: 14, textAlign: "center", color: "#445566", fontSize: 11, maxWidth: 320 }}>
        Escribe libremente como lo haría un lead real. La IA detecta cuándo está listo para calificar y simula la notificación al vendedor.
      </div>

      <style>{`
        @keyframes bounce {
          0%, 60%, 100% { transform: translateY(0); }
          30% { transform: translateY(-5px); }
        }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #333; border-radius: 2px; }
      `}</style>
    </div>
  );
}
