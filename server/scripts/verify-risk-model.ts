/**
 * Parity check: the in-process TypeScript tree evaluator must reproduce Python XGBoost's
 * predict_proba on every row of the held-out test set (server/ml/parity_reference.json,
 * generated once with xgboost 3.2.0 and the training script's own load_and_encode).
 *
 * Usage: npm run verify:risk-model   (exits 1 on any mismatch)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODEL_CLASS_ORDER, MODEL_INCIDENT_TYPES, predictProbabilities } from '../src/services/riskModel.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ref = JSON.parse(fs.readFileSync(path.join(here, '..', 'ml', 'parity_reference.json'), 'utf8')) as {
  incident_type_classes: string[];
  class_order: string[];
  rows: { raw_incident_type: string; x: number[]; probs: number[]; label: string }[];
};

let failures = 0;
const check = (ok: boolean, msg: string) => { if (!ok) { failures++; console.log(`FAIL ${msg}`); } };

check(ref.incident_type_classes.join() === MODEL_INCIDENT_TYPES.join(), `incident_type encoding ${ref.incident_type_classes}`);
check(ref.class_order.join() === MODEL_CLASS_ORDER.join(), `class order ${ref.class_order}`);

let maxDiff = 0;
let classMismatches = 0;
let correct = 0;
for (const [i, row] of ref.rows.entries()) {
  check(MODEL_INCIDENT_TYPES[row.x[0]] === row.raw_incident_type, `row ${i}: incident_type code ${row.x[0]} != ${row.raw_incident_type}`);
  const p = predictProbabilities(row.x);
  const ts = MODEL_CLASS_ORDER.map((c) => p[c]);
  ts.forEach((v, k) => { maxDiff = Math.max(maxDiff, Math.abs(v - row.probs[k])); });
  const tsClass = MODEL_CLASS_ORDER[ts.indexOf(Math.max(...ts))];
  const pyClass = MODEL_CLASS_ORDER[row.probs.indexOf(Math.max(...row.probs))];
  if (tsClass !== pyClass) classMismatches++;
  if (tsClass === row.label) correct++;
}
check(maxDiff < 1e-5, `max probability difference ${maxDiff}`);
check(classMismatches === 0, `${classMismatches} predicted-class mismatches`);

console.log(`rows=${ref.rows.length} maxAbsProbDiff=${maxDiff.toExponential(2)} classMismatches=${classMismatches} ` +
  `testAccuracy=${(correct / ref.rows.length).toFixed(4)}`);
console.log(failures ? `PARITY FAILED (${failures})` : 'PARITY OK');
process.exit(failures ? 1 : 0);
