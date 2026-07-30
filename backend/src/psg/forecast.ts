import { createPublicClient, http, type Address, type Hex, type TransactionRequest, parseAbi } from "viem";
import { config } from "../config.js";

const { rpcUrl } = config;

let _publicClient: ReturnType<typeof createPublicClient> | null = null;

function getPublicClient(): ReturnType<typeof createPublicClient> | null {
  if (_publicClient) return _publicClient;
  if (!rpcUrl) return null;
  try {
    _publicClient = createPublicClient({
      chain: undefined,
      transport: http(rpcUrl),
    });
    return _publicClient;
  } catch {
    return null;
  }
}

const deployments = {
  MockAMM: "",
  MockClaim: "",
} as Record<string, string>;

export const MOCK_AMM_ADDRESS = (deployments.MockAMM || "") as Address;
export const MOCK_CLAIM_ADDRESS = (deployments.MockClaim || "") as Address;

export const mockAmmAbi = parseAbi([
  "error InsufficientOutputAmount(uint256 expected, uint256 actual)",
  "error InvalidLiquidityAmounts()",
  "error Unauthorized()",
  "error ReentrancyDetected()",
  "function getExpectedOutput(uint256 inputAmount, bool inputIsToken) view returns (uint256)",
  "function swap(uint256 minOutput, bool inputIsToken, uint256 inputAmount) payable",
  "function getReserves() view returns (uint256, uint256)",
]);

export const mockClaimAbi = parseAbi([
  "error SlotAlreadyClaimed(uint256 slotId)",
  "error InvalidSlot()",
  "function claim(uint256 slotId)",
  "function isClaimed(uint256 slotId) view returns (bool)",
  "function totalClaimed() view returns (uint256)",
  "function remainingSlots() view returns (uint256)",
]);

export const KNOWN_CONTRACTS = new Map<Address, { abi: readonly unknown[]; name: string }>([
  [MOCK_AMM_ADDRESS, { abi: mockAmmAbi, name: "MockAMM" }],
  [MOCK_CLAIM_ADDRESS, { abi: mockClaimAbi, name: "MockClaim" }],
]);

export type VantageTxRequest = {
  from: Address;
  to: Address;
  data: Hex;
  value: bigint;
};

export type PSGForecast = {
  simulationSuccess: boolean;
  revertReason: string | null;
  simulatedOutput: string | null;
  quotedOutput: string | null;
  outputDriftPercent: number | null;
  gasEstimate: string | null;
  timestamp: number;
};

function decodePanicCode(code: bigint): string {
  switch (code) {
    case 0x01n:
      return "Panic(0x01) — assertion failure";
    case 0x11n:
      return "Panic(0x11) — arithmetic overflow or underflow";
    case 0x12n:
      return "Panic(0x12) — division or modulo by zero";
    case 0x21n:
      return "Panic(0x21) — enum value out of range";
    case 0x22n:
      return "Panic(0x22) — storage byte array incorrectly encoded";
    case 0x31n:
      return "Panic(0x31) — incorrectly encoded storage array";
    case 0x32n:
      return "Panic(0x32) — pop on empty array";
    case 0x41n:
      return "Panic(0x41) — array index out of bounds";
    case 0x42n:
      return "Panic(0x42) — memory overflow";
    case 0x51n:
      return "Panic(0x51) — call stack too deep";
    default:
      return `Panic(0x${code.toString(16)}) — unknown panic`;
  }
}

