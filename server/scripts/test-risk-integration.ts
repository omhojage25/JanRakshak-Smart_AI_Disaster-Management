/**
 * Integration test for the XGBoost risk-classification POC.
 *
 *   npm run test:risk          pure checks (8 required cases, score formula, evidence mapping)
 *   npm run test:risk -- --db  also runs the real report/merge/escalation code against the local
 *                              database. Stop the dev server first (the embedded DB is single-process).
 *                              Test incidents are deleted afterwards.
 */
import {
  EMPTY_EVIDENCE, assessRisk, encodeFeatures, mergeEvidence, modelIncidentType, normalizeEvidence, riskScore,
  type RiskAssessment, type RiskEvidence,
} from '../src/services/riskAssessment.js';
import { FEATURE_ORDER, MODEL_CLASS_ORDER, MODEL_INCIDENT_TYPES } from '../src/services/riskModel.js';
import { classifyReport, normalizeGeminiOutput, type ClassificationResult } from '../src/services/classifier.js';

let failures = 0;
const ok = (cond: unknown, msg: string) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failures++;
};
const ev = (e: Partial<RiskEvidence>): RiskEvidence => ({ ...EMPTY_EVIDENCE, ...e });

function checkAssessment(label: string, a: RiskAssessment) {
  if (a.status !== 'ok') return ok(false, `${label}: inference unavailable`);
  const sum = MODEL_CLASS_ORDER.reduce((s, c) => s + a.probabilities[c], 0);
  const recomputed = Math.round(a.probabilities.CRITICAL * 95 + a.probabilities.HIGH * 70 + a.probabilities.MEDIUM * 45 + a.probabilities.LOW * 20);
  const argmax = MODEL_CLASS_ORDER.reduce((b, c) => (a.probabilities[c] > a.probabilities[b] ? c : b));
  ok((MODEL_CLASS_ORDER as readonly string[]).includes(a.model_class), `${label}: class ${a.model_class} is valid`);
  ok(Math.abs(sum - 1) < 1e-3, `${label}: probabilities sum to ${sum.toFixed(4)}`);
  ok(a.model_score >= 0 && a.model_score <= 100, `${label}: score ${a.model_score} in 0–100`);
  ok(Math.abs(recomputed - a.model_score) <= 1, `${label}: score ${a.model_score} matches formula (${recomputed})`);
  ok(argmax === a.model_class, `${label}: class is the highest-probability class`);
  console.log(`      → ${a.model_class} ${a.model_score}  P=${JSON.stringify(a.probabilities)}  factors=${JSON.stringify(a.factors)}`);
}

