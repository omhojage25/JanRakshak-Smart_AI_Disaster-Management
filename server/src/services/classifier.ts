import { INCIDENT_TYPES, PRIORITIES, isOneOf, type IncidentType, type Priority } from '../constants.js';
import { normalizeEvidence, type RiskEvidence } from './riskAssessment.js';
import { matchLandmark } from './locate.js';

export interface ClassificationResult {
  type: IncidentType;
  title: string;
  description: string;
  location_name: string | null;
  /** Gemini's rough coordinate estimate: a weak hint for location resolution, never ground truth. */
  location_lat: number | null;
  location_lng: number | null;
  /** Structured location as written in the report (original wording preserved in `text`). */
  location: { text: string | null; place: string | null; locality: string | null; city: string | null; state: string | null; country: string | null };
  people_affected: number;
  injuries: number;
  has_children: boolean;
  has_elderly: boolean;
  has_disabled: boolean;
  /** Gemini's own opinion, kept only in the stored extraction record. The risk model sets the incident's priority. */
  priority: Priority;
  priority_score: number;
  urgency_indicators: string[];
  /** Structured evidence for the XGBoost risk model (0 = no evidence, -1 = present but count unknown). */
  evidence: RiskEvidence;
  language: string;
  confidence: number;
  classifier: 'gemini' | 'keyword';
}

const SYSTEM_PROMPT = `You are JanRakshak, a disaster response classification system for Mumbai, India.
Analyze emergency reports (in English, Hindi or Marathi) and extract structured information.

Respond ONLY with a JSON object with these fields:
- type: one of "fire", "flood", "building_collapse", "gas_leak", "road_accident" (closest match)
- title: short factual title, max 80 characters, in English
- description: one or two sentence factual summary in English
- location_name: the most specific place mentioned, written in English as "place, area" (e.g. "Sion Hospital, Sion", "Bhendi Bazaar, Mumbai"); transliterate Hindi/Marathi names; null if no place is mentioned
- location_text: the exact words of the report that describe the location, in the original language and script; null if none
- location_place: the specific building/landmark/street/colony in English (e.g. "Sion Hospital", "Tilak Nagar Colony"); null if only an area is given
- location_locality: the neighbourhood/area/suburb in English (e.g. "Chembur", "Khar West"); null if not stated
- location_city: the city if stated or clearly implied (e.g. "Mumbai", "Navi Mumbai", "Thane"); null if unknown
- location_state: the state if stated; null otherwise
- location_lat, location_lng: a rough coordinate guess for that place (only a hint; it will be checked against a map), or null if you cannot guess
- people_affected: number of people affected; -1 if the report says people are affected but gives no number; 0 if not mentioned
- injuries: number injured; -1 if the report says people are injured but gives no number; 0 if not mentioned
- trapped: number of people trapped/stuck; -1 if people are trapped but no number is given; 0 if nobody is reported trapped
- has_children, has_elderly, has_disabled: true only if the report says they are affected
- fire, flood, earthquake, storm: true only if the report describes that hazard (storm includes cyclone/strong winds)
- building_damage: true if buildings/structures are damaged or collapsed
- search_rescue: true if people are trapped, missing or need to be rescued/evacuated
- medical_emergency: true if people are injured, ill, unconscious or need medical care
- urgent: true if the reporter conveys urgency (urgent, SOS, immediately, please hurry) or immediate danger to life
Use only what the report states; never guess numbers.
- priority: one of "critical", "high", "medium", "low"
- priority_score: 0-100
- urgency_indicators: short English phrases for urgent factors (e.g. "people trapped", "fire spreading")
- language: "en", "hi" or "mr" (dominant language of the report)
- confidence: 0.0-1.0, how confident you are in the extraction

Reference coordinates: Gateway of India 18.9220,72.8347; CST 18.9398,72.8354; Bandra-Worli Sea Link 19.0380,72.8162;
Dharavi 19.0430,72.8527; Andheri 19.1197,72.8464; Dadar 19.0178,72.8478; Kurla 19.0726,72.8794; Borivali 19.2307,72.8567;
Thane 19.2183,72.9781; Navi Mumbai 19.0330,73.0297; Powai 19.1176,72.9060; Malad 19.1870,72.8489; Goregaon 19.1550,72.8490;
Juhu 19.0883,72.8264; Worli 19.0096,72.8153.`;