export function decodeRevertReason(error: unknown): string {
  try {
    const err = error as { shortMessage?: string; message?: string };
    const errData = (error as { data?: string })?.data as string | undefined;

    if (!errData || errData.length < 10 || typeof errData !== "string") {
      return err.shortMessage ?? err.message ?? "Unknown revert";
    }

    const selectorHex = errData.slice(0, 10).toLowerCase();
    const argsHex = errData.slice(10);

    switch (selectorHex) {
      case "0x4e487b71": {
        if (argsHex.length < 64) return "Panic() — malformed data";
        const code = BigInt("0x" + argsHex.slice(-64));
        return decodePanicCode(code);
      }
case "0x08c379a0": {
          try {
            if (argsHex.length < 64) return "Error(string) — malformed";
            const stringLength = Number(BigInt("0x" + argsHex.slice(0, 64)));
            const neededHex = stringLength * 2;
            if (argsHex.length < 64 + neededHex) return "Error(string) — data truncated";
            const stringBytes = new Uint8Array(
              argsHex.slice(64, 64 + neededHex).match(/.{1,2}/g)?.map((b) => parseInt(b, 16)) ?? []
            );
            let end = stringBytes.length;
            while (end > 0 && stringBytes[end - 1] === 0) end--;
            const str = new TextDecoder().decode(stringBytes.slice(0, end));
            return `Error(string): "${str}"`;
          } catch {
            return "Error(string): (unable to decode)";
          }
        }
      case "0xf044e753": {
        if (argsHex.length < 128) return "InsufficientOutputAmount() — malformed";
        const expected = BigInt("0x" + argsHex.slice(0, 64));
        const actual = BigInt("0x" + argsHex.slice(64));
        return `InsufficientOutputAmount(expected=${expected}, actual=${actual})`;
      }
      case "0x6e73a2e0": {
        return "InvalidLiquidityAmounts()";
      }
      case "0xee1723e2": {
        return "Unauthorized()";
      }
      case "0x621b7346": {
        return "ReentrancyDetected()";
      }
      case "0xb41e7f1e": {
        if (argsHex.length < 64) return "SlotAlreadyClaimed() — malformed";
        const slotId = BigInt("0x" + argsHex.slice(-64));
        return `SlotAlreadyClaimed(slotId=${slotId})`;
      }
      case "0xfa0afd7e": {
        return "InvalidSlot()";
      }
      default: {
        return `Unknown error selector: ${selectorHex}`;
      }
    }
  } catch {
    return "Unable to decode revert reason";
  }
}

async function safeCall(
  client: NonNullParameters<typeof getPublicClient>[0],
  tx: VantageTxRequest
): Promise<{ data: Hex | null; gasUsed?: bigint } | null> {
  try {
    const result = await client.call({
      from: tx.from,
      to: tx.to,
      data: tx.data,
      value: tx.value > 0n ? tx.value : undefined,
    } as Parameters<typeof client.call>[0]);
    return { data: result.data, gasUsed: result.gasUsed };
  } catch {
    return null;
  }
}

export async function getForecast(
  tx: VantageTxRequest,
  quotedOutput?: bigint
): Promise<PSGForecast> {
  const timestamp = Date.now();

  const fallback = (revertReason: string): PSGForecast => ({
    simulationSuccess: false,
    revertReason,
    simulatedOutput: null,
    quotedOutput: quotedOutput !== undefined ? "0x" + quotedOutput.toString(16) : null,
    outputDriftPercent: null,
    gasEstimate: null,
    timestamp,
  });

  const client = getPublicClient();
  if (!client) {
    return fallback("No RPC URL configured — unable to simulate on-chain call");
  }

  try {
    let gasEstimate: bigint | null = null;
    try {
      const est = await client.estimateGas({
        from: tx.from,
        to: tx.to,
        data: tx.data,
        value: tx.value > 0n ? tx.value : undefined,
        account: tx.from,
      } as Parameters<typeof client.estimateGas>[0]);
      gasEstimate = est;
    } catch {
      gasEstimate = null;
    }

    const known = KNOWN_CONTRACTS.get(tx.to);
    const callResult = await safeCall(client, tx);

    if (callResult === null) {
      return fallback("Call reverted — could not decode revert reason from returned error");
    }

    if (callResult.data === null) {
      return fallback("Call returned no data");
    }

    let simulatedOutput: string | null = null;
    let outputDriftPercent: number | null = null;

    if (quotedOutput !== undefined) {
      try {
        const callData = callResult.data;
        if (callData && callData.length >= 66) {
          const decodedOutput = BigInt(callData as `0x${string}`);
          simulatedOutput = decodedOutput.toString();

          if (quotedOutput !== 0n) {
            const drift = Number((((decodedOutput - quotedOutput) * 10000n) / quotedOutput));
            outputDriftPercent = drift / 100;
          }
        }
      } catch {
        simulatedOutput = null;
        outputDriftPercent = null;
      }
    }

    return {
      simulationSuccess: true,
      revertReason: null,
      simulatedOutput,
      quotedOutput: quotedOutput !== undefined ? "0x" + quotedOutput.toString(16) : null,
      outputDriftPercent,
      gasEstimate: gasEstimate?.toString() ?? null,
      timestamp,
    };
  } catch (outerErr: unknown) {
    return fallback(decodeRevertReason(outerErr));
  }
}