# JanRakshak — Complete Project Documentation

> AI-assisted emergency response and resource coordination for Mumbai.
> This document describes everything implemented in the prototype as of 28 Sep 2026: features, architecture, algorithms, data model, APIs, UI, testing, results and known limitations.
>
> **Guiding principle, enforced in code:** *AI recommends, humans decide.* Nothing is dispatched, cancelled or reassigned without a coordinator's approval.

---

## Table of contents
1. [Overview](#1-overview)
2. [How to run](#2-how-to-run)
3. [Technology stack](#3-technology-stack)
4. [Architecture and end-to-end flow](#4-architecture-and-end-to-end-flow)
5. [Users, roles and security](#5-users-roles-and-security)
6. [Report intake and AI extraction (Gemini)](#6-report-intake-and-ai-extraction-gemini)
7. [ML risk assessment (XGBoost)](#7-ml-risk-assessment-xgboost)
8. [Dataset and controlled augmentation](#8-dataset-and-controlled-augmentation)
9. [Location resolution](#9-location-resolution)
10. [Duplicate detection and merging](#10-duplicate-detection-and-merging)
11. [Incident workflow and escalation](#11-incident-workflow-and-escalation)
12. [Demand model (resource requirements)](#12-demand-model-resource-requirements)
13. [Global resource allocation optimizer](#13-global-resource-allocation-optimizer)
14. [Road routing and blocked roads](#14-road-routing-and-blocked-roads)
15. [Dynamic re-optimization and reallocation](#15-dynamic-re-optimization-and-reallocation)
16. [Coordinator approval and safety checks](#16-coordinator-approval-and-safety-checks)
17. [Field unit experience](#17-field-unit-experience)
18. [Citizen reporting and live tracking](#18-citizen-reporting-and-live-tracking)
19. [Real-time updates (Socket.IO)](#19-real-time-updates-socketio)
20. [Notifications, audit trail, predictions and impact analysis](#20-notifications-audit-trail-predictions-and-impact-analysis)
21. [Frontend and UI](#21-frontend-and-ui)
22. [Database schema and migrations](#22-database-schema-and-migrations)
23. [REST API reference](#23-rest-api-reference)
24. [Configuration (environment variables)](#24-configuration-environment-variables)
25. [Testing, verification and benchmarks](#25-testing-verification-and-benchmarks)
26. [Project structure](#26-project-structure)
27. [Known limitations and honest caveats](#27-known-limitations-and-honest-caveats)
28. [Future work](#28-future-work)
29. [Glossary](#29-glossary)

---

## 1. Overview

**The problem.** In a large city, emergency reports arrive in many languages and through many channels (phone, social media, field units, citizens). The same incident is often reported many times, locations are vague ("near Sai Baba Mandir"), and coordinators must decide within minutes which of a limited set of units goes where. Sending the nearest unit to each incident one at a time wastes scarce units and can leave critical incidents without help.

**What JanRakshak does:**

| Capability | Summary |
|---|---|
| Multilingual intake | English, Hindi, Marathi and mixed reports by text or voice. Gemini extracts structured facts, with a keyword fallback if Gemini is unavailable. |
| ML risk assessment | An XGBoost model classifies risk (Critical/High/Medium/Low) from the extracted evidence and produces a 0–100 risk score. |
| Location resolution | Scores several geocoder candidates, is limited to Mumbai, detects ambiguous names, reconciles with GPS, and records precision and confidence. A coordinator can verify or correct the location. |
| Deduplication | Scores each new report against all nearby active incidents and then merges it, flags it for review, or creates a new incident. It is protected against races and retries. |
| Demand model | Turns each incident into concrete unit requirements ("slots"), for example 2 fire trucks with hazmat and 1 ambulance. |
| Global optimizer | Assigns units to requirements across all incidents at once, using the Hungarian algorithm with risk-weighted utility. |
| Road-aware routing | Uses OSRM road ETAs, detects blocked roads and finds detours. It never falls back to straight-line distance. |
| Dynamic reallocation | Re-plans when conditions change and proposes moves, replacements and backfills. |
| Human oversight | Every proposal needs coordinator approval, is checked for staleness at approval time, and is audit-logged. |
| Field units | Mobile page for status updates, road route and ETA, and live GPS sharing. |
| Citizen side | No-login reporting, a short tracking ID, and a live public-safe tracking page. |
| Command Center UI | Map-first dashboard: priority queue, response overview, decision-support panel. |

**Scope:** one city (Mumbai) and five incident types: `fire`, `flood`, `building_collapse`, `gas_leak`, `road_accident`.

---

## 2. How to run

```bash
npm install          # install dependencies
npm run dev          # starts Vite (frontend, :5173) + Express API (:3001) together
```
Open **http://localhost:5173**. `/api` calls are proxied to port 3001.

- **Database:** embedded PGlite (Postgres in-process). It is created and migrated automatically on first start, and seeded with a Mumbai demo scenario when there are no users (development mode only).
- **Demo accounts** (from seed; change them before real use):

| Role | Username | Password |
|---|---|---|
| Admin | `admin` | `Admin@12345` |
| Coordinator | `coordinator` | `Coord@12345` |
| Field unit | `field` | `Field@12345` |

- **Citizen pages (no login):** `/public-report` and `/track/:incidentId`.
- **Other commands:**

| Command | Purpose |
|---|---|
| `npm run build` then `npm start` | Production build, then serve it from Express |
| `npm run seed` | Reset to fresh demo data (**deletes current data**) |
| `npm run create-admin` | Create an admin account |
| `npm run typecheck` | TypeScript checks for frontend and server |
| `npm run verify:risk-model` | XGBoost parity check against Python |
| `npm run test:risk` | Risk integration tests |
| `npm run test:allocation` | Hungarian solver, optimizer and allocation database tests |
| `npm run test:location-dedup` | Location, dedup and integration tests |
| `npm run bench:allocation` | Synthetic allocation benchmark |

---

## 3. Technology stack

| Layer | Technology |
|---|---|
| Frontend | React 19, TypeScript, Vite, Tailwind CSS v4, Zustand (state), react-router 7, react-leaflet 5 / Leaflet 1.9, lucide-react icons |
| Backend | Node.js, Express 5, TypeScript (run with `tsx`) |
| Database | PGlite (embedded Postgres) by default; any PostgreSQL via `DATABASE_URL` |
| Real time | Socket.IO: an authenticated staff channel and an anonymous `/public` namespace |
| AI extraction | Google Gemini (JSON output, model fallback chain) plus a keyword/regex fallback classifier |
| ML | XGBoost (trained in Python) evaluated **in TypeScript** inside the server; no Python needed at runtime |
| Geocoding | OpenStreetMap Nominatim (1 request/s queue, cached) plus an offline Mumbai area list |
| Routing | OSRM (`ROUTING_URL`) behind a provider abstraction |
| Maps | OpenStreetMap tiles, dark-themed with a CSS filter |
| Offline | IndexedDB queue for reports (staff intake), and a service worker in production |
| Security | scrypt password hashing, HS256 JWT in an httpOnly SameSite=strict cookie, role guards, login lockout, rate limits |

---

## 4. Architecture and end-to-end flow

```
Citizen / staff report (text or voice, any language, optional GPS)
        │
        ▼
Gemini evidence extraction  ──(fails or no key)──►  keyword classifier
        │  structured facts + location wording
        ▼
Location resolution (candidates → scoring → Mumbai scope → GPS reconciliation → precision/confidence)
        │
        ▼
Deduplication (transaction + advisory lock) ──► merge into existing │ flag for review │ new incident
        │
        ▼
ML risk assessment (XGBoost → class probabilities → risk score → priority)
        │
        ▼
Demand model (incident → unit requirement slots)
        │
        ▼
Global allocation (feasible candidates → road ETA matrix → utility → Hungarian → route verification)
        │  proposals only ("recommended")
        ▼
Coordinator approval (staleness checks, forced-reassignment confirmation) ──► dispatch
        │
        ▼
Field response (en route → arrived; live GPS) ──► citizen tracking updates live
        │
        ▼
Situation changes (new incident, road blocked, unit freed, escalation, location corrected…)
        │
        ▼
Dynamic re-optimization ──► move / replacement / backfill proposals ──► approval
        │
        ▼
Resolution ──► post-incident review ──► closed
```

**Server layout:** `routes/` (HTTP handlers), `services/` (domain logic), `services/allocation/` (demand, candidates, utility, Hungarian, optimizer, allocation runs, approval, re-optimization), `migrations.ts`, `realtime.ts`, `scheduler.ts`.

**Change propagation:** a `ChangeSet` collects the incidents, resources and assignments touched in a transaction. After commit, `publish()` broadcasts them over Socket.IO, so every open dashboard updates without refreshing.

---

## 5. Users, roles and security

### Roles
| Role | Can do |
|---|---|
| `admin` | Everything, including user management (`/admin/users`), deleting incidents, and acting for any field unit (mark en route/arrived) |
| `coordinator` | Command Center, reports, approvals, location verification, duplicate review, blocked roads, incident workflow |
| `field_reporter` | Field unit page for **their own** linked unit only: en route/arrived, live GPS; can also file reports. **Cannot** approve dispatches or complete incidents. |

Permissions are enforced **on the server** (`requireAuth`, `requireRole`), not just by hiding buttons.

### Authentication
- **Passwords:** scrypt (N=16384, r=8, p=1, 16-byte salt), compared in constant time. Minimum 8 characters.
- **Sessions:** HS256 JWT in the `jr_session` cookie (httpOnly, SameSite=strict, Secure in production), valid for 12 hours.
  - Every request checks that the user is still active and that the token's `session_version` matches the database. A password change or deactivation therefore signs the user out everywhere.
- **Secret:** `JWT_SECRET` (at least 32 characters) is required in production. In development a temporary random secret is used.
- **Login lockout:** 10 failed attempts within 15 minutes returns 429.
- **Security headers:** `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`; JSON bodies are capped at 100 kB.
- **Public report rate limit:** 8 reports per IP per 10 minutes, then 429.
- **Socket.IO:** the staff channel requires a valid session cookie. The public namespace only ever sends the public-safe incident view.

---

## 6. Report intake and AI extraction (Gemini)

**Channels:**
- Staff intake page (`/report`): source can be phone, social media, field unit, voice or manual; with voice input and "attach GPS".
- Citizen page (`/public-report`).
- Offline staff reports are queued in IndexedDB and synced automatically when back online (see §21).

**Gemini extraction** (`services/classifier.ts`):
- **Model chain:** `GEMINI_MODEL` (default `gemini-3.8-flash`), then `GEMINI_FALLBACK_MODELS` (default `gemini-3.6-flash, gemini-3.5-flash-lite`). The next model is tried on timeouts, 429 or 5xx errors.
- **Request settings:** temperature 0.1, JSON response type, 20 s timeout.
- **Extracted fields:**
  - incident type, title, description, language (en/hi/mr);
  - people affected, injuries, trapped;
  - children, elderly or disabled present;
  - hazard flags: fire, flood, earthquake, storm, building damage;
  - search and rescue, medical emergency, urgency flag and urgency indicators;
  - location fields: original wording, place, locality, city, state;
  - a rough lat/lng hint only, never used as ground truth.
- **Validation:** all output is clamped and checked. An unknown incident type is rejected, and the keyword fallback is used instead.

**Keyword fallback classifier:**
- Used when there is no `GEMINI_API_KEY` or Gemini fails.
- Regex and keyword matching in English, Hindi (Devanagari and romanized) and Marathi, for type, counts, vulnerable groups, hazards, rescue, medical and urgency.
- Uses the offline Mumbai area list for location. The system keeps working with no AI provider.

**Evidence convention** (shared with the ML model): `0` = no evidence, `-1` = present but count unknown, `N` = explicit count.

---

## 7. ML risk assessment (XGBoost)

**Separation of concerns:** Gemini (or keywords) only **extracts evidence**. The trained model makes the **risk judgement**, so an LLM never decides priority.

### Model
- **Type:** XGBoost multi-class (`multi:softprob`), 4 classes. Output order follows the label encoder: `CRITICAL, HIGH, LOW, MEDIUM`.
- **15 features, in this exact order:** `incident_type, people_affected, injured, trapped, children, elderly, disabled, fire, flood, earthquake, storm, building_damage, search_rescue, medical_emergency, urgency_indicators`.
- **`incident_type` is derived from the evidence** by the same fixed priority rule used in training: earthquake → fire → flood → storm → building_collapse → medical → search_rescue → other/unknown. It is label-encoded alphabetically.
- **File:** `server/ml/janrakshak_xgb_model.json`, loaded once at start-up. The loader validates the objective, class count, feature count and feature names, and refuses any format it can't evaluate exactly.
- **In-process inference:** the trees are evaluated in TypeScript (`riskModel.ts`), so no Python service is needed.
- **Parity:** verified identical to Python XGBoost's `predict_proba` on all 994 test rows (`npm run verify:risk-model` prints "PARITY OK").

### Score and priority
- **Risk score** = P(Critical)×95 + P(High)×70 + P(Medium)×45 + P(Low)×20, rounded (0–100).
- **Model class** = the class with the highest probability.
- **Operational priority** starts from the model class and score. Escalation (§11) can raise the operational priority later, but the original model assessment is kept for display and audit.
- **Stored** in `incidents.risk_assessment` (JSONB): status, model class, score, probabilities, evidence, human-readable factors, evidence source (`gemini`/`keyword`/`merged`), number of reports combined, model version and timestamp.
- **If the model can't run**, `status: "unavailable"` is stored with a reason, a default safety priority is applied, and the UI tells the coordinator to assess manually.
- **On merge:** evidence from all merged reports is combined (known counts beat unknown ones, the larger count wins, flags are OR-ed) and risk is re-assessed. **Priority is never lowered by a merge.**

### Reported accuracy (honest framing)
- **95.57%** test accuracy on the generated evaluation set.
- The labels come from a deterministic rubric over the same features (§8), so the model reproduces that rubric. It is **not a validated real-world severity predictor**, and the UI says so.

---

## 8. Dataset and controlled augmentation

Location: `../JANRAKSHAK/JANRAKSHAK/` (delivered as `JANRAKSHAK_v2_controlled_augmentation.zip`).

### Base data
- **Source:** Figure-Eight/Appen disaster response messages (test split, 2,629 rows). Evidence was extracted to the 15 features, leaving **2,618** usable original rows.
- **Labels are weak supervision** from a documented rubric (`risk_labeling_rubric.md`), not human expert annotation.

### Labelling rubric (additive points, capped at 100)
| Evidence | Points |
|---|---|
| Trapped | −1 → 15; N → min(4N, 24) |
| Injured | −1 → 12; N → min(2.5N, 22) |
| People affected (bucketed) | −1 → 6; 1–9 → 4; 10–99 → 8; 100–999 → 14; ≥1000 → 20 |
| Children / elderly / disabled | +8 each |
| Fire / earthquake / flood / storm | +10 / +10 / +8 / +7 |
| Search & rescue / building damage / medical / urgency | +10 / +8 / +7 / +8 |

**Class thresholds:** 0–24 LOW, 25–49 MEDIUM, 50–74 HIGH, 75–100 CRITICAL.

### Problem: extreme imbalance
The original data was 97.7% LOW, with only **2 HIGH and 2 CRITICAL** rows.

### Controlled augmentation (reproducible: seed 42, `generate_controlled_scenarios.py` + `validate_augmented_dataset.py`)
- **Size:** 3,998 new synthetic scenarios in 1,100 scenario families, for **6,616 rows** in total.
- **Faithfulness check:** the generator re-implements the rubric and the incident-type rule, and refuses to run unless it reproduces all 2,618 original rows exactly. It did, with 0 mismatches.
- **Families:** each family is one coherent situation with up to four severity variants (plus borderline and contrastive variants). Features are correlated by category; for example, trapped people trigger search-and-rescue 85% of the time.
- **Labels are never hand-assigned:** the rubric computes them. Rejection sampling (52,050 draws) keeps a draw only when the rubric independently puts it in the intended class.
- **Other safeguards:**
  - realistic rounded counts with per-subtype caps;
  - "unknown count" (−1) used in about 10–15% of present counts;
  - no duplicate feature vectors;
  - audit-only columns (family id, origin, description, message) are never used as model features.
- **Class distribution after augmentation:**

| Class | Share | Rows |
|---|---|---|
| LOW | 46.2% | 3,057 |
| MEDIUM | 21.7% | 1,438 |
| HIGH | 18.0% | 1,192 |
| CRITICAL | 14.0% | 929 |

  (LOW was 97.7% before; HIGH and CRITICAL were 2 rows each.)
- **Splits:** group-aware (StratifiedGroupKFold by family), so near-duplicate variants never leak between splits.

| Split | Rows |
|---|---|
| Train | 4,625 |
| Validation | 997 (~140 CRITICAL) |
| Test | 994 (~140 CRITICAL) |

- **Files:** `janrakshak_risk_{train,validation,test}_v2.csv`, `janrakshak_risk_combined.csv`, `controlled_augmentation_report.md`, `augmentation_validation_results.json`, `train_xgboost_risk.py`, `janrakshak_xgb_model.json`.

---

## 9. Location resolution

Implemented in `services/locate.ts`; this is the only geocoding system in the app.

### Pipeline
1. **Geocoder candidates:** Nominatim is queried with "place, locality" and then "place" (plus a city hint), with `limit=8` and address details. Requests are restricted to the Mumbai Metropolitan Region.
2. **Candidate scoring** combines:
   - name similarity (token containment, with a synonym map);
   - locality match;
   - result kind (point > road > area);
   - distance to the reporter's GPS, when present;
   - weakly, distance to Gemini's rough estimate;
   - geocoder importance.
3. **Mumbai scoping:** candidates are filtered by address city/district (Greater Mumbai box as a fallback). Navi Mumbai, Thane and Mira-Bhayandar are allowed **only if the report names them**.
4. **Ambiguity detection:** if two well-scored candidates are far apart and within 0.12 score of each other (for example several "Sai Baba Mandir"), the location is marked **ambiguous/unverified** instead of guessed. Accurate GPS near one candidate resolves it.
5. **GPS reconciliation:**
   - accurate GPS (≤150 m) is used when the text can't be placed, or when it lies inside the named area;
   - GPS agreeing with the text (≤400 m) raises confidence;
   - a conflict (>1.5 km) with a strong exact text match is **flagged**, not silently overridden.
6. **Fallback chain**, in order:
   1. exact/approximate text match;
   2. accurate GPS;
   3. area level (geocoder locality, else the offline area list);
   4. rough GPS;
   5. Gemini estimate, flagged `ai_estimate` (confidence 0.15, ±3 km);
   6. an unverified city-centre placeholder.

### Precision classes and provenance
- **Precision:** `verified` (coordinator-confirmed), `exact`, `approximate`, `area`, `ai_estimate`, `unverified`.
- **`location_meta` (JSONB, per incident and per report)** records:
  - precision, confidence, accuracy (m), source (geocoder / reporter GPS / gazetteer / AI estimate / city centre / coordinator);
  - original text, structured fields and matched query;
  - result type, ambiguity flag and the top 6 candidates with scores and reasons;
  - Gemini's original estimate, the reporter's GPS and its accuracy, GPS consistency;
  - notes, geocoder error, and the verification record.
- **Legacy `location_source` values:** `geocoded`, `reporter_gps`, `landmark`, `ai_estimate`, `unverified`, kept for compatibility.
- **Reliability weights** used by dedup: verified 1.0, exact 0.95, approximate 0.65, area 0.3, AI estimate 0.15, unverified 0.05 (ambiguous → at most 0.3).
- **Tunable thresholds** (`LOCATION_CONFIG`):

| Setting | Value |
|---|---|
| Accurate GPS | 150 m |
| GPS consistent | 400 m |
| GPS conflict | 1,500 m |
| Distinct place | 1,000 m |
| Exact minimum score | 0.62 (name ≥ 0.6) |
| Approximate minimum score | 0.45 |
| Ambiguity margin | 0.12 |

### Public vs. staff rules
- **Citizen reports** that resolve only to `unverified` or `ai_estimate` are rejected with **422 `location_required`**, with a specific message for ambiguous names ("Several places match…"). Nothing is stored.
- **Staff reports** are accepted but flagged **"Verify location"** in the UI.

### Coordinator verification and correction (`PATCH /api/incidents/:id/location`)
- **Actions:** `verify` (confirm as-is), `correct` (new lat/lng and optional name), `choose_candidate` (pick one of the recorded candidates). An optional note can be added.
- **Effect:** precision becomes `verified` and confidence 1.0; the change is audited (`location_verified` / `location_corrected`, from → to).
- **Follow-up:** a duplicate re-check runs at the new position. A possible duplicate is flagged and the coordinator notified, but **never auto-merged**. Re-optimization is triggered.

---

## 10. Duplicate detection and merging

Implemented in `services/deduplication.ts` and `services/incidentMerge.ts`.

### Candidates
Active incidents within a search radius whose **last report** was within 6 hours. Using recent activity, not creation time, keeps long-running incidents mergeable.

### Score (0–1)
```
score = hazard_compatibility ×
        (0.30·spatial·(0.3 + 0.7·reliability) + 0.20·place_name + 0.15·text + 0.10·evidence + 0.25·recency)
        + reporter-GPS adjustment
```
- **Spatial** similarity accounts for both locations' accuracy radii.
- **Reliability** comes from location precision (§9).
- **Recency** decays with τ = 120 min since the last report.
- **Hazard compatibility:**

| Pair | Weight |
|---|---|
| Same type | 1.0 |
| Fire ↔ gas leak | 0.85 with fire evidence, else 0.6 |
| Collapse ↔ fire | 0.8 / 0.4 |
| Collapse ↔ gas leak | 0.75 / 0.3 |
| Collapse ↔ flood | 0.6 / 0.2 |
| Fire ↔ road accident | 0.6 / 0.2 |
| Anything else | 0 (never merged) |

### Vetoes (always a new incident)
- incompatible hazards;
- stale (no report for more than 360 minutes);
- the same place name more than 1.5 km apart (different temples with the same name);
- too far apart (more than 3 km plus the accuracy radii).

### Capped at "review" (never auto-merged)
- either location has low reliability (< 0.5), so two unrelated reports that both fell back to the same area centre can't merge;
- two precisely located, differently named places more than 150 m apart;
- two near-equal merge targets.

### Decision
| Score | Result |
|---|---|
| ≥ 0.72 | **Merge** |
| 0.45 – 0.72 | **New incident flagged for review** (`dedup_review` pending, `possible_duplicate` audit entry, coordinator notified) |
| < 0.45 | **New incident** |

The best-scoring candidate decides, not the first one found.

### What a merge does
- **Evidence:** combines the incident's evidence and re-runs the risk assessment (priority never lowered).
- **Counts and flags:** updates corroborating reports, confidence, people affected and injuries (larger value wins), vulnerable flags (OR), urgency (union) and `last_report_at`.
- **Location:** refined only if the new report is at least 0.2 more reliable and consistent.
- **Allocation:** if risk or demand changed, re-optimization is triggered.
- **Audit:** a `merged` entry records the report, target, score, reasons, model class and priority before/after, whether demand changed, and whether the location was refined.

### Race condition and idempotency
- **Race:** candidate search, decision and create/merge all run in **one transaction under a Postgres advisory lock** (`pg_advisory_xact_lock(7224002)`). A test shows three identical simultaneous reports produce exactly one incident; the old pattern produced three.
- **Idempotency:** every report carries a `client_id` (unique in the database).
  - A retry returns the original result (`200`, `already_processed`) **before** calling Gemini.
  - A concurrent duplicate insert (unique violation 23505) is caught and answered the same way, so offline-queue retries never create duplicates or false failures.

### Coordinator duplicate review (`POST /api/incidents/:id/duplicate-review`)
- **`separate`:** marks the review dismissed (audit entry `duplicate_dismissed`).
- **`merge` + `target_incident_id`:**
  - runs under the same advisory lock, and both incidents must be active and not already merged;
  - refused with 409 `incident_has_units` if the source still has units assigned;
  - withdraws the source's pending proposals, moves its reports to the target and merges the evidence;
  - resolves the source and sets its `parent_incident_id` to the target.
  - **Citizens tracking the absorbed incident keep receiving updates from the canonical one.**

---

## 11. Incident workflow and escalation

### Incident statuses and allowed transitions
```
triage      → dispatched, resolved
dispatched  → on_scene, resolved
on_scene    → contained, resolved
contained   → on_scene, resolved
resolved    → closed, triage (reopen)
closed      → (final)
```
- `dispatched` requires at least one active unit.
- `closed` requires a **post-incident review** (summary required; "went well" and "improve" optional).
- `resolved` completes all active assignments, rejects pending proposals and frees the units.
- Assignment events move the incident automatically: dispatch → `dispatched`, arrival → `on_scene`. These changes are audit-logged as automatic.

### Assignment statuses
```
recommended → dispatched, rejected
dispatched  → en_route, arrived, completed, rejected(cancel)
en_route    → arrived, completed, rejected(cancel)
arrived     → completed
```
Unit status follows the assignment: dispatched → `dispatched`, en route → `en_route`, arrived → `on_scene`; completed/rejected → freed.

### Escalation (scheduler, every 30 s)
**Deadlines by type:**

| Type | Deadline |
|---|---|
| Building collapse | 20 min |
| Gas leak | 30 min |
| Road accident | 40 min |
| Fire | 45 min |
| Flood | 60 min |

**When an incident in `triage` or `dispatched` passes its deadline:**

| Current priority | Escalates to |
|---|---|
| Low | Medium (score ≥ 40, +25) |
| Medium | High (≥ 70, +20) |
| High | Critical (≥ 90, +15) |
| Critical | Critical, +5 (up to 100) |

- The deadline is reset, an `escalated` audit entry is written and everyone is notified.
- **Re-optimization is triggered**, because priority feeds the optimizer.
- The ML assessment is preserved; the UI notes "escalated after the model assessment".

---

## 12. Demand model (resource requirements)

Implemented in `allocation/demand.ts` (`buildIncidentDemand`); pure and deterministic.

**Base policy by type and priority** (count × unit; *required capabilities*; ~preferred; "support" = non-essential):

| Type | Low | Medium | High | Critical |
|---|---|---|---|---|
| Fire | 1 fire truck *fire_suppression* | + 1 ambulance (support) | 2 trucks, 1 ambulance, 1 police (support) | 3 trucks (~ladder), 2 ambulances, 1 police (support) |
| Flood | 1 police | 1 police (~evacuation), 1 ambulance (support) | 2 police, 1 ambulance, 1 road crew (~pumping, support) | 2 police, 2 ambulances, 1 fire truck *rescue*, 1 road crew (support) |
| Building collapse | 1 fire truck *rescue* | + 1 ambulance | 2 trucks *rescue*, 1 ambulance, 1 police (support) | 2 trucks *rescue*, 2 ambulances, police + road crew (~debris_clearing) (support) |
| Gas leak | 1 fire truck *hazmat*, 1 police (support) | 1 truck *hazmat*, 1 police (~evacuation) | + 1 ambulance | 2 trucks *hazmat*, 1 police, 1 ambulance |
| Road accident | 1 police (~traffic) | 1 ambulance, 1 police (support) | 2 ambulances, 1 police, 1 road crew (support) | 2 ambulances, 1 police, 1 fire truck *rescue*, 1 road crew (support) |

**Evidence adjustments:**
- **Trapped / search-and-rescue:** a fire truck with *rescue* becomes essential.
- **Fire evidence on a non-fire incident:** adds a fire-suppression truck.
- **Casualties:** ambulances sized at 2 patients per ambulance (maximum 4). Each ambulance slot carries its patient count (`capacity_need`), and more than 2 injured prefers *advanced_life_support*.
- **Large flood (≥ 100 affected, or unknown):** adds an evacuation police unit and records the shelter need.

**Slot importance:** the first essential unit of a type = 1.0; each extra unit ×0.6; support types ×0.6.

**Read-only API:** `GET /api/incidents/:id/demand` (staff only) returns the slots and shelter need without creating anything. The "Required response" panel uses it.

---

## 13. Global resource allocation optimizer

Implemented in `services/allocation/`.

### Steps of an allocation run (`runOptimization`)
1. **Snapshot:**
   - active incidents, resources, current commitments (dispatched/en route/arrived);
   - recent coordinator rejections (a rejected pair is not re-proposed for **15 minutes**);
   - blocked roads.
2. **Demand:** build slots for every active incident. Slots already covered by a committed unit stay pinned to it.
3. **Candidates (hard constraints):**
   - right unit type and all *required* capabilities;
   - enough free seats for transport slots;
   - known position and not unavailable;
   - "arrived" units are locked to their incident.
4. **Road ETA matrix:**
   - OSRM table for all candidate × incident pairs (cached for 10 minutes);
   - the unit's position is live GPS if updated within 2 minutes, otherwise its last known position;
   - pairs beyond 60 minutes by road are infeasible.
5. **Utility for every feasible pair** (`utility.ts`):
   ```
   U = R · π · (0.7·T + 0.3·F) − 0.05·scarcity
   ```
   | Term | Meaning |
   |---|---|
   | R = (priority_score/100)² | Risk weight; γ=2 makes critical incidents dominate |
   | π | Slot importance |
   | T | Time value: 1 if ETA ≤ target, else exp(−(ETA−target)/target). Targets: critical 8, high 12, medium 20, low 30 min |
   | F | Capability fit (preferred capabilities) × capacity fit (seats vs. need) |
   | Scarcity | 1 − available/demanded for that unit type, in [0,1] |
6. **Moves (reassignment cost M):**
   - dispatched: 0.05;
   - en route: 0.1 + 0.2 × progress;
   - arrived: never.
   - Every move must also clear a minimum improvement of 0.05, so each move pays for itself and units don't bounce between incidents.
7. **Solve:** an exact **Hungarian (maximum-weight) assignment** over slots × units, maximising Σ(U − M). Dummy rows and columns let slots go unfilled when nothing is feasible.
8. **Route verification loop** (up to 12 iterations):
   - each chosen pair's actual route is checked against blocked roads;
   - infeasible pairs are removed and the problem re-solved;
   - chosen units are re-pinned by ETA.
9. **Destination hospital** for ambulance slots: a hospital with emergency/trauma capability and free beds (fire incidents prefer a burn unit). A warning is recorded if none is available.
10. **Persist:** proposals are written as `recommended` rows with an `allocation` JSONB record:
    - run id, trigger, kind (`new`/`move`/`replacement`/`backfill`), slot;
    - incident risk and utility breakdown;
    - ETA (minutes, distance, source, route type, whether GPS was fresh);
    - the assignment it replaces, the incident it moves from, and the assignment it backfills;
    - destination, alternatives considered (top 4), blocked-road version, mode and degraded flag.
    Old proposals no longer in the plan are withdrawn; unchanged ones are updated in place. Notifications go out for new reallocation proposals.
11. **Degraded mode:** if routing is unavailable, the run is marked **DEGRADED** and **no proposals are made** (`/recommend` returns 503 `routing_unavailable`). There is never a straight-line fallback.

**Performance:** a full city plan takes about 3–7 ms in the benchmark; road lookups are the slow part, and they're cached.

**Manual override:** `POST /api/assignments` creates a normal `recommended` row for a unit the coordinator picked (the "Choose unit…" picker). It still needs approval and passes all checks.

**Legacy recommender:** `resourceMatcher.ts` (the old "top 3 nearest") is kept unchanged as a baseline for the benchmark. Proposals made by it before the optimizer existed appear as "Earlier recommendation".

---

## 14. Road routing and blocked roads

Implemented in `services/routing.ts`; shared by the optimizer, the map and the field page, so everyone sees the same ETA.

- **Provider abstraction:** `OsrmProvider(ROUTING_URL)`, 8 s timeout. It can be swapped (for example to Valhalla) without touching the optimizer.
- **Cache:** 10 minutes, up to 20,000 entries. Points are rounded to about 11 m so GPS jitter reuses cached results.
- **Blocked roads** (`blocked_roads` table, `POST/DELETE /api/blocked-roads`):
  - coordinators draw them on the map (two points, road name, reason, optional link to an incident);
  - they appear as red dotted lines, and can be removed from their popup with a confirmation.
- **Blocked-route detection:** the route geometry is sampled every ~20 m. A route counts as using a blocked segment if it runs along it for at least 80 m (or half its length) within 35 m. Merely crossing it doesn't count.
- **`verifiedRoute`:** fastest route → OSRM alternatives → detour via waypoints beside the blocked segment → otherwise **blocked (infeasible)**. The detour search is a heuristic; misses are reported, never hidden.
- **Blocked-road version:** a hash of the active blocks. Proposals record it, and approval rejects a proposal computed before the blocks changed.
- **No straight-line fallback anywhere:** when routing fails, callers get `RoutingUnavailableError` and report a degraded state.
- **Benchmark evidence:** straight-line estimates (the legacy 25 km/h assumption) were off by 12.1 minutes on average across 432 pairs, and picked a different "nearest" unit in 15.3% of cases.

---

## 15. Dynamic re-optimization and reallocation

Implemented in `allocation/reoptimize.ts`.

**Triggers:**
- a new incident, or a merged report that changed risk or demand;
- escalation;
- a road blocked or cleared;
- a resource freed, or a coordinator decision;
- an incident's location corrected, or a duplicate review decided;
- from the scheduler: stale GPS, an infeasible route or ETA drift (see below).

**How runs are scheduled:** triggers are debounced (1.5 s) and runs are serialized, so two plans never run at once.

**Scheduler watch on units travelling (every 30 s):**
- **GPS stopped:** an en-route unit's GPS stops for more than 5 minutes → re-plan.
- **Route blocked:** the live route becomes blocked → re-plan (the assignment is infeasible).
- **ETA drift:** the remaining road ETA exceeds the plan by more than 10 minutes → re-plan.
- Each issue is flagged once per 10 minutes, so a stuck unit doesn't flood the system.

**Proposal kinds:**
| Kind | Meaning |
|---|---|
| `new` | An available unit for an open requirement |
| `move` | A committed unit is moved to a more critical incident, only if the gain beats reassignment cost + minimum improvement |
| `replacement` | The current assignment for a requirement is no longer feasible (e.g. blocked route); approving closes it |
| `backfill` | Covers an incident whose unit is proposed to move elsewhere |

In the UI these appear as a **"Response change proposed"** card (§21).

---

## 16. Coordinator approval and safety checks

Implemented in `allocation/approval.ts` and `workflow.ts`. Approving a proposal = PATCH the assignment to `dispatched`.

**Checks when a proposal is approved:**
- the unit still has the required capabilities and enough free seats;
- road blocks haven't changed since the plan was computed;
- for a move, the unit is still on the assignment the move was planned from.

If anything is stale, the approval is refused with a clear message.

**Other rules:**
- **Busy unit:** approving a unit committed elsewhere returns 409 `resource_busy`. The UI shows a confirmation dialog, and only an explicit "Reassign anyway" sends `force: true`, which reassigns and audits it.
- **Database guard:** a unique partial index (`resource_one_active_assignment`) means one unit can never hold two active assignments, even under races.
- **Replacement:** approving a replacement closes the replaced assignment.
- **Transport load:** ambulance patient load and hospital beds are updated on dispatch and completion.
- **Audit:** every approval, rejection, cancellation, reassignment, arrival and completion is logged with the user.

---

## 17. Field unit experience

Page: `/field`; mobile-first.

- **Unit header:** unit name, type and status. Admins get an "Acting for unit" selector to update any unit that has a job.
- **Current assignment:** severity badge (text and colour), title, location, people affected and injured, and a warning if the location is only area-level or unverified.
- **ETA and distance:** from the live road route when the unit's position is known, otherwise the ETA estimated at dispatch.
- **Map and navigation:** a small map with the route, and **"Open navigation"** (Google Maps directions).
- **Status steps:** Assigned → En route → Arrived → Contained/Completed. The last step is set by the coordinator; field units cannot complete incidents.
- **One large primary action:** "Mark en route" → "Arrived at incident".
- **Share live location:**
  - GPS via `watchPosition`, sent at most every 10 s when the unit has moved 25 m or more, plus a heartbeat every 60 s;
  - accuracy is shown;
  - the unit is told to keep the screen open;
  - HTTPS is required by browsers.
- **Incident details:** description, vulnerable people and urgency indicators; no coordinator-only data.

---

## 18. Citizen reporting and live tracking

### Report page (`/public-report`, no login)
- **Location first:** "Attach my current location" (GPS plus accuracy, which is sent to the server), or type a building, street or landmark (appended to the message as "Location: …").
- **"What is happening?"** with voice input ("Speak instead of typing") and samples in English, Hindi and Marathi.
- **Optional contact details**, visible only to coordinators.
- **One `client_id` per attempt**, so a retry after a network error isn't counted twice. After a 422 a new id is used, because nothing was stored.
- **422 `location_required`:** shows the server's specific guidance; the message is kept.
- **Success screen:**
  - short **tracking ID** (first 8 characters) with copy-link;
  - "What happens next";
  - "Track this report";
  - if the report was merged: "Others have reported this emergency too."

### Tracking page (`/track/:id`)
- **Public-safe view only:** no reporter details, raw messages, unit names, AI scores or notes.
- **Contents:**
  - current-status banner and last update;
  - type and area (internal notes such as "(area: …)" are stripped);
  - "Help on the way" (unit type, status, ETA estimated at dispatch, live distance);
  - a small map with the incident and the unit's live position while it's en route with fresh, accurate GPS;
  - a timeline: Report received → Assessed → Assigned → En route → Arrived → Contained → Resolved;
  - "While you wait" safety tips per incident type.
- **"Response changed" notice** when the first unit was redirected to a more urgent emergency.
- **Live updates** via the `/public` Socket.IO namespace. The page refetches on reconnect and does no polling.
- **Merged incidents:** a merged report's link follows the canonical incident.
- **Deliberately not shown:** the internal risk score and severity (as required by the design brief), and route lines. The public API can't access routing, so the page shows no line rather than an invented one.

---

## 19. Real-time updates (Socket.IO)

- **Staff channel** (authenticated by the session cookie):
  - `change` events `{entity, action, data}` for incidents, resources, assignments, blocked roads and notifications;
  - the store applies them incrementally;
  - derived data (predictions, audit) is refetched with an 800 ms debounce;
  - a connection badge shows Live / Reconnecting / Offline.
- **Public namespace `/public`:**
  - clients `emit('track', incidentId)` to join a room;
  - the server sends `incident.status.updated` with the public-safe view;
  - updates are debounced (300 ms), deduplicated by payload, and sent only if someone is watching;
  - they are also sent to the rooms of incidents merged into it.
- **Account changes:** disabling a user or changing their role disconnects their sockets.

---

## 20. Notifications, audit trail, predictions and impact analysis

- **Notifications** (`notify.ts`):
  - stored and pushed live, types critical/warning/info/success;
  - shown in the notification bar, as toasts, and as optional desktop notifications;
  - per-user read state;
  - optional webhook (`NOTIFY_WEBHOOK_URL`, filtered by minimum level `NOTIFY_WEBHOOK_MIN_LEVEL`).
- **Audit trail:**
  - every state change is written to `audit_log` (entity, action, user, details JSON, time);
  - shown as the per-incident activity log and the global audit tab;
  - actions include `created_from_report`, `merged`, `merged_into`, `possible_duplicate`, `duplicate_dismissed`, `location_verified/corrected`, `ai_recommendation`, `allocation_run`, `approved`, `rejected`, `cancelled`, `reassigned`, `en_route`, `arrived`, `completed`, `status_changed`, `escalated`, `road_blocked`, `road_cleared`.
- **Resource exhaustion prediction** (`prediction.ts`):
  - per unit type: utilization, incident arrival rate over the last 6 hours, demand per incident from the same demand policy, projected minutes to exhaustion, risk level and a recommendation;
  - the scheduler notifies when a type's risk worsens to high or critical;
  - shown in the Forecast tab ("Resource burndown").
- **Impact propagation** (`impactPropagation.ts`): when an incident exists, it checks nearby resources and incidents within the affected radius × a type multiplier:

| Type | Multiplier |
|---|---|
| Gas leak | ×3 |
| Flood | ×2.5 |
| Fire | ×2 |
| Collapse | ×1.5 |
| Accident | ×1 |

  It flags compromised resources, overlapping incidents and cascade risks, shown under "Evidence & reports".

---

## 21. Frontend and UI

### Pages and routes
| Route | Who | Page |
|---|---|---|
| `/login` | Everyone | Sign-in |
| `/` | Admin, coordinator | **Command Center** |
| `/report` | All staff | Staff intake (multilingual AI intake, voice, source, GPS, offline queue) |
| `/field` | Field unit, admin | Field unit page |
| `/admin/users` | Admin | User management (create, edit roles, link unit, deactivate, reset password) |
| `/public-report` | Public | Citizen report |
| `/track/:incidentId` | Public | Citizen tracking |

### Design system (`components/ui/`)
- **Theme:** dark navy, with colours as Tailwind v4 theme tokens in `index.css`.
- **Severity colours:** Critical red, High orange, Medium yellow, Low cool slate-blue. Severity is **always shown with text** as well as colour.
- **Primitives:** Panel, SectionHeader, Button (primary/secondary/ghost/danger/success/warning; sm/md/lg), Badge, SeverityBadge, StatusBadge, LocationBadge, Stat, EmptyState, Callout (info/warning/danger/success), Collapsible, Segmented tabs, Spinner, LoadingBlock.
- **`useConfirm` dialog** replaces `window.confirm`; it is focus-managed and closes on Esc.
- **Accessibility:** visible focus rings, ARIA roles for tabs/switches/dialogs, reduced-motion support, and touch targets of at least 44 px on the citizen and field pages.

### Command Center (`/`)
- **Layout:**

| Screen | Layout |
|---|---|
| Desktop | 3 columns: Priority incidents (~19%) · Map (majority) · Response overview / Incident panel (~24%) |
| Tablet | Map plus one side panel with tabs |
| Mobile | Tabs: Incidents / Map / Response |

- **Status strip:** last update, active incidents, critical count, units ready, live-link state.
- **Header:** logo, Command Center / New report / Field unit / Users (by role), live badge, notifications, user and role, change password, sign out.

**Priority incidents (queue):**
- Sorted by priority, then risk score, then nearest escalation deadline.
- Tabs: Active / Resolved / Closed with counts.
- Filters: severity chips, search, and "Vulnerable: children/elderly/disabled".
- Each card shows:
  - severity (text badge + side bar), status, type, location, affected;
  - units responding + soonest ETA, report count, age;
  - tags: Reallocation proposed / Approval needed / Possible duplicate / Verify location / Dispatch or arrival overdue;
  - a yellow dot when action is needed.
- Clicking a card selects the incident and flies the map to it.

**Map (Leaflet, dark basemap):**
- **Incident markers** sized by severity; only Critical pulses. Uncertain locations get a dashed border, a "?" flag and a **dashed accuracy ring** showing the real accuracy radius. The selected marker is highlighted.
- **Unit markers:** available (green), responding (blue, LIVE badge with fresh GPS), out of service (grey).
- **Routes:** real road routes for moving units; the selected incident's routes are emphasised and its **proposed** routes drawn dotted.
- **Blocked roads** (red dotted) with popup and remove.
- **Toolbar:** "Block road" drawing tool, Layers menu (zones, units, routes, blocked roads), collapsible Legend.
- **Map-pick mode** for correcting an incident's location.
- **Heatmap removed entirely** (component, toggle, stored setting and dependency).

**Response overview (right panel when nothing is selected):**
- Stats: Action required, Awaiting approval, Units deployed, Units available.
- **Action required** list: reallocations, approvals, duplicates, location checks, overdue incidents.
- **Active responses:** each incident with its units, statuses and ETA.
- Tabs: **Resources** (units by type, hospital beds, shelter spaces), **Forecast** (escalation watch and resource burndown), **Audit**.

**Selected incident panel (decision support, collapsible sections in order):**
1. **Header:** short id, severity + score, type, title, location, status, location-quality badge if uncertain; Reported / Affected / Injured / Reports.
2. **Attention callouts:** deadline passed; **Possible duplicate** review (real similarity score and reasons, "Merge into this incident" with confirmation, "Keep as a separate incident"); "Coordinator approval required".
3. **AI risk assessment:** model score /100, class, class-probability bar, extracted evidence factors, "escalated after model" note, "the model supports triage; the coordinator decides", and the accuracy caveat.
4. **Location:** name, quality badge and explanation; source, accuracy, resolver confidence, reporter-GPS consistency and original wording. **Confirm current location**, **Other matches (N)** (candidates with match %), **Set on map**, with a current → new confirmation (name, note, distance moved).
5. **Status:** workflow stepper and allowed actions (Mark on scene, Contained, Resolve with confirmation, Close with review, Reopen).
6. **Required response:** every demand slot with Covered / Awaiting approval / Open / No unit available (with the optimizer's reason), a coverage bar, units beyond policy, and shelter need.
7. **Units & recommendations:**
   - **Recommend units / Re-plan** (runs the global optimizer). If routing is down: "Routing service unavailable — allocation recommendations are paused."
   - **Response change proposed** cards for move/replacement/backfill: current vs. proposed, reasons, impact (and any backfill), **Approve reallocation** / **Keep current**.
   - **Proposal cards:** unit, type, kind badge (New assignment / Reallocation / Replacement / Backfill / Manual proposal / Earlier recommendation), road ETA; **"Why this unit?"** (ETA and distance, route type, capability match, capacity fit, live vs. last-known position, scarcity, a plain-language reason, next-best alternative, destination hospital, optimizer detail on request); **Approve & dispatch** / **Reject**.
   - **Choose unit…** (manual picker): available units that meet an open requirement, sorted by real road ETA, flagged if already proposed elsewhere; creates a proposal only.
   - **Responding** units with En route / Arrived / Complete & release / Cancel (with confirmation), and earlier units in a history list.
8. **Evidence & reports:** description, vulnerable groups, urgency, impact on nearby incidents/resources, post-incident review, and the raw reports with source and extraction method.
9. **Activity log:** timeline of audited actions.

### Offline support
- **Staff intake:** reports are saved to IndexedDB when offline, the header shows "N queued", and they sync automatically when back online. Idempotent `client_id` means no duplicates.
- **Offline session:** the app can open offline and switches to a live session when the server is reachable.
- **Production:** a service worker caches the app shell.

---

## 22. Database schema and migrations

**Migrations** (`server/src/migrations.ts`, tracked in `schema_migrations`):
1. `initial_schema`: all tables, CHECK constraints and foreign keys.
2. `incident_location_source`.
3. `incident_risk_assessment` (JSONB).
4. `allocation_metadata_and_single_active_assignment`: `resource_assignments.allocation` JSONB, plus the unique partial index `resource_one_active_assignment`.
5. `location_provenance_and_dedup`:
   - `incidents.location_meta`, `last_report_at` (backfilled), `dedup_review`;
   - `reports.reporter_accuracy_m`, `location_meta`, `dedup`;
   - index `incidents_active_activity_idx (status, last_report_at)`.

**Tables (main columns):**
| Table | Key columns |
|---|---|
| `users` | id, username (unique), password_hash, full_name, role, resource_id → resources, active, session_version, last_login_at |
| `resources` | id, type, name, lat/lng, location_name, location_updated_at, location_accuracy_m, status, capacity, current_load, capabilities[], assigned_incident_id → incidents, eta_minutes |
| `incidents` | id, type, status, priority, priority_score, title, description, raw_message, language, location_lat/lng/name, location_source, location_meta, people_affected, injuries, has_children/elderly/disabled, urgency_indicators, confidence, corroborating_reports, affected_radius_m, escalation_deadline, parent_incident_id → incidents, risk_assessment, dedup_review, last_report_at, created/updated/resolved/closed_at |
| `reports` | id, client_id (unique), incident_id → incidents, raw_message, language, source, reporter name/phone/lat/lng/accuracy_m, submitted_by, extracted_data, classifier, confidence, is_duplicate, location_meta, dedup, reported_at |
| `resource_assignments` | id, incident_id, resource_id, status, ai_score, ai_reasoning, eta_minutes, coordinator_action, coordinator_notes, decided_by, allocation (JSONB) |
| `blocked_roads` | id, incident_id, start/end lat/lng, road_name, reason |
| `audit_log` | id, entity_type, entity_id, incident_id, user_id/name, action, details (JSONB), created_at |
| `notifications`, `notification_reads` | Notification feed and per-user read state |
| `incident_reviews` | Post-incident review (one per incident) |

**Enumerations:**
- incident types: 5; priorities: critical/high/medium/low;
- incident statuses: 6; resource types: ambulance, fire_truck, police, hospital, shelter, road_crew;
- resource statuses: available, dispatched, en_route, on_scene, unavailable;
- assignment statuses: 6; roles: 3.

**Seed scenario (Mumbai):** 27 resources (fire stations, ambulances, police stations, hospitals, shelters, BMC road crews), demo incidents across the city, 4 blocked roads (Sion-Matunga Link Road, Bhendi Bazaar Main Road, Andheri Subway, Western Express Highway), and the 3 demo accounts.

---

## 23. REST API reference

**Access key:** 🔓 no login needed · S = staff (admin/coordinator) · A = admin only. Everything else requires a signed-in user.

| Method & path | Access | Purpose |
|---|---|---|
| GET `/api/health` | 🔓 | Health check and database type |
| POST `/api/auth/login` · `/logout` · GET `/me` · POST `/change-password` | 🔓/user | Session management |
| POST `/api/public/reports` | 🔓 | Citizen report (rate-limited; 422 `location_required`; 200 for duplicates or replays) |
| GET `/api/public/reports/track/:id` | 🔓 | Public-safe tracking view |
| GET/POST/PATCH/DELETE `/api/users` | A | User management |
| GET `/api/incidents` · `/stats` · `/:id` | user | List, stats, detail (reports, assignments, impact, allowed transitions) |
| GET `/api/incidents/:id/demand` | S | **Read-only** demand slots |
| GET `/api/incidents/:id/timeline` | S | Audit timeline |
| POST `/api/incidents/:id/transition` | S | Status change (review required to close) |
| PATCH `/api/incidents/:id/location` | S | Verify / correct / choose candidate |
| POST `/api/incidents/:id/duplicate-review` | S | `separate` or `merge` |
| DELETE `/api/incidents/:id` | A | Delete incident |
| POST `/api/incidents/:id/recommend` | S | Run the global optimizer; returns this incident's proposals and slot outcomes (503 when routing is degraded) |
| GET/POST `/api/assignments` · PATCH `/:id` | user/S | List, manual proposal, status change (`force` for reassign; field units only their own) |
| GET/POST/PATCH `/api/resources` · GET `/stats` · `/:id` | user/S | Resources |
| POST `/api/resources/:id/location` | user | Live GPS from a field unit |
| GET `/api/reports` · `/:id` · POST `/api/reports` | user | Staff report intake (returns `dedup`, `location`, `already_processed`) |
| GET/POST/DELETE `/api/blocked-roads` | user/S | Blocked roads |
| GET `/api/routes?from=lat,lng&to=lat,lng` | user | Verified road route (409 if every route is blocked) |
| GET `/api/audit` | S | Audit log |
| GET `/api/notifications` · POST `/:id/read` · `/read-all` | user | Notifications |
| GET `/api/escalations` · `/api/predictions` | user | Escalation check, exhaustion forecast |

---

## 24. Configuration (environment variables)

| Variable | Purpose |
|---|---|
| `PORT` | API port (default 3001) |
| `NODE_ENV` / `--production` | Production mode (serves `dist/`, strict secrets) |
| `JWT_SECRET` | Session signing secret, at least 32 characters (required in production) |
| `COOKIE_SECURE`, `TRUST_PROXY` | Cookie and proxy settings |
| `DATABASE_URL`, `DB_POOL_MAX` | Use an external PostgreSQL instead of PGlite |
| `PGLITE_DATA_DIR` | PGlite location (tests use `memory://`) |
| `GEMINI_API_KEY`, `GEMINI_MODEL`, `GEMINI_FALLBACK_MODELS` | AI extraction |
| `ROUTING_URL`, `ROUTING_BACKEND` (osrm), `ROUTING_TIMEOUT_MS` | Road routing (without it, allocation is DEGRADED) |
| `NOTIFY_WEBHOOK_URL`, `NOTIFY_WEBHOOK_MIN_LEVEL` | Outgoing notification webhook |
| `SEED_ADMIN_PASSWORD`, `SEED_COORDINATOR_PASSWORD`, `SEED_FIELD_PASSWORD` | Override demo passwords |

---

## 25. Testing, verification and benchmarks

All suites pass at the time of writing.

| Suite | Command | Result |
|---|---|---|
| Model parity (TypeScript vs. Python XGBoost, 994 rows) | `npm run verify:risk-model` | **PARITY OK** |
| Risk integration (extraction → evidence → model → score, merge rules, Marathi keyword case…) | `npm run test:risk` | **All passed** |
| Hungarian solver | `npm run test:allocation` | **1,803 passed** |
| Allocation optimizer | (same) | **47 passed** |
| Allocation database tests | (same) | **34 passed** |
| Location resolution (mock geocoder: same-name places, Navi Mumbai, GPS cases…) | `npm run test:location-dedup` | **23 passed** |
| Dedup scoring (scenarios A–F, hazards, best-not-first, GPS) | (same) | **18 passed** |
| Location + dedup integration (real routes, in-memory database: merge, review, concurrency, retries, public 422, location API, duplicate-review merge and tracking) | (same) | **33 passed** |
| Typecheck, production build and lint | `npm run typecheck`, `npm run build`, `oxlint` | Pass; 0 lint errors, 9 minor warnings |

**Mutation check for the race fix:** reintroducing the old pattern (loading candidates outside the transaction) makes the concurrency test fail with 3 incidents, which proves the test detects the race.

**Live checks with real Gemini and Nominatim:**
- Infiniti Mall resolved as exact (confidence 0.95, ±61 m).
- A reworded report merged (score 0.84).
- A retry was idempotent.
- The public "Station Road" report was rejected as ambiguous.
- "Sai Baba Mandir" was flagged with 6 candidates, then verified in the UI.
- A GPS-only report was accepted.
- The full field flow was tested: dispatch → en route → arrived, with the citizen page updating live.
- UI flows were tested in the browser at desktop, tablet and mobile widths.

### Allocation benchmark (`npm run bench:allocation`, synthetic Mumbai scenarios, mean of 4 seeds, real road-time model)
**Competing incidents: legacy greedy (all at once) vs. global optimizer**

| Incidents | Essential coverage | Double bookings | Capability mismatches |
|---|---|---|---|
| 3 | 73.6% → **100%** | 1.75 → **0** | 1.75 → **0** |
| 5 | 53.9% → **96.4%** | 4.75 → **0** | 3 → **0** |
| 8 | 38.0% → **86.4%** | 10.25 → **0** | 5.25 → **0** |
| 10 | 38.5% → **83.5%** | 16 → **0** | 4.25 → **0** |
| 15 | 22.7% → **65.9%** | 29.25 → **0** | 6.5 → **0** |

**Other scenarios:**
- **Scarce fleet (half out, 10 incidents):** coverage 17.7% → 47.4%; critical incidents reached within 8 minutes 18.8% → 93.8%.
- **Blocked roads (8 incidents):** coverage 32.3% → 83.3%; the old method proposed blocked routes (1–4 per run), the optimizer none.
- **New critical incident mid-operation:** the optimizer proposed 3 moves + 1 new unit, for 87.8% essential coverage vs. 70.5% for the legacy top-3, with 3 capability mismatches for the legacy method and 0 for the optimizer.
- **Straight-line vs. road ETA:** mean error 12.1 minutes; the nearest unit differs in 15.3% of cases.
- **Honest trade-off:** the optimizer's risk-weighted mean ETA is slightly higher (about 7.0 → 8.8 minutes at 10 incidents) because it sends the *right* unit to more incidents instead of the *nearest* unit to fewer.
- **Speed:** about 3–7 ms per plan.

---

## 26. Project structure

```
jan rakshak original/
├─ server/
│  ├─ ml/                         janrakshak_xgb_model.json, parity_reference.json
│  ├─ data/                       PGlite data (pgdata/) — runtime
│  ├─ scripts/                    tests, benchmark, mock geocoder/routing, parity verifier
│  └─ src/
│     ├─ index.ts                 Express app, security headers, route mounting, scheduler, realtime
│     ├─ db.ts, migrations.ts     PGlite/Postgres access + versioned migrations
│     ├─ auth.ts, validate.ts, http.ts, rows.ts, constants.ts
│     ├─ realtime.ts              Socket.IO staff + /public namespaces
│     ├─ seed.ts, seedData.ts, create-admin.ts
│     ├─ routes/                  auth, users, incidents, reports, publicReports, assignments,
│     │                           resources, blockedRoads, routing, audit, notifications
│     └─ services/
│        ├─ classifier.ts         Gemini + keyword extraction
│        ├─ riskModel.ts, riskAssessment.ts   XGBoost inference + risk scoring
│        ├─ locate.ts             location resolution
│        ├─ deduplication.ts, incidentMerge.ts
│        ├─ routing.ts            OSRM provider, cache, blocked-road verification
│        ├─ workflow.ts           incident/assignment state machines
│        ├─ escalation.ts, scheduler.ts, prediction.ts, impactPropagation.ts
│        ├─ notify.ts, audit.ts, publicTracking.ts
│        ├─ resourceMatcher.ts    legacy baseline (benchmark only)
│        └─ allocation/           config, demand, candidates, utility, hungarian, optimizer,
│                                 allocationRun, approval, reoptimize
├─ src/                           React frontend
│  ├─ pages/                      Dashboard, ReportPage, FieldPage, PublicReportPage, TrackPage,
│  │                              LoginPage, AdminUsersPage
│  ├─ components/
│  │  ├─ ui/                      primitives, ConfirmDialog
│  │  ├─ layout/                  AppShell, PublicShell
│  │  ├─ dashboard/               IncidentFeed, ResponseOverview, IncidentDetail,
│  │  │                           RiskAssessmentPanel, ResourcePanel, PredictionPanel, AuditLog
│  │  ├─ incident/                LocationSection, DuplicateReview, RequiredResponse, UnitsSection
│  │  ├─ map/                     SituationMap, RouteLines
│  │  ├─ intake/                  IntakeForm, VoiceInput
│  │  └─ shared/                  NotificationBar, Toasts, ChangePasswordDialog
│  ├─ lib/                        data (API), http, realtime, publicRealtime, offlineQueue,
│  │                              operations, slots, desktopNotify
│  ├─ store/                      useStore (zustand), useAuth
│  ├─ types/, utils/              shared types, helpers, cx
│  └─ index.css                   theme tokens, map/marker styles
└─ ROUND2_CONTRACT.md.txt         team API/event contract (unchanged)
```

---

## 27. Known limitations and honest caveats

**ML and data**
- The model reproduces a rubric over synthetic and weakly labelled data. It is **not a validated real-world severity predictor**.
- Allocation, demand and dedup thresholds are hand-tuned policy values, not validated on labelled data.

**Location**
- Depends on OSM coverage of small landmarks.
- The public Nominatim rate limit is 1 request/s, so reports take several seconds.
- An area-level or unverified incident still receives unit proposals at its best-guess point; it is flagged, not held back.
- When the text clearly names a Mumbai place, a far-away reporter GPS can still win. Seen once: a Colaba report placed near Pune from a laptop's GPS.

**Dedup**
- Text similarity is word-based, so the same event reported in different languages matches weakly.
- An incident-to-incident merge requires the absorbed incident to have no active units.

**Routing**
- Depends on `ROUTING_URL` (OSRM). Without it, allocation is paused (by design).
- The detour search is heuristic.
- The citizen map shows no route line.

**Allocation and state**
- Shelter capacity is checked but not decremented.
- Cancelling every unit leaves an incident "dispatched" (the workflow has no Dispatched → Triage step).

**Security and abuse**
- **False reports:** mitigated by rate limits, location requirements, corroboration via merging, human approval and audit. There is no automatic credibility scoring yet.
- The public submit response returns the full incident row (a privacy gap to trim).

**Current demo database** (read-only health check, 28 Sep)
- Structurally sound.
- Needs cleanup before a demo: stale seed assignments; three "dispatched" incidents with no active unit; two incidents placed near Pune; three with no coordinates; a triple-reported Taj Hotel test cluster.
- `npm run seed` gives a clean scenario but **deletes current data**.

**Build**
- The frontend bundle is over 500 kB (a warning only).

---

## 28. Future work
- **Credibility score** (corroboration, GPS consistency, reporter history), kept separate from risk; a "verify first" proportional response; a field "false alarm" feedback loop.
- **Location-gated allocation** for unverified or AI-estimated locations; rule out far-away GPS when the text names a local place.
- **Multilingual semantic similarity** for dedup.
- **Shelter capacity accounting**; a Dispatched → Triage fallback when all units are cancelled.
- **Road-aware routes on the citizen map** through a public-safe route endpoint.
- **Trim the public API response**; self-hosted geocoder and OSRM for production.
- **Hazard-warning module** (rainfall/terrain → settlement alerts and automatic road closures) if targeting a warning-first problem statement.

---

## 29. Glossary
| Term | Meaning |
|---|---|
| **Slot / demand slot** | One required unit for an incident (type, capabilities, seats, importance) |
| **Proposal** | A `recommended` assignment produced by the optimizer or a coordinator; not yet a dispatch |
| **Move / Replacement / Backfill** | Kinds of reallocation proposals (§15) |
| **Utility** | The optimizer's value of a unit filling a slot (risk × importance × time/fit − scarcity) |
| **Hungarian algorithm** | An exact algorithm for optimal one-to-one assignment |
| **Degraded** | Routing unavailable, so the optimizer makes no proposals rather than guessing |
| **Precision (location)** | verified / exact / approximate / area / ai_estimate / unverified |
| **Canonical incident** | The incident that duplicates were merged into; tracking links follow it |
| **Advisory lock** | Postgres lock that serializes the dedup decision so simultaneous reports can't create duplicates |
| **Weak supervision** | Training labels produced by a rule (the rubric) rather than human annotation |
