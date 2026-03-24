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

function BotDemo() {
  const [messages, setMessages] = useState([{ ...INITIAL_MESSAGE, time: formatTime(), id: 0 }]);
  const [history, setHistory] = useState([INITIAL_MESSAGE]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [notification, setNotification] = useState(null);
  const bottomRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  const sendMessage = async () => {
    const text = input.trim();
    if (!text || loading) return;

    const userMsg = { role: "user", content: text, time: formatTime(), id: Date.now() };
    const newHistory = [...history, { role: "user", content: text }];
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setLoading(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ system: SYSTEM_PROMPT, messages: newHistory }),
      });
      const data = await res.json();
      const raw = data.content?.[0]?.text || "perdón, hubo un problema 😅 podés escribirme de nuevo?";
      const { clean, event } = parseResponse(raw);

      setMessages((prev) => [...prev, { role: "assistant", content: clean, time: formatTime(), id: Date.now() + 1 }]);
      setHistory([...newHistory, { role: "assistant", content: clean }]);

      if (event === "calificado") setTimeout(() => setNotification("calificado"), 800);
      else if (event === "urgente") setTimeout(() => setNotification("urgente"), 800);
    } catch {
      setMessages((prev) => [...prev, { role: "assistant", content: "uy, algo falló 😅 escribime de nuevo", time: formatTime(), id: Date.now() + 1 }]);
    }

    setLoading(false);
    inputRef.current?.focus();
  };

  const handleKey = (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  };

  return (
    <div style={{ width: "100%", maxWidth: 380, borderRadius: 24, overflow: "hidden", display: "flex", flexDirection: "column", height: 540, boxShadow: "0 40px 100px rgba(0,0,0,0.5)", border: "1px solid rgba(255,255,255,0.06)" }}>
      {/* Header */}
      <div style={{ background: "#1f2c33", padding: "12px 16px", display: "flex", alignItems: "center", gap: 10, borderBottom: "1px solid #2a3942", flexShrink: 0 }}>
        <div style={{ width: 38, height: 38, borderRadius: "50%", background: "linear-gradient(135deg, #25d366, #128c7e)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, flexShrink: 0 }}>✨</div>
        <div>
          <div style={{ color: "white", fontWeight: 600, fontSize: 15 }}>Sofi · Lumina</div>
          <div style={{ color: "#25d366", fontSize: 12 }}>en línea</div>
        </div>
        <div style={{ marginLeft: "auto", fontSize: 11, color: "rgba(255,255,255,0.3)", background: "rgba(255,255,255,0.05)", padding: "3px 8px", borderRadius: 20 }}>demo en vivo</div>
      </div>

      {/* Messages */}
      <div style={{ flex: 1, overflowY: "auto", padding: "16px 12px", display: "flex", flexDirection: "column", gap: 8, background: "#0b141a" }}>
        {messages.map((msg) => {
          const isBot = msg.role === "assistant";
          return (
            <div key={msg.id} style={{ display: "flex", justifyContent: isBot ? "flex-start" : "flex-end", alignItems: "flex-end", gap: 6 }}>
              {isBot && <div style={{ width: 26, height: 26, borderRadius: "50%", flexShrink: 0, marginBottom: 2, background: "linear-gradient(135deg, #25d366, #128c7e)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12 }}>✨</div>}
              <div style={{ maxWidth: "72%", padding: "8px 12px", borderRadius: isBot ? "16px 16px 16px 4px" : "16px 16px 4px 16px", background: isBot ? "#1f2c33" : "#005c4b", color: "white", fontSize: 14, lineHeight: 1.45 }}>
                {msg.content}
                <div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", textAlign: "right", marginTop: 3 }}>{msg.time}{!isBot && " ✓✓"}</div>
              </div>
            </div>
          );
        })}

        {loading && (
          <div style={{ display: "flex", alignItems: "flex-end", gap: 6 }}>
            <div style={{ width: 26, height: 26, borderRadius: "50%", background: "linear-gradient(135deg, #25d366, #128c7e)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12 }}>✨</div>
            <div style={{ padding: "10px 14px", borderRadius: "16px 16px 16px 4px", background: "#1f2c33", display: "flex", gap: 5, alignItems: "center" }}>
              {[0, 1, 2].map((i) => <div key={i} style={{ width: 7, height: 7, borderRadius: "50%", background: "#8899aa", animation: "bounce 1.2s infinite", animationDelay: `${i * 0.2}s` }} />)}
            </div>
          </div>
        )}

        {notification && (
          <div style={{ margin: "8px 0", padding: "10px 14px", background: notification === "urgente" ? "rgba(255,59,48,0.15)" : "rgba(37,211,102,0.12)", border: `1px solid ${notification === "urgente" ? "rgba(255,59,48,0.4)" : "rgba(37,211,102,0.3)"}`, borderRadius: 12 }}>
            <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 4, color: notification === "urgente" ? "#ff3b30" : "#25d366" }}>
              {notification === "urgente" ? "🚨 Lead urgente detectado" : "🔔 Lead calificado"}
            </div>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.6)", lineHeight: 1.5 }}>
              {notification === "urgente" ? "El lead quiere avanzar ya. Notificación enviada con prioridad alta." : "El lead aceptó la consulta gratuita. Dra. Valentina fue notificada."}
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div style={{ background: "#1f2c33", padding: "10px 12px", display: "flex", gap: 8, alignItems: "flex-end", borderTop: "1px solid #2a3942", flexShrink: 0 }}>
        <textarea ref={inputRef} value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={handleKey} placeholder="Escribí como si fueras el cliente..." rows={1}
          style={{ flex: 1, background: "#2a3942", border: "none", borderRadius: 20, padding: "9px 14px", color: "white", fontSize: 14, resize: "none", outline: "none", lineHeight: 1.4, maxHeight: 80, overflowY: "auto", fontFamily: "inherit" }} />
        <button onClick={sendMessage} disabled={!input.trim() || loading}
          style={{ width: 38, height: 38, borderRadius: "50%", border: "none", cursor: input.trim() && !loading ? "pointer" : "not-allowed", background: input.trim() && !loading ? "#25d366" : "#333", color: "white", fontSize: 16, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", transition: "all 0.2s" }}>➤</button>
      </div>
    </div>
  );
}

export default function App() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 40);
    window.addEventListener("scroll", onScroll);
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <div style={{ background: "#080c10", color: "white", fontFamily: "'DM Sans', 'Helvetica Neue', sans-serif", minHeight: "100vh", overflowX: "hidden" }}>

      {/* Nav */}
      <nav style={{ position: "fixed", top: 0, left: 0, right: 0, zIndex: 100, padding: "0 32px", height: 60, display: "flex", alignItems: "center", justifyContent: "space-between", background: scrolled ? "rgba(8,12,16,0.95)" : "transparent", backdropFilter: scrolled ? "blur(12px)" : "none", borderBottom: scrolled ? "1px solid rgba(255,255,255,0.06)" : "none", transition: "all 0.3s" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 20 }}>☁</span>
          <span style={{ fontWeight: 700, fontSize: 16, letterSpacing: "-0.3px" }}>Nuvem</span>
        </div>
        <a href="https://wa.me/+58 414-0505088" target="_blank" rel="noreferrer"
          style={{ background: "#25d366", color: "white", padding: "8px 18px", borderRadius: 20, fontSize: 13, fontWeight: 600, textDecoration: "none", transition: "opacity 0.2s" }}
          onMouseOver={e => e.target.style.opacity = "0.85"} onMouseOut={e => e.target.style.opacity = "1"}>
          Hablar con Nuvem
        </a>
      </nav>

      {/* Hero */}
      <section style={{ minHeight: "100vh", display: "flex", alignItems: "center", padding: "80px 24px 60px", maxWidth: 1100, margin: "0 auto" }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 60, alignItems: "center", justifyContent: "center", width: "100%" }}>

          {/* Left */}
          <div style={{ flex: "1 1 380px", maxWidth: 500 }}>
            <div style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "rgba(37,211,102,0.1)", border: "1px solid rgba(37,211,102,0.25)", borderRadius: 20, padding: "5px 12px", fontSize: 12, color: "#25d366", marginBottom: 28, fontWeight: 500 }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#25d366", display: "inline-block", animation: "pulse 2s infinite" }} />
              Demo en vivo
            </div>

            <h1 style={{ fontSize: "clamp(32px, 5vw, 52px)", fontWeight: 800, lineHeight: 1.1, letterSpacing: "-1.5px", margin: "0 0 20px" }}>
              Tus leads respondidos en{" "}
              <span style={{ background: "linear-gradient(90deg, #25d366, #128c7e)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>segundos.</span>
            </h1>

            <p style={{ fontSize: 17, color: "rgba(255,255,255,0.55)", lineHeight: 1.7, margin: "0 0 36px", maxWidth: 420 }}>
              El 78% de los clientes elige al primero que responde. Nosotros hacemos que siempre seas vos — sin que tu equipo esté pendiente del celular.
            </p>

            <div style={{ display: "flex", gap: 24, marginBottom: 40, flexWrap: "wrap" }}>
              {[["< 60\"", "Primera respuesta"], ["3x", "Más conversiones"], ["24/7", "Sin horarios"]].map(([val, label]) => (
                <div key={label}>
                  <div style={{ fontSize: 26, fontWeight: 800, letterSpacing: "-1px", color: "#25d366" }}>{val}</div>
                  <div style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", marginTop: 2 }}>{label}</div>
                </div>
              ))}
            </div>

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {["💬 WhatsApp", "📸 Instagram DM"].map(ch => (
                <div key={ch} style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 20, padding: "6px 14px", fontSize: 13, color: "rgba(255,255,255,0.6)" }}>{ch}</div>
              ))}
            </div>
          </div>

          {/* Right — Bot */}
          <div style={{ flex: "1 1 320px", display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
            <BotDemo />
            <p style={{ fontSize: 12, color: "rgba(255,255,255,0.25)", textAlign: "center" }}>
              ↑ Probá hablar como lo haría un cliente real
            </p>
          </div>
        </div>
      </section>

      {/* Cómo funciona */}
      <section style={{ padding: "80px 24px", maxWidth: 900, margin: "0 auto" }}>
        <div style={{ textAlign: "center", marginBottom: 56 }}>
          <div style={{ fontSize: 12, color: "rgba(255,255,255,0.35)", letterSpacing: "2px", textTransform: "uppercase", marginBottom: 12 }}>Cómo funciona</div>
          <h2 style={{ fontSize: "clamp(24px, 4vw, 38px)", fontWeight: 800, letterSpacing: "-1px", margin: 0 }}>Simple para el cliente.<br />Poderoso por adentro.</h2>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {[
            ["01", "📲", "Lead llega desde un anuncio", "El lead hace clic en tu anuncio de Meta y abre WhatsApp o Instagram. El bot responde en menos de 60 segundos, sin importar la hora."],
            ["02", "🤝", "Conversación natural", "El bot habla como una persona real. Entiende preguntas libres, califica el interés y guía la conversación sin parecer un formulario."],
            ["03", "🔔", "Tu vendedor recibe el lead listo", "Cuando el lead está calificado, tu equipo recibe una notificación con el contexto completo. Solo tienen que cerrar."],
          ].map(([num, icon, title, desc]) => (
            <div key={num} style={{ display: "flex", gap: 24, padding: "28px 0", borderBottom: "1px solid rgba(255,255,255,0.05)", alignItems: "flex-start" }}>
              <div style={{ fontSize: 12, color: "rgba(255,255,255,0.2)", fontWeight: 700, minWidth: 24, paddingTop: 4 }}>{num}</div>
              <div style={{ fontSize: 28, minWidth: 40 }}>{icon}</div>
              <div>
                <div style={{ fontWeight: 700, fontSize: 17, marginBottom: 6, letterSpacing: "-0.3px" }}>{title}</div>
                <div style={{ color: "rgba(255,255,255,0.45)", fontSize: 15, lineHeight: 1.6 }}>{desc}</div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section style={{ padding: "80px 24px", textAlign: "center" }}>
        <div style={{ maxWidth: 560, margin: "0 auto" }}>
          <h2 style={{ fontSize: "clamp(24px, 4vw, 36px)", fontWeight: 800, letterSpacing: "-1px", marginBottom: 16 }}>
            ¿Querés ver cómo funciona para tu negocio?
          </h2>
          <p style={{ color: "rgba(255,255,255,0.45)", fontSize: 16, lineHeight: 1.7, marginBottom: 36 }}>
            Hacemos una demo personalizada con tu rubro y tus leads reales.
          </p>
          <a href="https://wa.me/+58 414-0505088?text=Hola, quiero ver cómo funciona la automatización para mi negocio"
            target="_blank" rel="noreferrer"
            style={{ display: "inline-flex", alignItems: "center", gap: 8, background: "#25d366", color: "white", padding: "14px 32px", borderRadius: 30, fontSize: 16, fontWeight: 700, textDecoration: "none", transition: "all 0.2s", boxShadow: "0 8px 32px rgba(37,211,102,0.25)" }}
            onMouseOver={e => e.currentTarget.style.transform = "translateY(-2px)"}
            onMouseOut={e => e.currentTarget.style.transform = "translateY(0)"}>
            💬 Hablar con Nuvem
          </a>
          <div style={{ marginTop: 14, fontSize: 13, color: "rgba(255,255,255,0.25)" }}>Sin compromiso · Respuesta en menos de 24 hs</div>
        </div>
      </section>

      {/* Footer */}
      <footer style={{ borderTop: "1px solid rgba(255,255,255,0.06)", padding: "24px", textAlign: "center", color: "rgba(255,255,255,0.2)", fontSize: 13 }}>
        © 2025 Nuvem · Automatización de leads &nbsp;·&nbsp; Hecho con IA · Powered by Claude
      </footer>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700;800&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        @keyframes bounce { 0%,60%,100%{transform:translateY(0)} 30%{transform:translateY(-5px)} }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #333; border-radius: 2px; }
      `}</style>
    </div>
  );
}
