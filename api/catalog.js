import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

const TTL = {
  verduleria:  5 * 60,       // 5 min — precios cambian diario
  muebles:     24 * 60 * 60, // 24h  — precios estables
  restaurante: 2 * 60 * 60,  // 2h   — menú del día
};

// ─── OBTENER CATÁLOGO (caché Redis → Google Sheets) ───────────

export async function getCatalog(clientId, vertical) {
  const key = `catalog:${clientId}:${vertical}`;

  const cached = await redis.get(key);
  if (cached) return cached;

  const sheetId = await redis.hget(`config:${clientId}`, "sheet_id");
  const tab     = await redis.hget(`config:${clientId}`, `tab_${vertical}`) || "productos";

  if (!sheetId) return null;

  try {
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${tab}?key=${process.env.GOOGLE_API_KEY}`;
    const res  = await fetch(url);
    if (!res.ok) return null;

    const { values } = await res.json();
    if (!values || values.length < 2) return null;

    const headers = values[0];
    const idxActivo = headers.indexOf("Activo");
    const rows = idxActivo >= 0
      ? values.slice(1).filter(r => (r[idxActivo] || "").toUpperCase() === "SI")
      : values.slice(1);

    if (rows.length === 0) return null;

    const catalog = formatCatalog(rows, headers, vertical);
    await redis.set(key, catalog, { ex: TTL[vertical] || 300 });
    return catalog;
  } catch (err) {
    console.error(`Catalog fetch error [${clientId}/${vertical}]:`, err);
    return null;
  }
}

// ─── FORMATEAR CATÁLOGO POR VERTICAL ──────────────────────────

function formatCatalog(rows, headers, vertical) {
  const idx = (col) => headers.indexOf(col);

  if (vertical === "verduleria") {
    return rows.map(r => {
      const nombre = r[idx("Nombre")]      || "";
      const unidad = r[idx("Unidad")]      || "kg";
      const p1     = r[idx("Precio_kg")]   || r[idx("Precio")] || "";
      const p5     = r[idx("Precio_5kg")]  || "";
      const p25    = r[idx("Precio_25kg")] || "";
      const stock  = r[idx("Stock")]       || "SI";
      let line = `• ${nombre} (${unidad}): $${p1}`;
      if (p5)  line += ` | +5kg: $${p5}`;
      if (p25) line += ` | +25kg: $${p25}`;
      if (stock.toUpperCase() !== "SI") line += " ⚠️ sin stock";
      return line;
    }).join("\n");
  }

  if (vertical === "restaurante") {
    const byCategory = {};
    rows.forEach(r => {
      const cat    = r[idx("Categoria")]   || "General";
      const nombre = r[idx("Nombre")]      || "";
      const precio = r[idx("Precio")]      || "";
      const desc   = r[idx("Descripcion")] || "";
      if (!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push(`  • ${nombre} $${precio}${desc ? " — " + desc : ""}`);
    });
    return Object.entries(byCategory)
      .map(([cat, items]) => `${cat}:\n${items.join("\n")}`)
      .join("\n\n");
  }

  // muebles (default)
  return rows.map(r => {
    const nombre = r[idx("Nombre")]        || "";
    const cat    = r[idx("Categoria")]     || "";
    const precio = r[idx("Precio")]        || "";
    const oferta = r[idx("Precio_oferta")] || "";
    const stock  = r[idx("Stock")]         || "SI";
    const vars   = r[idx("Variantes")]     || "";
    let line = `• [${cat}] ${nombre}: $${precio}`;
    if (oferta) line += ` (oferta: $${oferta})`;
    if (vars)   line += ` | variantes: ${vars}`;
    if (stock.toUpperCase() !== "SI") line += " — sin stock";
    return line;
  }).join("\n");
}

// ─── ENDPOINT DE INVALIDACIÓN (llamado desde Apps Script) ──────
// POST /api/catalog?client=nuvem
// Body: { vertical, secret }

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const clientId           = req.query.client;
  const { vertical, secret } = req.body || {};

  if (!clientId || !vertical) {
    return res.status(400).json({ error: "Missing client or vertical" });
  }

  if (secret !== process.env.CATALOG_INVALIDATE_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const key = `catalog:${clientId}:${vertical}`;
  await redis.del(key);
  console.log(`Cache invalidated: ${key}`);
  return res.status(200).json({ ok: true, deleted: key });
}