// ── 1. Required cases ──
const cases: [string, RiskEvidence, string[]][] = [
  ['1 low severity (minor flooding, 5 people)', ev({ flood: 1, people_affected: 5 }), ['LOW']],
  ['2 medium severity (fire, 4 injured, urgent)', ev({ fire: 1, people_affected: 20, injured: 4, urgency_indicators: 1 }), ['MEDIUM']],
  ['3 high severity (collapse, injured, trapped, rescue)', ev({ building_damage: 1, people_affected: 30, injured: 6, trapped: -1, search_rescue: 1, medical_emergency: 1, urgency_indicators: 1 }), ['HIGH', 'CRITICAL']],
  ['4 critical (earthquake mass casualty)', ev({ earthquake: 1, people_affected: 500, injured: 30, trapped: 12, children: -1, elderly: -1, building_damage: 1, search_rescue: 1, medical_emergency: 1, urgency_indicators: 1 }), ['CRITICAL']],
  ['5 missing optional evidence', normalizeEvidence({}), ['LOW']],
  ['6 unknown incident type (app type gas_leak, no hazard flags)', normalizeGeminiOutput({ type: 'gas_leak', title: 'Gas leak', people_affected: 12, injuries: 2, trapped: -1, urgent: true }).evidence, ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']],
  ['7 multiple people injured (15)', ev({ injured: 15, people_affected: 40, medical_emergency: 1, urgency_indicators: 1 }), ['MEDIUM', 'HIGH', 'CRITICAL']],
  ['8 trapped + search/rescue', ev({ trapped: 6, search_rescue: 1, building_damage: 1, people_affected: 10, urgency_indicators: 1 }), ['MEDIUM', 'HIGH', 'CRITICAL']],
];
for (const [label, e, expected] of cases) {
  const a = assessRisk(e, 'gemini');
  checkAssessment(label, a);
  if (a.status === 'ok') ok(expected.includes(a.model_class), `${label}: class ${a.model_class} is one of [${expected}]`);
}

// ── 2. Encoding, feature order, score formula ──
const row = encodeFeatures(ev({ earthquake: 1, injured: 3 }));
ok(row.length === 15 && FEATURE_ORDER[0] === 'incident_type' && row[0] === MODEL_INCIDENT_TYPES.indexOf('earthquake') && row[0] === 1,
  `feature row has 15 features, incident_type first, earthquake encoded as 1 (got ${row[0]})`);
ok(row[2] === 3 && FEATURE_ORDER[2] === 'injured', 'injured is feature index 2');
// 0.85×95 + 0.10×70 + 0.04×45 + 0.01×20 = 89.75 → 90 (the brief's "≈ 89" was approximate).
ok(riskScore({ LOW: 0.01, MEDIUM: 0.04, HIGH: 0.10, CRITICAL: 0.85 }) === 90, 'score example (0.85/0.10/0.04/0.01) = 89.75 → 90');
ok(riskScore({ LOW: 1, MEDIUM: 0, HIGH: 0, CRITICAL: 0 }) === 20 && riskScore({ LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 1 }) === 95,
  'score bounds: all-LOW = 20, all-CRITICAL = 95');
ok(modelIncidentType(ev({ fire: 1, earthquake: 1 })) === 'earthquake', 'incident_type priority: earthquake before fire');
ok(modelIncidentType(ev({ injured: 2 })) === 'other' && modelIncidentType(EMPTY_EVIDENCE) === 'unknown', 'incident_type: counts only → other; nothing → unknown');

// ── 3. Gemini → evidence mapping ──
const g = normalizeGeminiOutput({
  type: 'building_collapse', title: 'Collapse', people_affected: 30, injuries: -1, trapped: 5,
  has_children: true, has_elderly: false, search_rescue: true, medical_emergency: true, urgent: true,
  priority: 'low', priority_score: 3,
});
ok(g.evidence.building_damage === 1 && g.evidence.trapped === 5 && g.evidence.injured === -1 && g.evidence.children === -1
  && g.evidence.elderly === 0 && g.evidence.search_rescue === 1 && g.evidence.urgency_indicators === 1,
  `Gemini fields map to evidence: ${JSON.stringify(g.evidence)}`);
ok(g.injuries === 0 && g.people_affected === 30, 'app fields stay non-negative (injuries -1 → 0 for the incident row)');
const ga = assessRisk(g.evidence, 'gemini');
ok(ga.status === 'ok' && ga.model_class !== 'LOW', `Gemini's own "low / 3" is ignored; model says ${ga.status === 'ok' ? ga.model_class : '?'}`);
const noUrgentField = normalizeGeminiOutput({ type: 'fire', title: 'x', urgency_indicators: ['fire spreading'] });
ok(noUrgentField.evidence.urgency_indicators === 1 && noUrgentField.evidence.fire === 1, 'missing "urgent" falls back to urgency list; type fire → fire flag');

// ── 4. Keyword fallback (Gemini unavailable) ──
const savedKey = process.env.GEMINI_API_KEY;
delete process.env.GEMINI_API_KEY;
const hi = await classifyReport('सायन-माटुंगा रोड पर बाढ़ का पानी भर गया है। गाड़ियां फंसी हुई हैं। कम से कम 15 लोग फंसे हैं।');
ok(hi.classifier === 'keyword' && hi.evidence.flood === 1 && hi.evidence.trapped === 15 && hi.evidence.search_rescue === 1,
  `keyword (Hindi): flood + 15 trapped → ${JSON.stringify(hi.evidence)}`);
const mr = await classifyReport('भेंडी बाजार जवळ इमारत कोसळली. ३० लोक अडकले आहेत. तातडीने मदत पाठवा!');
ok(mr.evidence.building_damage === 1 && mr.evidence.trapped === 30 && mr.evidence.urgency_indicators === 1,
  `keyword (Marathi, Devanagari digits): collapse + 30 trapped + urgent → ${JSON.stringify(mr.evidence)}`);
const en = await classifyReport('Small fire in a dustbin near the station, already put out, nobody hurt.');
ok(en.evidence.fire === 1 && en.evidence.injured === 0 && en.evidence.medical_emergency === 0,
  `keyword ignores negated injuries ("nobody hurt"): ${JSON.stringify(en.evidence)}`);
const neg = await classifyReport('Wall collapsed after rain, 2 people injured, no one trapped.');
ok(neg.evidence.injured === 2 && neg.evidence.trapped === 0, `keyword: "2 people injured, no one trapped" → ${JSON.stringify(neg.evidence)}`);
checkAssessment('keyword-extracted Marathi report', assessRisk(mr.evidence, 'keyword'));
if (savedKey !== undefined) process.env.GEMINI_API_KEY = savedKey;

// ── 5. Merge rule ──
const merged = mergeEvidence(ev({ injured: -1, trapped: 2, fire: 1 }), ev({ injured: 4, trapped: -1, urgency_indicators: 1 }));
ok(merged.injured === 4 && merged.trapped === 2 && merged.fire === 1 && merged.urgency_indicators === 1,
  `merge: known counts beat unknown, larger wins, flags OR → ${JSON.stringify(merged)}`);

// ── 6. Real report / merge / escalation code against the database ──
if (process.argv.includes('--db')) {
  const { initDb, closeDb } = await import('../src/db.js');
  const { createReportFromMessage, parseReportBody } = await import('../src/routes/reports.js');
  const { startScheduler } = await import('../src/services/scheduler.js');
  const db = await initDb();
  const created: string[] = [];
  const base = (e: Partial<RiskEvidence>): ClassificationResult => ({
    type: 'building_collapse', title: '[risk-test] collapse', description: 'test', location_name: 'Test site',
    location_lat: 18.99, location_lng: 72.83, people_affected: 0, injuries: 0, has_children: false, has_elderly: false,
    has_disabled: false, priority: 'low', priority_score: 1, urgency_indicators: [], language: 'en', confidence: 0.9,
    classifier: 'gemini', evidence: ev({ building_damage: 1, ...e }),
  });
  // Resolved the same way as a real report: an accurate reporter GPS fix (no geocoder call needed).
  const { resolveLocation } = await import('../src/services/locate.js');
  const loc = await resolveLocation({ location_name: null, location_lat: null, location_lng: null }, '[risk-test]', { lat: 18.99, lng: 72.83, accuracy_m: 10 });
  try {
    const first = await createReportFromMessage(parseReportBody({ raw_message: '[risk-test] one', source: 'test' }),
      base({ people_affected: 8, injured: 1 }), loc, null);
    const inc1 = first.incident as Record<string, any>;
    created.push(inc1.id);
    const a1 = inc1.risk_assessment as RiskAssessment;
    ok(a1?.status === 'ok', 'DB: new incident stores risk_assessment');
    ok(a1.status === 'ok' && inc1.priority === a1.model_class.toLowerCase() && inc1.priority_score === a1.model_score,
      `DB: priority/priority_score come from the model (${inc1.priority}/${inc1.priority_score}), not Gemini's "low/1"`);

    const second = await createReportFromMessage(parseReportBody({ raw_message: '[risk-test] two', source: 'test' }),
      base({ trapped: 6, injured: 5, search_rescue: 1, medical_emergency: 1, urgency_indicators: 1, children: -1 }), loc, null);
    const inc2 = second.incident as Record<string, any>;
    const a2 = inc2.risk_assessment as RiskAssessment;
    ok(second.is_duplicate && inc2.id === inc1.id, 'DB: second report merged into the same incident');
    ok(a2.status === 'ok' && a2.evidence_source === 'merged' && a2.reports_combined === 2 && a2.evidence.trapped === 6 && a2.evidence.people_affected === 8,
      `DB: merged incident re-assessed on combined evidence (${a2.status === 'ok' ? `${a2.model_class} ${a2.model_score}` : '-'})`);
    // Merges are audited as one explicit 'merged' entry carrying the risk before/after.
    const reassessAudit = await db.one(`SELECT details FROM audit_log WHERE incident_id = $1 AND action = 'merged'`, [inc1.id]);
    ok(reassessAudit?.details.model_class_after && reassessAudit.details.model_class_before !== undefined, `DB: re-assessment audited ${JSON.stringify(reassessAudit?.details)}`);

    // Escalation: make the incident overdue, let the real scheduler run once.
    const before = (await db.one('SELECT priority, priority_score, risk_assessment FROM incidents WHERE id = $1', [inc1.id]))!;
    await db.query(`UPDATE incidents SET priority = 'medium', priority_score = 45, escalation_deadline = now() - interval '1 minute' WHERE id = $1`, [inc1.id]);
    const stop = startScheduler();
    await new Promise((r) => setTimeout(r, 4500));
    stop();
    const after = (await db.one('SELECT priority, priority_score, risk_assessment FROM incidents WHERE id = $1', [inc1.id]))!;
    ok(after.priority === 'high', `DB: scheduler escalated operational priority medium → ${after.priority}`);
    ok(JSON.stringify(after.risk_assessment) === JSON.stringify(before.risk_assessment),
      'DB: escalation left the original ML assessment (model_class/model_score) untouched');
  } finally {
    for (const id of created) {
      await db.query('DELETE FROM notifications WHERE incident_id = $1', [id]);
      await db.query('DELETE FROM audit_log WHERE incident_id = $1', [id]);
      await db.query('DELETE FROM incidents WHERE id = $1', [id]);
    }
    console.log(`(cleaned up ${created.length} test incident(s))`);
    await closeDb();
  }
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL RISK INTEGRATION CHECKS PASSED');
process.exit(failures ? 1 : 0);
