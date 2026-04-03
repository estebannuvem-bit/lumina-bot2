import { Redis } from "@upstash/redis";
import { getCatalog } from "./catalog.js";

const redis = Redis.fromEnv();

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default async function handler(req, res) {
  // Preflight CORS
  if (req.method === "OPTIONS") {
    return res.status(200).set(CORS_HEADERS).end();
  }

  // Agregar CORS a todas las respuestas
  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { client, message } = req.body;
  if (!client || !message) {
    return res.status(400).json({ error: "Missing client or message" });
  }

  const systemPrompt = await redis.get(`prompt:${client}`);
  if (!systemPrompt) {
    return res.status(404).json({ error: "Client not found" });
  }

  const vertical    = await redis.hget(`config:${client}`, "vertical") || "muebles";
  const catalogText = await getCatalog(client, vertical);

  const messages = [
    {
      role: "user",
      content: `[CATALOGO ACTUALIZADO]\n${catalogText || "Sin catalogo disponible."}\n[FIN CATALOGO]\n\nConfirma que recibiste el catalogo.`,
    },
    {
      role: "assistant",
      content: "Catalogo recibido y listo para consultas.",
    },
    { role: "user", content: message },
  ];

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      system: systemPrompt,
      messages,
    }),
  });

  const data = await response.json();
  return res.status(200).json(data);
}
