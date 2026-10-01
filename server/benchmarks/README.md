# Allocation benchmark: legacy greedy vs global optimizer

> **Synthetic, scenario-based evaluation.** Incidents are generated; the fleet is the Mumbai demo
> fleet; road data is real OSRM output recorded once and replayed. These are **not** real-world
> emergency-response outcomes, and the demand policy / response targets are demo assumptions.

## Run

```
npm run bench:allocation                     # replay (deterministic, offline)
ROUTING_URL=https://router.project-osrm.org npx tsx server/scripts/benchmark-allocation.ts --record
```

- `fleet.json`: fleet and seeded blocked roads (snapshot of the demo database).
- `routing_fixture.json`: recorded OSRM travel-time matrix (49 points) and every route request the benchmark makes.
- `results.json`: full per-run results.

Two replays produce identical results (timings excluded).

## Methods

- **Legacy greedy (simultaneous)**: `resourceMatcher.ts` top-3 per incident, as if all incidents were recommended before any approval.
- **Legacy greedy (sequential)**: top-3 per incident in arrival order; approved units are marked dispatched before the next incident.
- **Global optimizer**: `allocation/optimizer.ts`.

All three are scored by the same evaluator. It uses road ETA (blocked-road aware), the shared demand slots, and credits a unit **only at its first assignment**; later uses of the same unit count as double bookings.

## Results (mean of 4 seeds per row)

`essCov` = risk-weighted % of essential slots filled · `rwUnmet` = risk-weighted unmet essential slots ·
`CRIT≤8` = % CRITICAL incidents whose first essential unit arrives within 8 min · `rwETA` = risk-weighted mean ETA of filled slots.

| Scenario | Method | essCov % | rwUnmet | CRIT≤8 % | rwETA min | cap. mismatch | double book | blocked |
|---|---|---|---|---|---|---|---|---|
| 5 incidents | greedy (sim.) | 53.9 | 2.19 | 100 | 5.8 | 3.0 | 4.75 | 0 |
| | greedy (seq.) | 68.2 | 1.39 | 100 | 6.1 | 5.0 | 1.25 | 0 |
| | **optimizer** | **96.4** | **0.16** | 100 | 8.8 | **0** | **0** | **0** |
| 10 incidents | greedy (sim.) | 38.5 | 6.75 | 66.7 | 7.0 | 4.25 | 16.0 | 0 |
| | greedy (seq.) | 36.8 | 6.86 | 35.8 | 7.3 | 7.0 | 11.75 | 0 |
| | **optimizer** | **83.5** | **1.93** | **77.5** | 8.8 | **0** | **0** | **0** |
| 15 incidents | greedy (sim.) | 22.7 | 12.45 | 60.4 | 5.6 | 6.5 | 29.25 | 0 |
| | greedy (seq.) | 23.2 | 12.41 | 20.8 | 8.7 | 8.25 | 24.5 | 0 |
| | **optimizer** | **65.9** | **5.56** | **100** | 7.5 | **0** | **0** | **0** |
| Scarce (half fleet out), 10 | greedy (sim.) | 17.7 | 7.79 | 18.8 | 6.7 | 5.5 | 18.75 | 1.75 |
| | greedy (seq.) | 13.6 | 8.06 | 18.8 | 8.6 | 7.25 | 13.75 | 4.25 |
| | **optimizer** | **47.4** | **5.14** | **93.8** | 8.8 | **0** | **0** | **0** |
| Blocked roads, 8 | greedy (sim.) | 32.3 | 5.00 | 87.5 | 6.5 | 4.5 | 11.5 | 1.0 |
| | greedy (seq.) | 47.8 | 4.13 | 75.0 | 8.7 | 6.5 | 7.25 | 1.0 |
| | **optimizer** | **83.3** | **1.58** | 87.5 | 9.3 | **0** | **0** | **0** |

The 3- and 8-incident rows and per-seed values are in `results.json`. Optimizer runtime was 0.6–13 ms per run on replayed routing (Hungarian solve at most 4.8 ms). Against live public OSRM, the first run on the demo database took about 9 s, dominated by route checks; cached re-runs took under 0.1 s.

**How to read `rwETA`:** it is *higher* for the optimizer because the optimizer fills far more slots, including ones only reachable by more distant units. Greedy's lower mean ETA comes from leaving most slots empty. Read it together with coverage.

## Straight-line (legacy) vs road ETA

Over 432 unit↔location pairs, the legacy estimate (straight line at 25 km/h) differs from OSRM road time by **12.1 min on average**. The median road/straight-line ratio is 0.55, meaning the legacy estimate is systematically pessimistic here. The **nearest unit by straight line is not the nearest by road in 15.3 %** of cases (72 type/location checks).

## Reallocation sequences (4 seeds)

Each sequence starts from an approved optimizer plan (15–17 assignments) and applies one event.
"Legacy" means no automatic reaction; for the new incident, legacy gives its top-3 recommendations.

- **Unit on the riskiest incident fails:**
  - The optimizer proposes 0–2 moves.
  - Coverage matches or exceeds no-action in 3 of 4 seeds; in 1 seed it is 0.3 pt lower. The objective is utility, not this coverage metric.
  - No explicit replacement was feasible in these seeds (fleet fully used), so the vacated slots were reported unmet.
- **Road on an active route blocked:**
  - In 3 of 4 seeds a detour was found and nothing changed.
  - In 1 seed, legacy kept 2 units on blocked routes, while the optimizer re-planned with 3 moves: coverage 93.8 % vs 75.8 %, 0 blocked assignments.
- **New CRITICAL incident:**
  - The optimizer serves it with 3–6 moves: coverage 66.8–89.9 % vs 48.6–70.5 % for legacy top-3.
  - Legacy produced 0–3 double bookings and 0–3 capability mismatches.

## Known evaluation caveats

- The evaluator maps a method's units onto slots greedily by arrival time. This occasionally reports 1 "capability mismatch" for an optimizer plan whose units were valid for the slots the optimizer chose. Hard constraints are verified separately by the unit tests.
- `essCov` / `rwUnmet` are evaluation metrics, not the optimizer's objective (which also values ETA, slot importance and scarcity).