// ── Keyword fallback (used only when Gemini is unavailable) ─────────────────

const has = (text: string, words: string[]) => words.some((w) => text.includes(w));

function keywordClassify(message: string): ClassificationResult {
  const m = message.toLowerCase();
  let type: IncidentType = 'road_accident';
  if (has(m, ['fire', 'aag', 'आग', 'burning', 'jal rah', 'जळ'])) type = 'fire';
  else if (has(m, ['flood', 'waterlog', 'paani', 'baarish', 'पानी', 'पूर', 'बाढ़'])) type = 'flood';
  else if (has(m, ['collapse', 'building gir', 'imarat', 'इमारत', 'कोसळ', 'ढह'])) type = 'building_collapse';
  else if (has(m, ['gas', 'leak', 'गैस', 'गॅस'])) type = 'gas_leak';
  else if (has(m, ['accident', 'crash', 'दुर्घटना', 'टक्कर', 'अपघात'])) type = 'road_accident';

  const trapped = has(m, ['trapped', 'phas', 'फंसे', 'फसे', 'अडकले']);
  const children = has(m, ['child', 'bachch', 'बच्चे', 'मुलं', 'मुले']);
  const elderly = has(m, ['elderly', 'old people', 'boodh', 'बुजुर्ग', 'वृद्ध']);
  const spreading = has(m, ['spread', 'phail', 'फैल', 'rising', 'badh rah']);
  const urgency = [
    trapped && 'people trapped', children && 'children involved', elderly && 'elderly involved', spreading && 'danger spreading',
  ].filter((u): u is string => Boolean(u));

  let priority: Priority = 'medium';
  let score = 50;
  if (trapped || spreading) { priority = 'critical'; score = 90; }
  else if (children || elderly) { priority = 'high'; score = 75; }

  const evidence = keywordEvidence(m, type, { children, elderly });
  // Offline: the only location knowledge is an area named in the text (area-level, never exact).
  const landmark = matchLandmark(message);

  let language: 'en' | 'hi' | 'mr' = 'en';
  if (/[ऀ-ॿ]/.test(message)) language = /आहे|झाला|झाली|अडकले|मदत पाठवा|कोसळ/.test(message) ? 'mr' : 'hi';

  const label = type.replace('_', ' ');
  return {
    type,
    title: `${label.replace(/\b\w/g, (c) => c.toUpperCase())} reported`,
    description: `A ${label} incident has been reported. Original message: "${message.substring(0, 200)}"`,
    location_name: landmark?.name ?? null,
    location_lat: null,
    location_lng: null,
    location: { text: landmark?.name ?? null, place: null, locality: landmark?.name ?? null, city: null, state: null, country: 'India' },
    people_affected: Math.max(0, evidence.people_affected),
    injuries: Math.max(0, evidence.injured),
    has_children: children,
    has_elderly: elderly,
    has_disabled: false,
    priority,
    priority_score: score,
    urgency_indicators: urgency,
    evidence,
    language,
    confidence: 0.4,
    classifier: 'keyword',
  };
}

/** Converts Devanagari digits so "३० लोक" reads as 30. */
const asciiDigits = (s: string) => s.replace(/[०-९]/g, (d) => String(d.charCodeAt(0) - 0x0966));

/** First explicit number directly before one of the words, e.g. "15 लोग फंसे", "3 injured". */
function countBefore(text: string, words: string[]): number {
  const m = text.match(new RegExp(String.raw`(\d{1,6})\s*(?:\S+\s+){0,2}?(?:${words.join('|')})`));
  return m ? Number(m[1]) : 0;
}

