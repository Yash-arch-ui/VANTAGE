// ECA — pure unit tests for analyzePendingTxs (the deterministic core).
//
// No RPC, no chain: the pending-block transactions are passed in directly, so
// every score and flag below is pinned exactly. The full formula lives in
// forecast.ts; these tests lock it down (recalibrated v3):
//
//   g(n, k) = n / (n + k)                       // diminishing returns, no cap
//   sameContractScore   = g(competingTxCount, 2)                  × 0.08
//   directConflictScore = g(swaps + 0.5·writers, 1)               × 0.86
//                         g(sameSlotClaims, 0.5)                  × 0.86
//   poolPressureScore   = g(pendingPoolSize, 250)                 × 0.06
//   conflictScore = min(1, round(sum, 3 decimals))
//
//   POTENTIAL_STATE_CONFLICT at >= 0.30, HIGH_STATE_CONFLICT at >= 0.60.
//   HIGH subsumes POTENTIAL, and HIGH requires a direct conflict signal.
//
// Pre-filters (unchanged from v2 — each count is filtered before it becomes
// evidence):
//   - same-sender pending txs are serialized, never competitors
//   - explicit gasPrice 0 / gas 0 txs cannot mine, never counted
//   - non-swap AMM reserve movers (pool writers) count as half a swap
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData } from "viem";
import {
  ammAbi,
  claimContractAbi,
  analyzePendingTxs,
  AMM_ADDRESS,
  CLAIM_CONTRACT_ADDRESS,
  type PendingTxLike,
  type VantageTxRequest,
} from "./forecast.js";

const SWAP_DATA = encodeFunctionData({
  abi: ammAbi,
  functionName: "swap",
  args: [0n, true, 1_000_000_000_000_000_000n],
});
// A decodable AMM call that is NOT a swap — a reserve mover (pool writer).
const NON_SWAP_AMM_DATA = encodeFunctionData({
  abi: ammAbi,
  functionName: "manipulateReserves",
  args: [100n, 200n],
});
const CLAIM_SLOT_3 = encodeFunctionData({ abi: claimContractAbi, functionName: "claim", args: [3n] });
const CLAIM_SLOT_4 = encodeFunctionData({ abi: claimContractAbi, functionName: "claim", args: [4n] });

const EVAL_FROM = "0x1111111111111111111111111111111111111111" as `0x${string}`;
const OTHER_FROM = "0x2222222222222222222222222222222222222222" as `0x${string}`;
const THIRD_FROM = "0x3333333333333333333333333333333333333333" as `0x${string}`;
const UNRELATED_CONTRACT = "0x9999999999999999999999999999999999999999" as `0x${string}`;

function evalTx(to: string, data: string, nonce = 7): VantageTxRequest {
  return { from: EVAL_FROM, to: to as `0x${string}`, data: data as `0x${string}`, value: 0n, nonce };
}

function pendingTx(
  to: string | null,
  input: string | undefined,
  from: string = OTHER_FROM,
  nonce = 1,
  opts: { gasPrice?: bigint; gas?: bigint } = {},
): PendingTxLike {
  return {
    from,
    to,
    input,
    nonce,
    gasPrice: opts.gasPrice,
    gas: opts.gas,
  };
}

