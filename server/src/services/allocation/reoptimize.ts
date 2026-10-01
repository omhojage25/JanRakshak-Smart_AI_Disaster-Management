/**
 * Central entry point for dynamic re-optimization. Every trigger funnels into the same global
 * optimizer. Rapid triggers are debounced, and only one optimization runs at a time (runs are
 * chained, never concurrent). Proposals still require coordinator approval.
 */
import { getDb } from '../../db.js';
import { ALLOCATION_CONFIG as C } from './config.js';
import { runOptimization, type RunOptions } from './allocationRun.js';

export type ReoptimizeTrigger =
  | 'resource_unavailable' | 'resource_available' | 'resource_status_changed' | 'gps_stale'
  | 'road_blocked' | 'road_cleared'
  | 'incident_created' | 'incident_risk_increased' | 'incident_resolved' | 'incident_deleted' | 'incident_escalated'
  | 'assignment_infeasible' | 'eta_drift' | 'resource_freed' | 'coordinator_decision'
  | 'incident_merged' | 'incident_location_changed' | 'duplicate_review';

let chain: Promise<unknown> = Promise.resolve();
let timer: NodeJS.Timeout | null = null;
const pending = new Set<string>();
let enabled = true;

/** Runs one optimization after any in-flight run finishes (single-flight via a promise chain). */
export function runExclusive(opts: RunOptions) {
  const next = chain.then(() => runOptimization(getDb(), opts));
  chain = next.catch(() => undefined);
  return next;
}

let listener: ((trigger: ReoptimizeTrigger, detail?: string) => void) | null = null;
/** Tests observe which re-optimizations were requested. */
export function onReoptimizeRequested(fn: typeof listener) { listener = fn; }

/** Debounced, event-driven re-optimization. Safe to call from any request handler after commit. */
export function reoptimize(trigger: ReoptimizeTrigger, detail?: string) {
  listener?.(trigger, detail);
  if (!enabled) return;
  pending.add(detail ? `${trigger}:${detail}` : trigger);
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    const triggers = [...pending].sort();
    pending.clear();
    runExclusive({ trigger: triggers.join(','), allowMoves: true })
      .catch((err) => console.error('[reoptimize] run failed:', err));
  }, C.reoptimizeDebounceMs);
  timer.unref?.();
}

/** For tests/benchmarks that drive the optimizer directly. */
export function setReoptimizeEnabled(on: boolean) {
  enabled = on;
  if (!on && timer) { clearTimeout(timer); timer = null; pending.clear(); }
}

/** Resolves once any queued/in-flight run has finished (tests). */
export async function reoptimizeIdle() {
  while (timer || pending.size) await new Promise((r) => setTimeout(r, 50));
  await chain;
}
