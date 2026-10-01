/**
 * Solver correctness: the Hungarian implementation must equal a brute-force optimum on hundreds
 * of random small instances (with infeasible pairs, non-positive weights and rectangular shapes).
 *   npx tsx server/scripts/test-hungarian.ts
 */
import { maxWeightAssignment } from '../src/services/allocation/hungarian.js';
import { check, rng, section, summary } from './alloc-test-lib.js';

function bruteForce(w: (number | null)[][], R: number, S: number): number {
  let best = 0;
  const usedS = new Array<boolean>(S).fill(false);
  const rec = (r: number, acc: number) => {
    if (r === R) { best = Math.max(best, acc); return; }
    rec(r + 1, acc); // resource r idle
    for (let s = 0; s < S; s++) {
      const x = w[r][s];
      if (usedS[s] || x === null) continue;
      usedS[s] = true;
      rec(r + 1, acc + x);
      usedS[s] = false;
    }
  };
  rec(0, 0);
  return best;
}

section('Hungarian vs brute force');
const rand = rng(20260927);
let instances = 0;
for (let t = 0; t < 600; t++) {
  const R = 1 + Math.floor(rand() * 6);
  const S = 1 + Math.floor(rand() * 6);
  const w = Array.from({ length: R }, () => Array.from({ length: S }, () => {
    const x = rand();
    if (x < 0.25) return null; // infeasible
    return Math.round((rand() * 2 - 0.3) * 1000) / 1000; // includes negative/zero values
  }));
  const res = maxWeightAssignment(w, S);
  const opt = bruteForce(w, R, S);
  instances++;
  check(Math.abs(res.total - opt) < 1e-9, `instance ${t} (${R}x${S}) optimum ${opt.toFixed(3)}`, { got: res.total, w });
  const rows = new Set(res.pairs.map((p) => p[0]));
  const cols = new Set(res.pairs.map((p) => p[1]));
  check(rows.size === res.pairs.length && cols.size === res.pairs.length, `instance ${t}: each resource/slot used at most once`);
  check(res.pairs.every(([r, s]) => w[r][s] !== null && (w[r][s] as number) > 0), `instance ${t}: no infeasible or non-positive pair selected`);
}
console.log(`checked ${instances} random instances`);

section('Edge cases');
check(maxWeightAssignment([], 0).pairs.length === 0, 'empty problem');
check(maxWeightAssignment([[null, null]], 2).pairs.length === 0, 'all-infeasible row leaves resource idle');
const big = Array.from({ length: 40 }, (_, r) => Array.from({ length: 120 }, (_, s) => ((r * 7 + s * 13) % 11 === 0 ? null : ((r * 31 + s * 17) % 97) / 97)));
const t0 = performance.now();
const res = maxWeightAssignment(big, 120);
check(res.pairs.length > 0 && performance.now() - t0 < 2000, `40×120 instance solves quickly (${(performance.now() - t0).toFixed(1)} ms)`);

summary('Hungarian solver');
