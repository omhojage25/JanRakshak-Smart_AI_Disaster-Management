/**
 * Exact maximum-weight bipartite assignment (Hungarian / Kuhn–Munkres, O(n³)).
 *
 * Solves:   maximize Σ w(r,s)·x(r,s)
 *           s.t.     Σ_s x(r,s) ≤ 1 for every resource r,  Σ_r x(r,s) ≤ 1 for every slot s,
 *                    x(r,s) = 0 where the pair is infeasible (weight null).
 *
 * Leaving a resource idle or a slot unfilled is allowed (worth 0): the matrix is padded with
 * zero-cost dummy rows/columns, so infeasible pairs are never selected and pairs with
 * non-positive weight are never worth selecting.
 */

/** Minimum-cost perfect assignment for a square matrix. Returns col index assigned to each row. */
export function minCostAssignment(cost: number[][]): number[] {
  const n = cost.length;
  const INF = Number.POSITIVE_INFINITY;
  // Potentials-based implementation (1-indexed internally).
  const u = new Array<number>(n + 1).fill(0);
  const v = new Array<number>(n + 1).fill(0);
  const p = new Array<number>(n + 1).fill(0); // p[j] = row matched to column j
  const way = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array<number>(n + 1).fill(INF);
    const used = new Array<boolean>(n + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = INF;
      let j1 = 0;
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else { minv[j] -= delta; }
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }
  const rowToCol = new Array<number>(n).fill(-1);
  for (let j = 1; j <= n; j++) if (p[j] > 0) rowToCol[p[j] - 1] = j - 1;
  return rowToCol;
}

export interface AssignmentResult {
  /** [rowIndex, colIndex] pairs actually selected (positive weight only). */
  pairs: [number, number][];
  total: number;
}

/**
 * weights[r][s] = utility of giving resource r to slot s, or null when infeasible.
 * Returns the optimal set of pairs (exact).
 */
export function maxWeightAssignment(weights: (number | null)[][], slotCount?: number): AssignmentResult {
  const R = weights.length;
  const S = slotCount ?? (weights[0]?.length ?? 0);
  if (R === 0 || S === 0) return { pairs: [], total: 0 };
  const n = R + S;
  // Larger than any achievable total, so an infeasible pair is never part of an optimum.
  let maxAbs = 1;
  for (const row of weights) for (const w of row) if (w !== null && Number.isFinite(w)) maxAbs = Math.max(maxAbs, Math.abs(w));
  const BIG = maxAbs * (n + 1) * 10 + 1;
  const cost: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row = new Array<number>(n).fill(0);
    if (i < R) {
      for (let j = 0; j < S; j++) {
        const w = weights[i][j];
        row[j] = w === null || !Number.isFinite(w) || w <= 0 ? BIG : -w;
      }
    }
    cost.push(row);
  }
  const rowToCol = minCostAssignment(cost);
  const pairs: [number, number][] = [];
  let total = 0;
  for (let r = 0; r < R; r++) {
    const s = rowToCol[r];
    if (s >= 0 && s < S) {
      const w = weights[r][s];
      if (w !== null && w > 0) { pairs.push([r, s]); total += w; }
    }
  }
  return { pairs, total };
}