describe("ECA — analyzePendingTxs (clean transactions)", () => {
  it("AMM/ClaimContract deployments are present (the tests key off them)", () => {
    assert.ok(AMM_ADDRESS.startsWith("0x"), "AMM_ADDRESS must be a real address");
    assert.ok(CLAIM_CONTRACT_ADDRESS.startsWith("0x"), "CLAIM_CONTRACT_ADDRESS must be a real address");
  });

  it("empty mempool → conflictScore 0, no flags", () => {
    const r = analyzePendingTxs(evalTx(AMM_ADDRESS, SWAP_DATA), [], Date.now());
    assert.equal(r.conflictScore, 0);
    assert.deepEqual(r.flags, []);
    assert.equal(r.evidence.competingTxCount, 0);
    assert.equal(r.evidence.pendingPoolSize, 0);
  });

  it("pending txs to UNRELATED contracts are ignored (same contract access only)", () => {
    const pending = [
      pendingTx(UNRELATED_CONTRACT, "0xdeadbeef"),
      pendingTx(UNRELATED_CONTRACT, "0xdeadbeef"),
    ];
    const r = analyzePendingTxs(evalTx(AMM_ADDRESS, SWAP_DATA), pending, Date.now());
    assert.equal(r.evidence.competingTxCount, 0);
    // Only the tiny pool-pressure term remains: g(2, 300) × 0.06 ≈ 0.0004 → 0
    assert.equal(r.conflictScore, 0);
    assert.deepEqual(r.flags, []);
  });

  it("the evaluated tx itself is excluded even if already pending (from+nonce match)", () => {
    // The recheck-after-sign case: the user's own submitted tx sits in the
    // mempool. It must never count as a competitor.
    const pending = [pendingTx(AMM_ADDRESS, SWAP_DATA, EVAL_FROM, 7)];
    const r = analyzePendingTxs(evalTx(AMM_ADDRESS, SWAP_DATA, 7), pending, Date.now());
    assert.equal(r.evidence.competingTxCount, 0);
    assert.equal(r.evidence.competingSwapCount, 0);
    // Self-excluded; g(1, 300) × 0.06 ≈ 0.0002 → 0
    assert.equal(r.conflictScore, 0);
    assert.deepEqual(r.flags, []);
  });
});

describe("ECA — analyzePendingTxs (competing swaps)", () => {
  it("two competing swaps → HIGH_STATE_CONFLICT with the exact score", () => {
    const pending = [
      pendingTx(AMM_ADDRESS, SWAP_DATA, OTHER_FROM, 1),
      pendingTx(AMM_ADDRESS, SWAP_DATA, OTHER_FROM, 2),
      pendingTx(UNRELATED_CONTRACT, "0xdeadbeef"),
      pendingTx(UNRELATED_CONTRACT, "0xdeadbeef"),
    ];
    const r = analyzePendingTxs(evalTx(AMM_ADDRESS, SWAP_DATA), pending, Date.now());
    // direct g(2,1)=2/3 → 0.57333; same g(2,2)=0.5 → 0.04000; pool g(4,250) → 0.00095
    // → 0.61428 → 0.614
    assert.equal(r.conflictScore, 0.614);
    assert.deepEqual(r.flags, ["HIGH_STATE_CONFLICT"]);
    assert.equal(r.evidence.competingTxCount, 2);
    assert.equal(r.evidence.competingSwapCount, 2);
    assert.equal(r.evidence.competingClaimCount, 0);
  });

  it("a single competing swap → POTENTIAL_STATE_CONFLICT (below the HIGH bar)", () => {
    const pending = [
      pendingTx(AMM_ADDRESS, SWAP_DATA, OTHER_FROM, 1),
      pendingTx(UNRELATED_CONTRACT, "0xdeadbeef"),
      pendingTx(UNRELATED_CONTRACT, "0xdeadbeef"),
      pendingTx(UNRELATED_CONTRACT, "0xdeadbeef"),
      pendingTx(UNRELATED_CONTRACT, "0xdeadbeef"),
      pendingTx(UNRELATED_CONTRACT, "0xdeadbeef"),
    ];
    const r = analyzePendingTxs(evalTx(AMM_ADDRESS, SWAP_DATA), pending, Date.now());
    // direct g(1,1)=0.5 → 0.43; same g(1,2)=0.33333 → 0.02667; pool g(6,250) → 0.00140
    // → 0.45807 → 0.458
    assert.equal(r.conflictScore, 0.458);
    assert.deepEqual(r.flags, ["POTENTIAL_STATE_CONFLICT"]);
  });

  it("a non-swap AMM reserve mover (manipulateReserves) counts as a half-weight pool writer", () => {
    const pending = [pendingTx(AMM_ADDRESS, NON_SWAP_AMM_DATA, OTHER_FROM, 1)];
    const r = analyzePendingTxs(evalTx(AMM_ADDRESS, SWAP_DATA), pending, Date.now());
    assert.equal(r.evidence.competingTxCount, 1);
    assert.equal(r.evidence.competingSwapCount, 0);
    assert.equal(r.evidence.competingPoolWriterCount, 1);
    // direct g(0.5,1)=1/3 → 0.28667; same g(1,2)=0.33333 → 0.02667; pool g(1,250) → 0.00024
    // → 0.31358 → 0.314 — a writer surfaces as POTENTIAL (was invisible before v2)
    assert.equal(r.conflictScore, 0.314);
    assert.deepEqual(r.flags, ["POTENTIAL_STATE_CONFLICT"]);
  });

  it("pool writers escalate: 3 writers stay POTENTIAL, 4 writers reach HIGH", () => {
    const three = [
      pendingTx(AMM_ADDRESS, NON_SWAP_AMM_DATA, OTHER_FROM, 1),
      pendingTx(AMM_ADDRESS, NON_SWAP_AMM_DATA, OTHER_FROM, 2),
      pendingTx(AMM_ADDRESS, NON_SWAP_AMM_DATA, OTHER_FROM, 3),
      ...Array.from({ length: 47 }, (_, i) => pendingTx(UNRELATED_CONTRACT, "0xdeadbeef", OTHER_FROM, 100 + i)),
    ];
    const r3 = analyzePendingTxs(evalTx(AMM_ADDRESS, SWAP_DATA), three, Date.now());
    // direct g(1.5,1)=0.6 → 0.516; same g(3,2)=0.6 → 0.048; pool g(50,250) → 0.01000
    // → 0.57400 → 0.574 — just below the HIGH bar
    assert.equal(r3.conflictScore, 0.574);
    assert.deepEqual(r3.flags, ["POTENTIAL_STATE_CONFLICT"]);

    const four = [...three.slice(0, 3), pendingTx(AMM_ADDRESS, NON_SWAP_AMM_DATA, OTHER_FROM, 4)];
    const r4 = analyzePendingTxs(evalTx(AMM_ADDRESS, SWAP_DATA), four, Date.now());
    // direct g(2,1)=2/3 → 0.57333; same g(4,2)=0.66667 → 0.05333; pool g(4,250) → 0.00095
    // → 0.62761 → 0.628
    assert.equal(r4.conflictScore, 0.628);
    assert.deepEqual(r4.flags, ["HIGH_STATE_CONFLICT"]);
  });

  it("ambient same-contract pressure alone (no decodable direct signal) never reaches even POTENTIAL", () => {
    // 25 undecodable txs to the AMM: no swaps, no writers — same-contract only.
    const pending = Array.from({ length: 25 }, (_, i) =>
      pendingTx(AMM_ADDRESS, "0xdeadbeef", OTHER_FROM, i + 1),
    );
    const r = analyzePendingTxs(evalTx(AMM_ADDRESS, SWAP_DATA), pending, Date.now());
    assert.equal(r.evidence.competingSwapCount, 0);
    assert.equal(r.evidence.competingPoolWriterCount, 0);
    // same g(25,2) → 0.0741; pool g(25,250) → 0.0055 → 0.080 — below the 0.30 floor
    assert.equal(r.conflictScore, 0.08);
    assert.deepEqual(r.flags, []);
  });
});