/** Offline evidence extraction for the risk model. Conservative: only what the words state. */
function keywordEvidence(
  lower: string,
  type: IncidentType,
  found: { children: boolean; elderly: boolean },
): RiskEvidence {
  // Drop simple English negations ("nobody hurt", "no one trapped") so they aren't read as evidence.
  const t = asciiDigits(lower)
    .replace(/\b(?:no|nobody|no one|not|none|without)\b[^.,;!?]{0,20}?\b(?:injur\w*|hurt|wounded|trapped|stuck)\b/g, ' ');
  const injuredWords = ['injured', 'hurt', 'wounded', 'bleeding', 'ghayal', 'घायल', 'जखमी'];
  const trappedWords = ['trapped', 'stuck', 'phas', 'फंसे', 'फसे', 'अडकले', 'अडकल'];
  const peopleWords = ['people', 'persons', 'residents', 'families', 'log', 'लोग', 'लोक'];
  const nPeople = countBefore(t, peopleWords);
  const nInjured = countBefore(t, injuredWords);
  const nTrapped = countBefore(t, trappedWords);
  const injured = has(t, injuredWords);
  const trappedMentioned = has(t, trappedWords);
  return normalizeEvidence({
    people_affected: nPeople || Math.max(nInjured, nTrapped),
    injured: nInjured || (injured ? -1 : 0),
    trapped: nTrapped || (trappedMentioned ? -1 : 0),
    children: found.children ? -1 : 0,
    elderly: found.elderly ? -1 : 0,
    disabled: has(t, ['disabled', 'wheelchair', 'handicap', 'विकलांग', 'दिव्यांग', 'अपंग']) ? -1 : 0,
    fire: type === 'fire',
    flood: type === 'flood',
    earthquake: has(t, ['earthquake', 'tremor', 'bhukamp', 'भूकंप']),
    storm: has(t, ['cyclone', 'storm', 'toofan', 'tufan', 'तूफान', 'चक्रवात', 'वादळ']),
    building_damage: type === 'building_collapse' || has(t, ['collapse', 'crack', 'damaged', 'gir gay', 'ढह', 'कोसळ']),
    search_rescue: trappedMentioned || has(t, ['rescue', 'missing', 'evacuat', 'बचाव', 'लापता', 'बेपत्ता']),
    medical_emergency: injured || has(t, ['ambulance', 'hospital', 'unconscious', 'behosh', 'बेहोश', 'बेशुद्ध']),
    urgency_indicators: has(t, ['urgent', 'sos', 'immediately', 'asap', 'hurry', 'help', 'jaldi', 'turant', 'तुरंत', 'जल्दी', 'मदद', 'तातडीने', 'लवकर', 'मदत']),
  });
}

// ── Gemini ─────────────────────────────────────────────────────────────────

function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  const braces = text.match(/\{[\s\S]*\}/);
  return braces ? braces[0] : text;
}

function geminiModels(): string[] {
  const primary = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
  const fallbacks = (process.env.GEMINI_FALLBACK_MODELS ?? 'gemini-3.6-flash,gemini-3.5-flash-lite')
    .split(',').map((s) => s.trim()).filter(Boolean);
  return [...new Set([primary, ...fallbacks])];
}

async function callGemini(message: string, timeoutMs: number): Promise<Record<string, unknown>> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');
  const models = geminiModels();
  let lastError: Error = new Error('No Gemini model configured');

  for (const [i, model] of models.entries()) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{ parts: [{ text: message }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 2048, responseMimeType: 'application/json' },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        const body = await res.text();
        const status = res.status;
        throw Object.assign(new Error(`Gemini (${model}) error ${status}: ${body.slice(0, 200)}`), { status });
      }
      const data = await res.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
      const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
      return JSON.parse(extractJson(text)) as Record<string, unknown>;
    } catch (err) {
      lastError = err as Error;
      const status = (err as { status?: number }).status ?? 0;
      const retryable = status === 0 || status === 429 || status >= 500;
      const next = retryable && i < models.length - 1 ? `trying ${models[i + 1]}` : 'giving up';
      console.error(`Gemini call failed (${lastError.message.split('\n')[0]}); ${next}`);
      if (!retryable) break;
    }
  }
  throw lastError;
}

