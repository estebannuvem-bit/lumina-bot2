# Lumina Bot — Simulador conversacional con IA

Prototipo de bot de calificación de leads para clínica estética. Construido con React + Vite en el frontend y una Serverless Function en Vercel como backend seguro.

## Estructura

```
lumina-bot/
├── api/
│   └── chat.js          ← Backend: llama a Anthropic con la API key protegida
├── src/
│   ├── App.jsx          ← Frontend: interfaz del simulador
│   └── main.jsx         ← Entry point de React
├── index.html
├── vite.config.js
├── vercel.json
└── package.json
```

## Cómo publicar en Vercel (paso a paso)

### 1. Subir a GitHub

```bash
cd lumina-bot
git init
git add .
git commit -m "first commit"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/lumina-bot.git
git push -u origin main
```

### 2. Importar en Vercel

1. Entrá a https://vercel.com y logueate con tu cuenta de GitHub
2. Hacé clic en **"Add New Project"**
3. Seleccioná el repo `lumina-bot`
4. Vercel detecta que es Vite automáticamente — no cambies nada
5. Antes de hacer deploy, hacé clic en **"Environment Variables"** y agregá:
   - **Name:** `ANTHROPIC_API_KEY`
   - **Value:** tu API key de Anthropic (la que empieza con `sk-ant-...`)
6. Hacé clic en **"Deploy"**

En 2-3 minutos tenés tu link público, algo como:
`https://lumina-bot.vercel.app`

### 3. Completar la info de la clínica

En `src/App.jsx`, buscá el bloque `INFORMACIÓN DE LA CLÍNICA` dentro del `SYSTEM_PROMPT` y completá los campos marcados con `[Completar]`:

- Dirección física
- Horarios de atención
- Teléfono / WhatsApp
- Instagram
- Tratamientos principales
- Nombre de la especialista

Guardá, hacé commit y push — Vercel redeploya automáticamente.

### 4. Obtener tu API key de Anthropic

Si no tenés una:
1. Entrá a https://console.anthropic.com
2. Creá una cuenta o logueate
3. Andá a **API Keys** y creá una nueva
4. Recomendado: configurá un límite de gasto mensual en **Billing** para no tener sorpresas

---

## Para la demo

Compartí el link y la persona puede chatear directamente con Sofi desde el navegador, sin instalar nada.

El bot detecta automáticamente cuando el lead está calificado y muestra la notificación simulada.