describe("ECA — analyzePendingTxs (competing claims)", () => {
  it("a pending claim of the SAME slot → HIGH_STATE_CONFLICT (winner-take-all race)", () => {
    const pending = [
      pendingTx(CLAIM_CONTRACT_ADDRESS, CLAIM_SLOT_3, OTHER_FROM, 1),
      pendingTx(CLAIM_CONTRACT_ADDRESS, CLAIM_SLOT_4, OTHER_FROM, 2),
      pendingTx(CLAIM_CONTRACT_ADDRESS, CLAIM_SLOT_4, OTHER_FROM, 3),
      pendingTx(UNRELATED_CONTRACT, "0xdeadbeef"),
      pendingTx(UNRELATED_CONTRACT, "0xdeadbeef"),
      pendingTx(UNRELATED_CONTRACT, "0xdeadbeef"),
      pendingTx(UNRELATED_CONTRACT, "0xdeadbeef"),
      pendingTx(UNRELATED_CONTRACT, "0xdeadbeef"),
    ];
    const r = analyzePendingTxs(evalTx(CLAIM_CONTRACT_ADDRESS, CLAIM_SLOT_3), pending, Date.now());
    // direct g(1,0.5)=1/1.5 → 0.57333; same g(3,2)=0.6 → 0.048; pool g(8,250) → 0.00189
    // → 0.62322 → 0.623
    assert.equal(r.conflictScore, 0.623);
    assert.deepEqual(r.flags, ["HIGH_STATE_CONFLICT"]);
    assert.equal(r.evidence.competingClaimCount, 1);
    assert.equal(r.evidence.competingSwapCount, 0);
  });

  it("claims of OTHER slots are not same-slot conflicts (no direct signal)", () => {
    const pending = Array.from({ length: 5 }, (_, i) =>
      pendingTx(CLAIM_CONTRACT_ADDRESS, CLAIM_SLOT_4, OTHER_FROM, i + 1),
    );
    const r = analyzePendingTxs(evalTx(CLAIM_CONTRACT_ADDRESS, CLAIM_SLOT_3), pending, Date.now());
    assert.equal(r.evidence.competingClaimCount, 0);
    assert.ok(!r.flags.includes("HIGH_STATE_CONFLICT"), "different slots must not be HIGH");
    // same g(5,2) → 0.05714; pool g(5,250) → 0.00118 → 0.058 → below floor → no flag
    assert.deepEqual(r.flags, []);
  });
});