const clampInt = (v: unknown, min: number, max: number, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};
const clamp01 = (v: unknown, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
};
const coord = (v: unknown, min: number, max: number) => {
  const n = typeof v === 'number' ? v : Number(v);
  return v !== null && v !== undefined && v !== '' && Number.isFinite(n) && n >= min && n <= max ? n : null;
};
const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

function normalize(raw: Record<string, unknown>): ClassificationResult {
  if (!isOneOf(INCIDENT_TYPES, raw.type)) throw new Error(`Gemini returned an unknown incident type: ${String(raw.type)}`);
  const evidence = normalizeEvidence({
    people_affected: raw.people_affected,
    injured: raw.injuries,
    trapped: raw.trapped,
    children: raw.has_children === true ? -1 : 0,
    elderly: raw.has_elderly === true ? -1 : 0,
    disabled: raw.has_disabled === true ? -1 : 0,
    // The app's own type is Gemini's reading of the same report, so it also counts as hazard evidence.
    fire: raw.fire === true || raw.type === 'fire',
    flood: raw.flood === true || raw.type === 'flood',
    earthquake: raw.earthquake,
    storm: raw.storm,
    building_damage: raw.building_damage === true || raw.type === 'building_collapse',
    search_rescue: raw.search_rescue,
    medical_emergency: raw.medical_emergency,
    // If the model omits the new "urgent" flag, fall back to whether it listed any urgency factors.
    urgency_indicators: raw.urgent === true
      || (raw.urgent === undefined && Array.isArray(raw.urgency_indicators) && raw.urgency_indicators.length > 0),
  });
  let lat = coord(raw.location_lat, -90, 90);
  let lng = coord(raw.location_lng, -180, 180);
  if (lat === null || lng === null) { lat = null; lng = null; }
  return {
    type: raw.type,
    title: text(raw.title, 120) ?? `${raw.type.replace('_', ' ')} reported`,
    description: text(raw.description, 2000) ?? '',
    location_name: text(raw.location_name, 200),
    location_lat: lat,
    location_lng: lng,
    location: {
      text: text(raw.location_text, 300),
      place: text(raw.location_place, 200),
      locality: text(raw.location_locality, 120),
      city: text(raw.location_city, 80),
      state: text(raw.location_state, 80),
      country: 'India',
    },
    people_affected: Math.max(0, evidence.people_affected),
    injuries: Math.max(0, evidence.injured),
    has_children: raw.has_children === true,
    has_elderly: raw.has_elderly === true,
    has_disabled: raw.has_disabled === true,
    priority: isOneOf(PRIORITIES, raw.priority) ? raw.priority : 'medium',
    priority_score: clampInt(raw.priority_score, 0, 100, 50),
    urgency_indicators: Array.isArray(raw.urgency_indicators)
      ? raw.urgency_indicators.filter((u): u is string => typeof u === 'string').slice(0, 10).map((u) => u.slice(0, 80))
      : [],
    evidence,
    language: raw.language === 'hi' || raw.language === 'mr' ? raw.language : 'en',
    confidence: clamp01(raw.confidence, 0.7),
    classifier: 'gemini',
  };
}

/** Exposed for tests: maps a raw Gemini JSON reply to a ClassificationResult (incl. risk evidence). */
export const normalizeGeminiOutput = normalize;

export async function classifyReport(message: string): Promise<ClassificationResult> {
  if (!process.env.GEMINI_API_KEY) {
    console.warn('No GEMINI_API_KEY set, using keyword classifier');
    return keywordClassify(message);
  }
  try {
    const raw = await callGemini(message, 20_000);
    return normalize(raw);
  } catch (err) {
    console.error('Gemini classification failed, using keyword classifier instead:', (err as Error).message);
    return keywordClassify(message);
  }
}
