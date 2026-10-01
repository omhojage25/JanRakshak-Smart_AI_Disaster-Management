/**
 * Tunable parameters of the global allocation optimizer.
 *
 * These are demo/policy values chosen for the JanRakshak prototype. They are NOT scientifically
 * validated emergency-response standards; change them here, in one place, when better values exist.
 */
import type { Priority } from '../../constants.js';

export const ALLOCATION_CONFIG = {
  /** Risk weight R_i = (priority_score / 100) ^ gamma. gamma > 1 separates CRITICAL from LOW incidents. */
  riskGamma: 2,

  /** Response-time target per operational priority (minutes). ETA within target earns full time value. */
  responseTargetMin: { critical: 8, high: 12, medium: 20, low: 30 } satisfies Record<Priority, number>,
  /** After the target, time value decays as exp(-(eta - target) / (target * decayFactor)). */
  etaDecayFactor: 1,
  /** Hard limit: a unit further than this by road is not a feasible candidate (minutes). */
  maxResponseMin: 60,

  /** Weights inside the utility: time value vs fit (sum to 1), and the scarcity penalty. */
  weightTime: 0.7,
  weightFit: 0.3,
  weightScarcity: 0.05,

  /** Importance of a slot: first unit of an essential type = 1, later units decay by this factor. */
  additionalUnitFactor: 0.6,
  /** Importance multiplier for supporting (non-essential) types. */
  supportTypeFactor: 0.6,

  /** Cost of pulling a committed unit off its current incident (same units as utility). */
  reassignCostDispatched: 0.05,
  reassignCostEnRouteBase: 0.1,
  /** Extra cost per unit of progress (0 = just left, 1 = nearly there) for an en-route unit. */
  reassignCostEnRouteProgress: 0.2,
  /** A plan that moves committed units must beat the no-move plan by at least this much. */
  minImprovementForMoves: 0.05,

  /** A (resource, incident) pair the coordinator rejected is not proposed again for this long. */
  rejectionCooldownMin: 15,

  /** Live GPS newer than this is treated as the unit's current position. */
  gpsFreshMin: 2,
  /** An en-route unit whose live GPS stops for this long triggers re-optimization. */
  gpsStaleMin: 5,
  /** Remaining road ETA exceeding the planned remaining time by this much triggers re-optimization. */
  etaDriftMin: 10,

  /** Debounce for event-driven re-optimization (ms). */
  reoptimizeDebounceMs: 1500,
  /** Safety bound on solve → verify-route → re-solve iterations. */
  maxVerifyIterations: 12,
  /** How many alternative candidates to keep per proposal for explanation. */
  explainAlternatives: 4,
} as const;
