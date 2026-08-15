<div align="center">

#  Vantage

### Autonomous Transaction Intelligence for the Monad Ecosystem

*Analyze. Decide. Monitor. Learn.*

---

[![Monad](https://img.shields.io/badge/Built%20For-Monad-8A5CF6?style=for-the-badge)]()
---

### 🌐 Live Demo

**🔗 Website:**
> **[vantage-two-iota.vercel.app](https://vantage-two-iota.vercel.app)**


</div>

---

# Screenshots

## Landing Page

![Landing Page](assets/landing-page.png)

---

## Pre-Sign Guard Console

![Guard Console](assets/guard-console.png)

---

## Autonomous Watchdog

![Monitor](assets/monitor.png)

---

## Contract Trust Dashboard

![Score](assets/score-dashboard.png)

---

# Overview

Vantage is an autonomous transaction-intelligence platform built for Monad's execution model. It answers a question wallets don't: **"Should this transaction be executed right now?"**

Where a wallet simulates once and warns once, Vantage runs a deterministic, evidence-backed pipeline *before* signing — simulation, state-drift detection, nonce and balance validation, mempool contention scoring, approval-exposure analysis, and execution-conflict analysis — then converts the results into an explainable decision: **PROCEED, WARN, HOLD_AND_RECHECK, SUGGEST_ADJUSTMENT, or ABORT**. It keeps re-verifying while the verdict is on screen, watches submitted transactions to their terminal state, and records every outcome in an auditable ledger that continuously recalibrates contract thresholds and trust scores.

Every number is produced by deterministic blockchain analysis. AI is used for exactly one labelled job — writing the plain-English explanation — and falls back to a deterministic template when no API key is configured.

---

# How It Works

## The Pipeline

```
Wallet (frontend)
  ├─ reads your pending nonce            → the nonce you will actually sign
  └─ quotes the pool live (getExpectedOutput) → the price you are shown
        │
        ▼
POST /api/evaluate ── getPSGForecast (5 modules, in parallel)
  ├─ Simulation          → eth_call / simulateContract, gas estimate, revert decoding
  ├─ Drift               → (simulated − quoted) / quoted, signed %
  ├─ Validity            → pending nonce (STALE / GAP) + balance vs gas + value
  ├─ Contention          → event-log density over a ~3-minute window → 0–1 score
  ├─ Approval exposure   → approve() calldata ≥ 50% of balance → APPROVAL_EXPOSURE
  └─ Execution Conflict Analyzer (ECA) → enumerates the pending block, counts
        competing transactions / swaps / pool writers / same-slot claims → 0–1 score
        │
        ▼
deriveRiskLevel (flags → LOW / MEDIUM / HIGH / CRITICAL)
        │
        ▼
decidePolicy
  ├─ PROCEED             — low risk, no flags
  ├─ WARN                — medium risk · stale quote (drift < −5%) · watchdog escalation
  ├─ HOLD_AND_RECHECK    — high contention or high state conflict (re-verifies
  │                        every 3s; 30s timeout → SUGGEST_ADJUSTMENT)
  ├─ SUGGEST_ADJUSTMENT  — "try increasing gas or waiting for activity to settle"
  └─ ABORT               — simulation reverted · nonce gap/stale · insufficient balance
        │
        ▼
applyWatchdogBias (active critical alerts → PROCEED becomes WARN)
  → explainPolicy (Gemini or deterministic template)
  → recordEntry (immutable SQLite audit row) + auto-watch target + computeScore
        │
        ▼
Response → Guard console verdict → 10s background recheck loop
  → sign → 2s watcher (propagating / stuck / dropped / confirmed / failed)
  → outcome recorded → contract threshold recalibrated
```

## The Execution Conflict Analyzer (ECA)

Monad executes transactions optimistically and in parallel, so a transaction's real outcome depends on *who else is racing the same contract or slot in the mempool* — something a single simulation cannot see. The ECA enumerates the pending block (the one mempool primitive Monad's public RPC exposes) and counts viable, other-sender competitors:

- **Competing transactions** — pending txs to the same target contract
- **Competing swaps** — pending `swap()` calls on the same AMM
- **Pool writers** — pending non-swap reserve movers (half-weight direct conflicts)
- **Same-slot claims** — pending `claim(slotId)` calls for the same slot
- **Pool pressure** — viable pending txs chain-wide, as background context

These feed the v3 formula — `g(n, k) = n / (n + k)` with weights `0.08 · sameContract + 0.86 · directConflict + 0.06 · poolPressure` — producing a `conflictScore` (0–1) and a severity ladder: **POTENTIAL_STATE_CONFLICT ≥ 0.30**, **HIGH_STATE_CONFLICT ≥ 0.60** (HIGH subsumes POTENTIAL). When the pending block is unavailable, the ECA falls back to a log-density estimate and labels it as such. Every score is persisted alongside its evidence snapshot, so each audit row shows *why* the number was what it was.

## The Recheck Loop

While a verdict is on screen, the Guard console polls `/api/recheck` every 10 seconds. The backend re-runs the *same* pipeline against fresh chain state — drift is always measured against the **original quote** you were shown — and returns a fresh verdict. A pool move shows up as STALE_STATE, a crowded mempool as HOLD_AND_RECHECK, and a cleared one as PROCEED, without the user re-submitting anything. The Execution Conflict card stays in lockstep: every recheck re-scans the mempool, so the level, score, source, and evidence counts always come from the same scan.

## The Watchdog

The watchdog is a background loop (15s cadence) that polls every watched contract on its own — auto-watching any contract you evaluate — and raises alerts:

| Alert | Trigger |
|---|---|
| `reserve_drift` | reserve moved > 5% (critical at ≥ 10%) between polls |
| `contention_spike` | contention ≥ 3× the prior poll, above a floor |
| `failure_surge` | > 25% of recent evaluations failed |
| `approval_exposure` | observer holds a large outstanding allowance |
| `inactivity` | no contract activity in 10 minutes |

Alerts auto-resolve when the condition clears, expire when stale, and active **critical** alerts bias the policy engine toward caution. The watchdog reuses the same contention scanner and calibrator as the evaluate path — no duplicated logic.

## Execution Memory & Learning

Every evaluation is an immutable row in a SQLite audit ledger (`execution_ledger`): the full forecast (including conflict evidence), the policy decision, the explanation, the user's action (SIGNED / CANCELLED / OVERRIDDEN), and the real outcome (CONFIRMED / FAILED / DROPPED / STUCK). From that history Vantage:

- **Recalibrates** each contract's contention hold threshold after every reported outcome — failure rate > 40% makes the scanner more sensitive, < 10% (with enough samples) relaxes it, clamped to [0.3, 0.95].
- **Scores** every contract 0–100: `100 − 40·failureRate − min(30, alerts) − 15·contention − 15·(sample < 5)`, with a fully transparent breakdown. Never-evaluated contracts are honestly "not yet scored".

## AI Boundaries

AI never simulates, scores, inspects state, or computes risk. It is responsible only for the labelled "In plain English" explanation — and every explanation can fall back to a deterministic template built purely from the forecast fields.

---

# Tech Stack

**Backend** (`backend/`)
- Node.js 22 · TypeScript · Express 4
- [viem](https://viem.sh) — Monad testnet RPC, simulation, pending-block enumeration
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) — WAL-mode audit ledger + calibration store
- [zod](https://zod.dev) — request validation
- [@google/genai](https://ai.google.dev) — optional Gemini explanations

**Frontend** (`frontend/`)
- React 19 · TypeScript · Vite 7
- TanStack Router / Start / Query
- wagmi + viem — wallet connection, live pool reads, signing
- Tailwind CSS 4 · motion · three.js / react-three-fiber backgrounds · sonner toasts
- Vitest + Testing Library

---

# Repository Layout

```
vantage/
├── backend/
│   └── src/
│       ├── apa/        # policy engine: decidePolicy, holdAndRecheck, watcher, explainer
│       ├── psg/        # pre-sign guard: forecast, ECA, contention, validity, approval
│       ├── em/         # execution memory: SQLite ledger, schema, calibrator
│       ├── services/   # scoring + watchdog
│       └── routes/     # evaluate, recheck, outcome, ledger, stats, score, watch, watchlist
├── frontend/
│   └── src/
│       ├── routes/     # Guard console (/app), Monitor (/monitor), Score (/score)
│       ├── components/ # verdict panel, execution-conflict card, watcher strip, …
│       ├── hooks/      # useTxBuilder, usePoolReserves, TanStack Query hooks
│       └── lib/        # API client, types, normalize, risk presentation, format
├── contracts/          # deployed Monad testnet contracts (deployments.json + ABIs)
├── assets/             # screenshots
├── ARCHITECTURE.md     # full system documentation (16 sections, Mermaid diagrams)
└── render.yaml         # Render blueprint for the backend
```

---

# Getting Started

## Prerequisites

- Node.js 22+
- A Monad testnet RPC (default: `https://testnet-rpc.monad.xyz`)
- A wallet private key for the demo's observer address (approval-exposure alerts)
- Optional: a Gemini API key for LLM explanations

## 1. Backend

```bash
cd backend
npm install
cp ../.env.example ../.env   # then fill in PRIVATE_KEY, optional GEMINI_API_KEY
npm run dev                  # http://localhost:4000
```

The server creates `vantage.db` on first start (idempotent — existing data is never wiped) and mounts `GET /health`.

## 2. Frontend

```bash
cd frontend
npm install
npm run dev                  # Vite dev server, default http://localhost:5173
```

Point the frontend at the backend via `VITE_API_URL` (default `http://localhost:4000`).

## 3. Demo contracts

The Guard console's presets exercise the pipeline against contracts deployed on Monad testnet — the AMM (swaps), ClaimContract (same-slot claims), and MockERC20 (unlimited approvals). Addresses live in `contracts/deployments.json`; the ABI surface mirrors `backend/src/psg/forecast.ts`. See `Commands.md` for minting, approval, and liquidity commands.

---

# API Reference

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/api/evaluate` | Simulate, analyze, decide, explain, record — returns the full verdict |
| `POST` | `/api/recheck` | Re-verify an evaluated entry against fresh chain state (10s poll) |
| `POST` | `/api/outcome` | Report the user's action + real outcome; recalibrates the threshold |
| `GET` | `/api/ledger` | Paged audit timeline (newest-first, optional contract filter) |
| `GET` | `/api/stats` | Session aggregates by action / outcome, override count |
| `GET` | `/api/score/:address` | Live 0–100 contract trust score with breakdown |
| `GET` | `/api/watch/:txHash?since=` | One-shot status: propagating / stuck / dropped / confirmed / failed |
| `GET/POST/DELETE` | `/api/watchlist` | Manage watched contracts |
| `GET/PATCH` | `/api/alerts` | List / update alerts; `GET /api/alerts/summary` |
| `GET` | `/health` | Health check |

---

# Testing

```bash
# backend — node:test, ~176 tests
cd backend && npm test

# frontend — vitest + testing-library, ~63 tests
cd frontend && npm test

# typecheck
cd backend && npx tsc --noEmit
cd frontend && npx tsc --noEmit
```

Coverage includes the ECA's pinned score formulas and thresholds (`psg/conflict.test.ts`), policy transitions (`apa/policy-conflict.test.ts`), recheck payloads, ledger lifecycle, scoring, and the frontend verdict/conflict-card components.

---

# Deployment

**Backend** — `render.yaml` deploys the backend as a web service with a **persistent disk** (the SQLite audit ledger, scores, and thresholds live in a file — a diskless deploy resets all of it). The free tier is unsuitable because a sleeping service stops the 15s watchdog poll.

**Frontend** — built with Vite and deployed to Vercel (the live demo at `vantage-two-iota.vercel.app`). `VITE_*` values are inlined at build time.

---

# Documentation

- **[ARCHITECTURE.md](ARCHITECTURE.md)** — the complete system documentation: every stage of the pipeline with source files, functions, inputs/outputs, produced/consumed flags, the exact ECA v3 formulas, state machines, and Monad-specific design decisions.
- **[Commands.md](Commands.md)** — deployment addresses, mint/approve/liquidity commands, and the score/contention formulas.

---

# Core Principles

- **Deterministic first** — blockchain state is the source of truth; AI never replaces deterministic analysis.
- **Explainable intelligence** — every recommendation and score traces back to verifiable evidence.
- **Continuous monitoring** — execution conditions change after simulation; Vantage keeps observing them.
- **Evidence over assumptions** — every decision is backed by measurable on-chain evidence.
- **Monad native** — designed around optimistic parallel execution, deferred execution, and high throughput, not adapted from sequential-EVM tooling.