describe("ECA — recalibration: same-sender serialization (never competitors)", () => {
  it("a wallet's own pending swaps at other nonces are excluded from every count", () => {
    const pending = [
      pendingTx(AMM_ADDRESS, SWAP_DATA, EVAL_FROM, 8), // own wallet, next nonce — serialized
      pendingTx(AMM_ADDRESS, SWAP_DATA, EVAL_FROM, 9), // own wallet — serialized
      pendingTx(AMM_ADDRESS, SWAP_DATA, OTHER_FROM, 1), // genuine competitor
    ];
    const r = analyzePendingTxs(evalTx(AMM_ADDRESS, SWAP_DATA, 7), pending, Date.now());
    assert.equal(r.evidence.competingTxCount, 1);
    assert.equal(r.evidence.competingSwapCount, 1);
    assert.equal(r.evidence.excludedSameSenderCount, 2);
    // Score = single-competitor level (own txs add pool pressure only):
    // direct 0.43 + same 0.02667 + pool g(3,250) → 0.45738 → 0.457
    assert.equal(r.conflictScore, 0.457);
    assert.deepEqual(r.flags, ["POTENTIAL_STATE_CONFLICT"]);
  });
});

describe("ECA — recalibration: zero-viability pending txs (never counted)", () => {
  it("explicit gasPrice 0 / gas 0 txs are excluded from competitors and pool pressure", () => {
    const pending = [
      pendingTx(AMM_ADDRESS, SWAP_DATA, OTHER_FROM, 1, { gasPrice: 0n }), // Monad artifact
      pendingTx(AMM_ADDRESS, SWAP_DATA, OTHER_FROM, 2, { gasPrice: 0n }),
      pendingTx(AMM_ADDRESS, SWAP_DATA, OTHER_FROM, 3, { gas: 0n }),
      pendingTx(AMM_ADDRESS, SWAP_DATA, OTHER_FROM, 4), // viable
    ];
    const r = analyzePendingTxs(evalTx(AMM_ADDRESS, SWAP_DATA), pending, Date.now());
    assert.equal(r.evidence.competingTxCount, 1);
    assert.equal(r.evidence.competingSwapCount, 1);
    assert.equal(r.evidence.excludedNonViableCount, 3);
    assert.equal(r.evidence.pendingPoolSize, 1, "non-viable txs add no pool pressure");
    // Single-competitor level: direct 0.43 + same 0.02667 + pool g(1,250) → 0.45690 → 0.457
    assert.equal(r.conflictScore, 0.457);
    assert.deepEqual(r.flags, ["POTENTIAL_STATE_CONFLICT"]);
  });
});

