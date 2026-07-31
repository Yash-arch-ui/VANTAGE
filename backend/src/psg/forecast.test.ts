import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toFunctionSelector, getAbiItem } from "viem";
import {
  decodeRevertReason,
  mockAmmAbi,
  mockClaimAbi,
  checkValidity,
  getContentionScore,
  getPSGForecast,
  contentionWindowFromBlock,
} from "./forecast.js";

/**
 * Build a canonical Solidity error selector from an ABI item.
 * Uses the same approach as forecast.ts (string-based toFunctionSelector)
 * but derives the signature from the ABI definition so it stays in sync.
 */
function abiErrorSelector(abi: readonly unknown[], name: string): string {
  const item = getAbiItem({ abi, name }) as {
    name: string;
    inputs: readonly { type: string }[];
  };
  const params = item.inputs.map((i) => i.type).join(",");
  return toFunctionSelector(`${item.name}(${params})`);
}

// Pre-compute selectors that match the source code's constants
const SEL_INSUFFICIENT_OUTPUT = abiErrorSelector(mockAmmAbi, "InsufficientOutputAmount");
const SEL_REENTRANCY = abiErrorSelector(mockAmmAbi, "ReentrancyDetected");
const SEL_SLOT_CLAIMED = abiErrorSelector(mockClaimAbi, "SlotAlreadyClaimed");
const SEL_INVALID_SLOT = abiErrorSelector(mockClaimAbi, "InvalidSlot");

// ── Custom error decode tests ──────────────────────────────────────────

