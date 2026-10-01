import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * XGBoost-based emergency risk classification proof-of-concept: in-process inference.
 *
 * Evaluates the trees saved by train_xgboost_risk.py (server/ml/janrakshak_xgb_model.json)
 * directly in TypeScript, so the Node server needs no Python or native XGBoost dependency.
 * Verified to match Python XGBoost's predict_proba on all 994 test rows:
 * `npm run verify:risk-model`.
 *
 * Caveat: the model's training labels were produced by a deterministic rubric over these same
 * 15 input features. It reproduces that rubric; it is not a validated real-world severity predictor.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const MODEL_FILE = path.join(__dirname, '..', '..', 'ml', 'janrakshak_xgb_model.json');

/** Exact feature order used in training. */
export const FEATURE_ORDER = [
  'incident_type', 'people_affected', 'injured', 'trapped', 'children', 'elderly', 'disabled',
  'fire', 'flood', 'earthquake', 'storm', 'building_damage', 'search_rescue', 'medical_emergency',
  'urgency_indicators',
] as const;

/** incident_type encoding: scikit-learn LabelEncoder sorts alphabetically, so index = code. */
export const MODEL_INCIDENT_TYPES = [
  'building_collapse', 'earthquake', 'fire', 'flood', 'medical', 'other', 'search_rescue', 'storm', 'unknown',
] as const;
export type ModelIncidentType = (typeof MODEL_INCIDENT_TYPES)[number];

/** Output order of the class probabilities (LabelEncoder, alphabetical). */
export const MODEL_CLASS_ORDER = ['CRITICAL', 'HIGH', 'LOW', 'MEDIUM'] as const;
export type RiskClass = (typeof MODEL_CLASS_ORDER)[number];

interface Tree {
  left: number[];
  right: number[];
  feature: number[];
  threshold: number[];
  defaultLeft: number[];
  classIndex: number;
}

export interface LoadedModel {
  trees: Tree[];
  baseMargin: number[];
  version: string;
}

let cached: LoadedModel | null = null;

function fail(reason: string): never {
  throw new Error(`Unsupported XGBoost model file (${reason}); refusing to guess.`);
}

/** Parses and validates the model once. Anything outside the supported format is rejected, not approximated. */
export function loadRiskModel(): LoadedModel {
  if (cached) return cached;
  const raw = fs.readFileSync(MODEL_FILE);
  const json = JSON.parse(raw.toString('utf8'));
  const learner = json?.learner;
  if (learner?.objective?.name !== 'multi:softprob') fail(`objective ${learner?.objective?.name}`);
  const params = learner.learner_model_param;
  if (Number(params.num_class) !== MODEL_CLASS_ORDER.length) fail(`num_class ${params.num_class}`);
  if (Number(params.num_feature) !== FEATURE_ORDER.length) fail(`num_feature ${params.num_feature}`);
  const names: string[] = learner.feature_names ?? [];
  if (names.join(',') !== FEATURE_ORDER.join(',')) fail(`feature order ${names.join(',')}`);
  const booster = learner.gradient_booster;
  if (booster?.name !== 'gbtree') fail(`booster ${booster?.name}`);

  const baseMargin = String(params.base_score).replace(/[[\]]/g, '').split(',').map(Number);
  if (baseMargin.length !== MODEL_CLASS_ORDER.length || baseMargin.some((v) => !Number.isFinite(v))) {
    fail(`base_score ${params.base_score}`);
  }

  const treeInfo: number[] = booster.model.tree_info;
  const trees: Tree[] = booster.model.trees.map((t: Record<string, number[]>, i: number) => {
    if (t.split_type.some((s) => s !== 0) || (t.categories?.length ?? 0) > 0) fail('categorical splits');
    return {
      left: t.left_children,
      right: t.right_children,
      feature: t.split_indices,
      threshold: t.split_conditions, // for leaf nodes this holds the leaf value
      defaultLeft: t.default_left,
      classIndex: treeInfo[i],
    };
  });

  const version = `janrakshak_xgb_model.json@sha256:${crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12)}`;
  cached = { trees, baseMargin, version };
  return cached;
}

function leafValue(tree: Tree, x: readonly number[]): number {
  let node = 0;
  while (tree.left[node] !== -1) {
    const v = x[tree.feature[node]];
    const goLeft = Number.isNaN(v) ? tree.defaultLeft[node] === 1 : v < tree.threshold[node];
    node = goLeft ? tree.left[node] : tree.right[node];
  }
  return tree.threshold[node];
}

/** Class probabilities for one encoded feature row (length 15, in FEATURE_ORDER). */
export function predictProbabilities(x: readonly number[]): Record<RiskClass, number> {
  if (x.length !== FEATURE_ORDER.length) throw new Error(`Expected ${FEATURE_ORDER.length} features, got ${x.length}`);
  const model = loadRiskModel();
  const margin = [...model.baseMargin];
  for (const tree of model.trees) margin[tree.classIndex] += leafValue(tree, x);
  const max = Math.max(...margin);
  const exp = margin.map((m) => Math.exp(m - max));
  const sum = exp.reduce((a, b) => a + b, 0);
  const out = {} as Record<RiskClass, number>;
  MODEL_CLASS_ORDER.forEach((cls, i) => { out[cls] = exp[i] / sum; });
  return out;
}
