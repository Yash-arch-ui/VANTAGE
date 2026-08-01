# VANTAGE

A pre-transaction safety layer for Monad. VANTAGE takes a prepared-but-unsigned transaction,
simulates it against live chain state, decides whether it is safe to submit, and explains the
verdict in one plain-English sentence.

**6 of the 7 components are pure deterministic code** — real simulation, real math, real on-chain
data. Exactly one uses an LLM, and its only job is turning already-computed numbers into a sentence
a human can read.

---

## Modules

| # | Module | Problem solved | AI? | Core file |
|---|---|---|---|---|
| 1 | Simulation / Forecast | Transaction executes differently than quoted (bad price, unexpected revert) | No | `backend/src/psg/forecast.ts` |
| 2 | Conflict / Stale-State Detector | Transaction becomes invalid because someone else changed state first | No | `contracts/src/MockClaim.sol` + `forecast.ts` |
| 3 | Transaction Watcher | Transaction appears to vanish under Monad's async mempool model | No | `backend/src/apa/policy.ts` (`watchTransaction`) |
| 4 | Congestion Detector | Execution slows or shifts during high contract activity | No | `forecast.ts` (`getContentionScore`) |
| 5 | Approval Risk Checker | Unlimited ERC-20 approvals | No | `backend/src/services/watchdog.ts` |
| 6 | AI Explainer | Communicating dense numeric risk to a non-technical user | **Yes** | `backend/src/apa/policy.ts` (`explainPolicy`) |
| 7 | Execution Memory / Risk Log | Proof of value — every decision and outcome is recorded | No | `backend/src/em/ledger.ts` |

Supporting layers: `services/scoring.ts` (0–100 Vantage Score per contract),
`services/watchdog.ts` (15s background monitor raising alerts), `em/calibrator.ts`
(per-contract contention threshold that adapts to real outcomes).

---

## Layout

```
backend/     Express + SQLite + viem. The whole engine and the REST API.
contracts/   Foundry. MockAMM, MockClaim, MockERC20 on Monad testnet.
frontend/    TanStack Start + React + Tailwind. The UI.
```

## API

| Route | Purpose |
|---|---|
| `GET /health` | Liveness |
| `POST /api/evaluate` | The core call: simulate → decide → explain → record. Can block up to ~30s when the policy holds and re-checks. |
| `POST /api/outcome` | Report what actually happened; recalibrates the contention threshold |
| `GET /api/stats` | Session aggregates |
| `GET /api/score/:address` | Vantage Score for a contract |
| `GET/POST/DELETE /api/watchlist` | Contracts the watchdog monitors |
| `GET/PATCH /api/alerts`, `GET /api/alerts/summary` | Watchdog alerts |

## Chain

Monad testnet (chain id `10143`, RPC `https://testnet-rpc.monad.xyz`).
Deployed addresses live in `contracts/deployments.json`. Only MockAMM and MockClaim get fully
decoded simulation — any other target falls back to a raw `eth_call`.

---

## Running locally

```bash
cp .env.example .env        # fill in PRIVATE_KEY (no 0x prefix) and optionally GEMINI_API_KEY

cd backend && npm install && npm run dev     # :4000
cd frontend && npm install && npm run dev    # :3000
```

`GEMINI_API_KEY` is optional — without it the explainer falls back to deterministic templates.

## Proof scripts

Everything the pitch claims is demonstrated by a script against real Monad testnet state:

```bash
cd backend
npx tsx scripts/prove-ledger.ts             # audit trail is real and on disk
npx tsx scripts/prove-watchdog.ts           # autonomous monitoring raises a real drift alert
npx tsx scripts/prove-watch.ts              # tx watcher classifies real confirmed/failed txs
npx tsx scripts/prove-contention.ts         # contention score crosses threshold -> HOLD_AND_RECHECK
npx tsx scripts/prove-score.ts              # clean contract scores 100, abused one does not
npx tsx scripts/check-failure-surge.ts      # drives a failure_surge critical alert
npx tsx scripts/check-contention-spike.ts   # drives a contention_spike alert
npx tsx scripts/check-approval-exposure.ts  # drives an approval_exposure alert
```

All of them require `PRIVATE_KEY` in `.env` and a funded Monad testnet account.