describe("ECA — recalibration: score keeps rising with load (no saturation)", () => {
  it("5 / 10 / 25 competing swaps are strictly increasing and stay below 1", () => {
    const scoreFor = (n: number): number => {
      const pending = Array.from({ length: n }, (_, i) =>
        pendingTx(AMM_ADDRESS, SWAP_DATA, OTHER_FROM, i + 1),
      );
      return analyzePendingTxs(evalTx(AMM_ADDRESS, SWAP_DATA), pending, Date.now()).conflictScore;
    };
    const s5 = scoreFor(5);
    const s10 = scoreFor(10);
    const s25 = scoreFor(25);
    assert.equal(s5, 0.775);
    assert.equal(s10, 0.851);
    assert.equal(s25, 0.906);
    assert.ok(s5 < s10 && s10 < s25, "score must keep discriminating beyond 2 competitors");
    assert.ok(s25 < 1, "score must not clamp early");
    assert.ok(s25 - s5 > 0.1, "the post-saturation range must be meaningful");
  });

  it("chain-wide pool pressure grows slowly and never saturates at 50", () => {
    const scoreFor = (n: number): number => {
      const pending = Array.from({ length: n }, (_, i) =>
        pendingTx(UNRELATED_CONTRACT, "0xdeadbeef", OTHER_FROM, i + 1),
      );
      return analyzePendingTxs(evalTx(AMM_ADDRESS, SWAP_DATA), pending, Date.now()).conflictScore;
    };
    // g(p, 250) × 0.06: p=50 → 0.010, p=100 → 0.017, p=300 → 0.033
    assert.equal(scoreFor(50), 0.01);
    assert.equal(scoreFor(100), 0.017);
    assert.equal(scoreFor(300), 0.033);
    assert.ok(scoreFor(300) > scoreFor(100) && scoreFor(100) > scoreFor(50), "pool term keeps growing");
  });
});

describe("ECA — analyzePendingTxs (evidence snapshot)", () => {
  it("captures selector, from, to and nonce for each relevant pending tx, capped", () => {
    const pending = Array.from({ length: 25 }, (_, i) =>
      pendingTx(AMM_ADDRESS, SWAP_DATA, OTHER_FROM, i + 1),
    );
    const r = analyzePendingTxs(evalTx(AMM_ADDRESS, SWAP_DATA), pending, Date.now());
    assert.equal(r.evidence.competingTxCount, 25);
    assert.equal(r.evidence.relevantTxs.length, 20, "evidence snapshot must be bounded");
    const first = r.evidence.relevantTxs[0];
    assert.equal(first.from, OTHER_FROM);
    assert.equal(first.to, AMM_ADDRESS);
    assert.equal(first.nonce, "1");
    assert.equal(first.selector, SWAP_DATA.slice(0, 10), "selector = first 4 bytes of calldata");
  });

  it("selector is null for empty / malformed calldata", () => {
    const pending = [pendingTx(AMM_ADDRESS, "0x", OTHER_FROM, 1), pendingTx(AMM_ADDRESS, undefined, OTHER_FROM, 2)];
    const r = analyzePendingTxs(evalTx(AMM_ADDRESS, SWAP_DATA), pending, Date.now());
    assert.equal(r.evidence.relevantTxs[0].selector, null);
    assert.equal(r.evidence.relevantTxs[1].selector, null);
  });
});

describe("ECA — flag ladder", () => {
  it("HIGH subsumes POTENTIAL — the flags array never carries both", () => {
    const pending = [
      pendingTx(AMM_ADDRESS, SWAP_DATA, OTHER_FROM, 1),
      pendingTx(AMM_ADDRESS, SWAP_DATA, OTHER_FROM, 2),
      pendingTx(UNRELATED_CONTRACT, "0xdeadbeef"),
      pendingTx(UNRELATED_CONTRACT, "0xdeadbeef"),
    ];
    const r = analyzePendingTxs(evalTx(AMM_ADDRESS, SWAP_DATA), pending, Date.now());
    assert.deepEqual(r.flags, ["HIGH_STATE_CONFLICT"]);
  });

  it("score rises steeply under extreme load but stays below 1 (anti-saturation)", () => {
    // 62 competing swaps + 1 unrelated claim tx — previously clamped at 1.0.
    const pending = [
      pendingTx(CLAIM_CONTRACT_ADDRESS, CLAIM_SLOT_3, OTHER_FROM, 1),
      ...Array.from({ length: 62 }, (_, i) => pendingTx(AMM_ADDRESS, SWAP_DATA, OTHER_FROM, 100 + i)),
    ];
    const r = analyzePendingTxs(evalTx(AMM_ADDRESS, SWAP_DATA), pending, Date.now());
    assert.ok(r.conflictScore > 0.9, `score ${r.conflictScore} should be very high`);
    assert.ok(r.conflictScore < 1, "diminishing-returns curve must not clamp at 1.0 early");
    assert.deepEqual(r.flags, ["HIGH_STATE_CONFLICT"]);
  });
});
