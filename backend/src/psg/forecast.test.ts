import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decodeRevertReason } from "./forecast.js";
import { mockAmmAbi, mockClaimAbi } from "./forecast.js";

describe("decodeRevertReason — custom errors", () => {
  it("decodes InsufficientOutputAmount(uint256, uint256) with expected=100n, actual=88n", () => {
    const selector = "0xf044e753";
    const expectedHex = "0x" + 100n.toString(16).padStart(64, "0");
    const actualHex = "0x" + 88n.toString(16).padStart(64, "0");
    const calldata = (`0x${selector.slice(2)}${expectedHex.slice(2)}${actualHex.slice(2)}`) as `0x${string}`;

    const error = { data: calldata } as const;
    const reason = decodeRevertReason(error);
    console.log(`  InsufficientOutputAmount decoded: ${reason}`);
    assert.equal(reason, "InsufficientOutputAmount(expected=100, actual=88)");
  });

  it("decodes SlotAlreadyClaimed(uint256) with slotId=5", () => {
    const selector = "0xb41e7f1e";
    const slotIdHex = "0x" + 5n.toString(16).padStart(64, "0");
    const calldata = (`0x${selector.slice(2)}${slotIdHex.slice(2)}`) as `0x${string}`;

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
    const selector = "0x621b7346";
    const calldata = (`0x${selector.slice(2)}`) as `0x${string}`;

    const error = { data: calldata } as const;
    const reason = decodeRevertReason(error);
    console.log(`  ReentrancyDetected decoded: ${reason}`);
    assert.equal(reason, "ReentrancyDetected()");
  });

  it("decodes InvalidSlot() custom error", () => {
    const selector = "0xfa0afd7e";
    const calldata = (`0x${selector.slice(2)}`) as `0x${string}`;

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
});

describe("getForecast — unit behavior (no live chain)", () => {
  it("returns a valid PSGForecast object even when RPC is unreachable", async () => {
    const { getForecast } = await import("./forecast.js");

    const forecast = await getForecast({
      from: "0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B" as `0x${string}`,
      to: "0x0000000000000000000000000000000000000000" as `0x${string}`,
      data: "0x" as `0x${string}`,
      value: 0n,
    }, 1000n);

    console.log(`  getForecast result: simulationSuccess=${forecast.simulationSuccess}, revertReason=${forecast.revertReason}, gasEstimate=${forecast.gasEstimate}`);
    assert.equal(typeof forecast.simulationSuccess, "boolean");
    assert.equal(forecast.quotedOutput, "0x3e8");
  });

  it("quotedOutput is null when not provided", async () => {
    const { getForecast } = await import("./forecast.js");

    const forecast = await getForecast({
      from: "0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B" as `0x${string}`,
      to: "0x0000000000000000000000000000000000000000" as `0x${string}`,
      data: "0x" as `0x${string}`,
      value: 0n,
    });

    console.log(`  getForecast (no quotedOutput): quotedOutput=${forecast.quotedOutput}, outputDriftPercent=${forecast.outputDriftPercent}`);
    assert.equal(forecast.quotedOutput, null);
    assert.equal(forecast.outputDriftPercent, null);
  });
});