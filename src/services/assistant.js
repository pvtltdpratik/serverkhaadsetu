const { HttpError } = require('../utils/http');
const { catalog } = require('../data/schemeCatalog');

const API = 'https://generativelanguage.googleapis.com/v1beta/models';

const MAX_HISTORY = 12;
const MAX_TEXT = 2000;

// A short line per scheme so the assistant can point at the right one instead of guessing.
const schemeDigest = () => catalog.filter((s) => s.audience === 'farmer').map((s) => `- ${s.name}: ${s.benefit}`).join('\n');

const SYSTEM = () => `You are the farming assistant inside ShetSamrudhi (शेतसमृद्धी), an app for farmers in Maharashtra, India, and for the village centers that sell them organic fertilizer.

How to answer:
- Reply in the language the farmer writes in: Marathi, Hindi or English. Keep sentences short and plain. Prefer 3 to 6 short lines or a few bullet points.
- Be practical: what to do, how much, when. Give ranges rather than false precision, and say when it depends on a soil test.
- This app sells ORGANIC fertilizers (vermicompost, neem cake, bone meal, compost and similar). Recommend organic options first. Do not recommend banned or unsafe chemicals.
- For serious crop disease, pests or animal health, advise showing a sample to the Taluka Agriculture Officer or the Kisan Call Center (1800-180-1551) as well.
- For government schemes, use ONLY the scheme facts below or the farmer's own context. If you do not know an amount, deadline or rule, say so and point them to the Scheme section of the app or the Taluka Agriculture Officer. Never invent amounts.
- You cannot place orders, move money, or change the farmer's data. If asked, tell them where in the app to do it (Marketplace, Profile, Schemes, Soil Scan, Community).
- If a question is not about farming, farm business, weather, markets, schemes or the app, politely steer back to farming.

Government schemes you may mention:
${schemeDigest()}`;

// What the assistant may know about this farmer: only what they saved in the app.
const farmerContext = async (db, owner) => {
  const lines = [];
  const profile = (await db.query('SELECT name, village, land_holding_hectares AS land FROM profiles WHERE owner_id = $1', [owner])).rows[0];
  if (profile) {
    if (profile.name && profile.name !== 'Farmer') lines.push(`Name: ${profile.name}`);
    if (profile.village) lines.push(`Village: ${profile.village}`);
    if (Number(profile.land) > 0) lines.push(`Land: ${Number(profile.land)} hectares`);
  }
  const details = (await db.query('SELECT data FROM farmer_details WHERE owner_id = $1', [owner])).rows[0];
  if (details && Array.isArray(details.data.primaryCrops) && details.data.primaryCrops.length) lines.push(`Crops: ${details.data.primaryCrops.join(', ')}`);
  if (details && details.data.irrigation) lines.push(`Water: ${details.data.irrigation}`);
  const scan = (await db.query(
    'SELECT created_at, health_score, nutrient_n, nutrient_p, nutrient_k, disease FROM scans WHERE owner_id = $1 ORDER BY created_at DESC LIMIT 1', [owner],
  )).rows[0];
  if (scan) {
    lines.push(`Latest soil scan (${new Date(scan.created_at).toISOString().slice(0, 10)}): health ${Math.round(scan.health_score)}/100, N ${Math.round(scan.nutrient_n)}, P ${Math.round(scan.nutrient_p)}, K ${Math.round(scan.nutrient_k)}${scan.disease && scan.disease !== 'none' ? `, possible issue: ${scan.disease}` : ''}`);
  }
  return lines.length ? `What this farmer has told the app:\n${lines.join('\n')}` : '';
};

// Cleans the conversation the app sends: only user/model turns, bounded, alternating from a user turn.
const cleanHistory = (history) => {
  if (history === undefined) return [];
  if (!Array.isArray(history)) throw new HttpError(400, '"history" must be a list');
  const turns = history.slice(-MAX_HISTORY).map((h) => {
    if (!h || (h.role !== 'user' && h.role !== 'model') || typeof h.text !== 'string') throw new HttpError(400, 'Each history item needs a role (user or model) and text');
    return { role: h.role, text: h.text.trim().slice(0, MAX_TEXT) };
  }).filter((h) => h.text);
  while (turns.length && turns[0].role !== 'user') turns.shift();
  return turns;
};

// Asks Gemini. The API key is read from the server environment only; the app never sees it.
// `fetchImpl` is injectable so tests never call Google.
const createAssistant = ({ apiKey, model = 'gemini-flash-latest', fallbackModel = '', fetchImpl = fetch, retryDelayMs = 1500 } = {}) => {
  const enabled = Boolean(apiKey);

  const reply = async (db, { owner, message, history }) => {
    if (!enabled) throw new HttpError(503, 'The assistant is not set up on this server');
    const context = await farmerContext(db, owner);
    const contents = [...cleanHistory(history), { role: 'user', text: message }].map((t) => ({ role: t.role, parts: [{ text: t.text }] }));
    const request = JSON.stringify({
      systemInstruction: { parts: [{ text: [SYSTEM(), context].filter(Boolean).join('\n\n') }] },
      contents,
      generationConfig: { temperature: 0.4, maxOutputTokens: 900 },
    });
    // Google sometimes answers "busy" (429 or 503) for a moment. Try the model twice, then the fallback model
    // (if one is set) once, before giving up.
    const plan = [model, model, ...(fallbackModel && fallbackModel !== model ? [fallbackModel] : [model])];
    let res;
    for (let attempt = 1; attempt <= plan.length; attempt += 1) {
      try {
        res = await fetchImpl(`${API}/${encodeURIComponent(plan[attempt - 1])}:generateContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
          body: request,
          signal: AbortSignal.timeout(30000),
        });
      } catch (err) {
        throw new HttpError(502, 'The assistant could not be reached. Please try again in a moment.');
      }
      if ((res.status !== 429 && res.status !== 503) || attempt === plan.length) break;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 429 || res.status === 503) throw new HttpError(503, 'The assistant is busy right now. Please try again in a minute.');
      throw new HttpError(502, 'The assistant could not answer right now.');
    }
    const candidate = json.candidates && json.candidates[0];
    const text = candidate && candidate.content && Array.isArray(candidate.content.parts) ? candidate.content.parts.map((p) => p.text || '').join('').trim() : '';
    if (!text) {
      const blocked = (json.promptFeedback && json.promptFeedback.blockReason) || (candidate && candidate.finishReason === 'SAFETY');
      throw new HttpError(422, blocked ? 'I cannot help with that. Please ask something about your farm.' : 'The assistant had no answer. Please rephrase your question.');
    }
    return text;
  };

  return { enabled, reply };
};

module.exports = { createAssistant, cleanHistory, MAX_HISTORY, MAX_TEXT };