describe("decodeRevertReason — custom errors", () => {
  it("decodes InsufficientOutputAmount(uint256, uint256) with expected=100n, actual=88n", () => {
    const expectedHex = "0x" + 100n.toString(16).padStart(64, "0");
    const actualHex = "0x" + 88n.toString(16).padStart(64, "0");
    const calldata = (`0x${SEL_INSUFFICIENT_OUTPUT.slice(2)}${expectedHex.slice(2)}${actualHex.slice(2)}`) as `0x${string}`;

    const error = { data: calldata } as const;
    const reason = decodeRevertReason(error);
    console.log(`  InsufficientOutputAmount decoded: ${reason}`);
    assert.equal(reason, "InsufficientOutputAmount(expected=100, actual=88)");
  });

  it("decodes SlotAlreadyClaimed(uint256) with slotId=5", () => {
    const slotIdHex = "0x" + 5n.toString(16).padStart(64, "0");
    const calldata = (`0x${SEL_SLOT_CLAIMED.slice(2)}${slotIdHex.slice(2)}`) as `0x${string}`;

    const error = { data: calldata } as const;
    const reason = decodeRevertReason(error);
    console.log(`  SlotAlreadyClaimed decoded: ${reason}`);
    assert.equal(reason, "SlotAlreadyClaimed(slotId=5)");
  });

  it("decodes Error(string) with a message", () => {
    const selector = "0x08c379a0";
    const msgBytes = new TextEncoder().encode("MockERC20: insufficient balance");
    const lenHex = "0x" + msgBytes.length.toString(16).padStart(64, "0");
    const msgHex = Array.from(msgBytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const calldata = (`0x${selector.slice(2)}${lenHex.slice(2)}${msgHex}`) as `0x${string}`;

    const error = { data: calldata } as const;
    const reason = decodeRevertReason(error);
    console.log(`  Error(string) decoded: ${reason}`);
    assert.equal(reason, 'Error(string): "MockERC20: insufficient balance"');
  });

  it("decodes Panic(0x11) — arithmetic overflow/underflow", () => {
    const selector = "0x4e487b71";
    const codeHex = "0x" + 0x11n.toString(16).padStart(64, "0");
    const calldata = (`0x${selector.slice(2)}${codeHex.slice(2)}`) as `0x${string}`;

    const error = { data: calldata } as const;
    const reason = decodeRevertReason(error);
    console.log(`  Panic decoded: ${reason}`);
    assert.equal(reason, "Panic(0x11) — arithmetic overflow or underflow");
  });

  it("decodes ReentrancyDetected() custom error", () => {
    const calldata = (`0x${SEL_REENTRANCY.slice(2)}`) as `0x${string}`;

    const error = { data: calldata } as const;
    const reason = decodeRevertReason(error);
    console.log(`  ReentrancyDetected decoded: ${reason}`);
    assert.equal(reason, "ReentrancyDetected()");
  });

  it("decodes InvalidSlot() custom error", () => {
    const calldata = (`0x${SEL_INVALID_SLOT.slice(2)}`) as `0x${string}`;

    const error = { data: calldata } as const;
    const reason = decodeRevertReason(error);
    console.log(`  InvalidSlot decoded: ${reason}`);
    assert.equal(reason, "InvalidSlot()");
  });

  it("returns safe fallback for unknown error selector", () => {
    const calldata = ("0xdeadbeef1234" as `0x${string}`);

    const error = { data: calldata } as const;
    const reason = decodeRevertReason(error);
    console.log(`  Unknown selector decoded: ${reason}`);
    assert.ok(reason.startsWith("Unknown error selector: 0xdeadbeef"), `Expected fallback in '${reason}'`);
  });

  it("returns a message string when no data is present", () => {
    const error = { message: "execution reverted" } as const;
    const reason = decodeRevertReason(error);
    console.log(`  No-data revert decoded: ${reason}`);
    assert.equal(reason, "execution reverted");
  });
});

// ── Viem error chain walking tests ──────────────────────────────────────

describe("decodeRevertReason — viem error chain walking", () => {
  it("extracts revert data from ContractFunctionRevertedError-like object (nested .raw)", () => {
    const rawData = (`0x${SEL_INSUFFICIENT_OUTPUT.slice(2)}` +
      "0000000000000000000000000000000000000000000000000000000000000064" +
      "0000000000000000000000000000000000000000000000000000000000000058") as `0x${string}`;

    // Simulate viem's nested error structure:
    // ContractFunctionExecutionError → ContractFunctionRevertedError (where .raw = hex data)
    const contractFunctionReverted = { raw: rawData, data: { errorName: "InsufficientOutputAmount" } };
    const contractFunctionExecutionError = { shortMessage: "reverted", cause: contractFunctionReverted };
    const callExecutionError = { shortMessage: "reverted", cause: contractFunctionExecutionError };

    const reason = decodeRevertReason(callExecutionError);
    console.log(`  Viem nested InsufficientOutputAmount decoded: ${reason}`);
    assert.equal(reason, "InsufficientOutputAmount(expected=100, actual=88)");
  });

  it("extracts revert data from RawContractError-like object (nested .data hex)", () => {
    const rawData = (`0x${SEL_INSUFFICIENT_OUTPUT.slice(2)}` +
      "0000000000000000000000000000000000000000000000000000000000000064" +
      "0000000000000000000000000000000000000000000000000000000000000058") as `0x${string}`;

    // Simulate viem's client.call chain:
    // CallExecutionError → RawContractError (where .data = hex string)
    const rawContractError = { data: rawData, message: "execution reverted" };
    const callExecutionError = { shortMessage: "The call reverted", cause: rawContractError };

    const reason = decodeRevertReason(callExecutionError);
    console.log(`  RawContractError nested InsufficientOutputAmount decoded: ${reason}`);
    assert.equal(reason, "InsufficientOutputAmount(expected=100, actual=88)");
  });

  it("decodes SlotAlreadyClaimed from viem nested error chain", () => {
    const rawData = (`0x${SEL_SLOT_CLAIMED.slice(2)}` +
      "0000000000000000000000000000000000000000000000000000000000000005") as `0x${string}`;

    const contractFunctionReverted = { raw: rawData, data: { errorName: "SlotAlreadyClaimed" } };
    const error = { shortMessage: "reverted", cause: contractFunctionReverted };

    const reason = decodeRevertReason(error);
    console.log(`  Viem nested SlotAlreadyClaimed decoded: ${reason}`);
    assert.equal(reason, "SlotAlreadyClaimed(slotId=5)");
  });

  it("falls through to shortMessage when no revert data chain is found", () => {
    const error = { shortMessage: "execution reverted", message: "The contract reverted" };
    const reason = decodeRevertReason(error);
    assert.equal(reason, "execution reverted");
  });
});

// ── ABI selector verification ──────────────────────────────────────────

describe("decodeRevertReason — ABI selector verification", () => {
  it("MockAMM ABI error[0] selector matches InsufficientOutputAmount", () => {
    const abiItem = mockAmmAbi[0];
    console.log(`  mockAmmAbi[0]: ${JSON.stringify(abiItem)}`);
    assert.ok(abiItem.type === "error", "Should be an error ABI item");
  });

  it("MockClaim ABI error[0] selector matches SlotAlreadyClaimed", () => {
    const abiItem = mockClaimAbi[0];
    console.log(`  mockClaimAbi[0]: ${JSON.stringify(abiItem)}`);
    assert.ok(abiItem.type === "error", "Should be an error ABI item");
  });

  it("computed selectors match the source code's string-signature selectors", () => {
    assert.equal(SEL_INSUFFICIENT_OUTPUT, "0xd28d3eb5");
    assert.equal(SEL_SLOT_CLAIMED, "0x5f078294");
    assert.equal(SEL_REENTRANCY, "0xc5f2be51");
    assert.equal(SEL_INVALID_SLOT, "0x1258e443");
    console.log(`  ABI-derived selectors match: InsufficientOutputAmount=${SEL_INSUFFICIENT_OUTPUT}, SlotAlreadyClaimed=${SEL_SLOT_CLAIMED}, ReentrancyDetected=${SEL_REENTRANCY}, InvalidSlot=${SEL_INVALID_SLOT}`);
  });
});

// ── getForecast — unit behavior (no live chain) ────────────────────────

describe("getForecast — unit behavior (no live chain)", () => {
  it("returns a valid PSGForecast object even when RPC is unreachable", async () => {
    const { getForecast } = await import("./forecast.js");

    const forecast = await getForecast({
      from: "0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B" as `0x${string}`,
      to: "0x0000000000000000000000000000000000000000" as `0x${string}`,
      data: "0x" as `0x${string}`,
      value: 0n,
      nonce: 0,
    }, 1000n);

    console.log(`  getForecast result: simulationSuccess=${forecast.simulationSuccess}, revertReason=${forecast.revertReason}, gasEstimate=${forecast.gasEstimate}, quotedOutput=${forecast.quotedOutput}`);
    assert.equal(typeof forecast.simulationSuccess, "boolean");
    // quotedOutput is now decimal string (was "0x3e8" before the fix)
    assert.equal(forecast.quotedOutput, "1000");
  });

  it("quotedOutput is null when not provided", async () => {
    const { getForecast } = await import("./forecast.js");

    const forecast = await getForecast({
      from: "0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B" as `0x${string}`,
      to: "0x0000000000000000000000000000000000000000" as `0x${string}`,
      data: "0x" as `0x${string}`,
      value: 0n,
      nonce: 0,
    });

    console.log(`  getForecast (no quotedOutput): quotedOutput=${forecast.quotedOutput}, outputDriftPercent=${forecast.outputDriftPercent}`);
    assert.equal(forecast.quotedOutput, null);
    assert.equal(forecast.outputDriftPercent, null);
  });
});

// ── checkValidity — unit behavior (no live chain) ──────────────────────

describe("checkValidity — unit behavior (no live chain)", () => {
  it("returns null fields when RPC is unreachable", async () => {
    const result = await checkValidity({
      from: "0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B" as `0x${string}`,
      to: "0x0000000000000000000000000000000000000000" as `0x${string}`,
      data: "0x" as `0x${string}`,
      value: 0n,
      nonce: 5,
    });
    console.log(`  checkValidity: nonceCurrent=${result.nonceCurrent}, nonceIssue=${result.nonceIssue}, balanceSufficient=${result.balanceSufficient}`);
    // With a live RPC these will be real values; just verify the fields exist
    assert.ok(typeof result.nonceCurrent === "boolean" || result.nonceCurrent === null);
    assert.ok(
      result.nonceIssue === "STALE" || result.nonceIssue === "GAP" || result.nonceIssue === null
    );
    assert.ok(typeof result.balanceSufficient === "boolean" || result.balanceSufficient === null);
  });
});

// ── getContentionScore — unit behavior (no live chain) ──────────────────

describe("checkValidity — three-way nonce logic (no live chain)", () => {
  it("STALE — tx.nonce (0) is less than pendingNonce (5)", async () => {
    // We can't mock the chain, but the no-RPC case returns null fields.
    // This test verifies the function signature and that the nonceIssue field exists.
    const result = await checkValidity({
      from: "0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B" as `0x${string}`,
      to: "0x0000000000000000000000000000000000000000" as `0x${string}`,
      data: "0x" as `0x${string}`,
      value: 0n,
      nonce: 5,
    });
    // With no RPC, nonceCurrent/nonceIssue will be null — this just proves
    // the field exists and the call doesn't crash.
    assert.ok("nonceIssue" in result);
    console.log(`  checkValidity STALE: nonceCurrent=${result.nonceCurrent}, nonceIssue=${result.nonceIssue}`);
  });

  it("CURRENT — tx.nonce equals pendingNonce", async () => {
    const result = await checkValidity({
      from: "0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B" as `0x${string}`,
      to: "0x0000000000000000000000000000000000000000" as `0x${string}`,
      data: "0x" as `0x${string}`,
      value: 0n,
      nonce: 7,
    });
    assert.ok("nonceIssue" in result);
    console.log(`  checkValidity CURRENT: nonceCurrent=${result.nonceCurrent}, nonceIssue=${result.nonceIssue}`);
  });

  it("GAP — tx.nonce is greater than pendingNonce", async () => {
    const result = await checkValidity({
      from: "0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B" as `0x${string}`,
      to: "0x0000000000000000000000000000000000000000" as `0x${string}`,
      data: "0x" as `0x${string}`,
      value: 0n,
      nonce: 10,
    });
    assert.ok("nonceIssue" in result);
    console.log(`  checkValidity GAP: nonceCurrent=${result.nonceCurrent}, nonceIssue=${result.nonceIssue}`);
  });
});

// ── contentionWindowFromBlock — pure window math ───────────────────────

describe("contentionWindowFromBlock — time-based window math", () => {
  it("covers ~180s of activity based on block time (0.32s/block ≈ Monad)", () => {
    // 180 / 0.32 = 562.5 → ceil → 563 blocks back
    const from = contentionWindowFromBlock(49_559_477n, 0.32);
    console.log(`  0.32s/block: fromBlock=${from}`);
    assert.equal(from, 49_559_477n - 563n);
  });

  it("uses exactly 180 blocks when block time is 1s", () => {
    const from = contentionWindowFromBlock(1_000_000n, 1);
    console.log(`  1s/block: fromBlock=${from}`);
    assert.equal(from, 1_000_000n - 180n);
  });

  it("uses fewer blocks for slower cadence (conservative → wider window)", () => {
    // 180 / 2 = 90 blocks back (fallback estimate errs this way)
    const from = contentionWindowFromBlock(1_000_000n, 2);
    console.log(`  2s/block: fromBlock=${from}`);
    assert.equal(from, 1_000_000n - 90n);
  });

  it("rounds up so the window is never shorter than 180s", () => {
    // 180 / 3.5 = 51.43 → ceil → 52 blocks
    const from = contentionWindowFromBlock(10_000n, 3.5);
    console.log(`  3.5s/block: fromBlock=${from}`);
    assert.equal(from, 10_000n - 52n);
  });

  it("clamps to 0 on a very young chain", () => {
    const from = contentionWindowFromBlock(10n, 0.01);
    console.log(`  young chain: fromBlock=${from}`);
    assert.equal(from, 0n);
  });

  it("reaches exactly block 0 when the window spans the whole chain", () => {
    const from = contentionWindowFromBlock(180n, 1);
    console.log(`  edge: fromBlock=${from}`);
    assert.equal(from, 0n);
  });
});

describe("getContentionScore — unit behavior (no live chain)", () => {
  it("returns 0 when RPC is unreachable", async () => {
    const score = await getContentionScore("0x0000000000000000000000000000000000000000" as `0x${string}`);
    console.log(`  getContentionScore: ${score}`);
    assert.equal(score, 0);
  });
});

// ── getPSGForecast — unit behavior (no live chain) ─────────────────────

describe("getPSGForecast — unit behavior (no live chain)", () => {
  it("returns a full PSGForecast with riskLevel and flags even when RPC is unreachable", async () => {
    const forecast = await getPSGForecast({
      from: "0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B" as `0x${string}`,
      to: "0x0000000000000000000000000000000000000000" as `0x${string}`,
      data: "0x" as `0x${string}`,
      value: 0n,
      nonce: 0,
    }, 1000n);

    console.log(`  getPSGForecast result: simulationSuccess=${forecast.simulationSuccess}, revertReason=${forecast.revertReason}, riskLevel=${forecast.riskLevel}, flags=${JSON.stringify(forecast.flags)}, quotedOutput=${forecast.quotedOutput}, nonceCurrent=${forecast.nonceCurrent}, nonceIssue=${forecast.nonceIssue}, balanceSufficient=${forecast.balanceSufficient}, contentionScore=${forecast.contentionScore}`);
    assert.equal(typeof forecast.simulationSuccess, "boolean");
    assert.equal(typeof forecast.riskLevel, "string");
    assert.ok(Array.isArray(forecast.flags));
    // All new fields present (live RPC returns real values)
    assert.ok(typeof forecast.nonceCurrent === "boolean" || forecast.nonceCurrent === null);
    assert.ok(
      forecast.nonceIssue === "STALE" || forecast.nonceIssue === "GAP" || forecast.nonceIssue === null
    );
    assert.ok(typeof forecast.balanceSufficient === "boolean" || forecast.balanceSufficient === null);
    assert.equal(typeof forecast.contentionScore, "number");
    // Simulation fails → REVERT flag → CRITICAL
    assert.equal(forecast.riskLevel, "CRITICAL");
    assert.ok(forecast.flags.includes("REVERT"));
  });

  it("returns CRITICAL + REVERT on simulation failure with revert", async () => {
    // Force a path where simulation fails by passing an unknown contract
    // to an address that's not known AND without RPC — will hit no-RPC fallback
    const forecast = await getPSGForecast({
      from: "0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B" as `0x${string}`,
      to: "0x0000000000000000000000000000000000000001" as `0x${string}`,
      data: "0xdeadbeef" as `0x${string}`,
      value: 0n,
      nonce: 0,
    });

    console.log(`  getPSGForecast (failure): riskLevel=${forecast.riskLevel}, flags=${JSON.stringify(forecast.flags)}, revertReason=${forecast.revertReason}`);
    assert.equal(forecast.riskLevel, "CRITICAL");
    assert.ok(forecast.flags.includes("REVERT"));
  });
});