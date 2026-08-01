import {
  createPublicClient,
  http,
  type Address,
  type Hex,
  parseAbi,
  toFunctionSelector,
  decodeFunctionData,
} from "viem";
import { monadTestnet } from "viem/chains";
import { simulateContract } from "viem/actions";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { config } from "../config.js";
import { getThreshold, DEFAULT_HOLD_THRESHOLD } from "../em/calibrator.js";

const { rpcUrl } = config;

let _publicClient: ReturnType<typeof createPublicClient> | null = null;

function getPublicClient(): ReturnType<typeof createPublicClient> | null {
  if (_publicClient) return _publicClient;
  if (!rpcUrl) return null;
  try {
    _publicClient = createPublicClient({
      chain: monadTestnet,
      transport: http(rpcUrl),
    });
    return _publicClient;
  } catch {
    return null;
  }
}

// ── Deployments from JSON ──────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEPLOYMENTS_PATH = resolve(__dirname, "../../../contracts/deployments.json");

function loadDeployments(): Record<string, string> {
  try {
    if (!existsSync(DEPLOYMENTS_PATH)) return {};
    const raw = readFileSync(DEPLOYMENTS_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

const deployments = loadDeployments();

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
  "function owner() view returns (address)",
  "function token() view returns (address)",
  "function manipulateReserves(uint256 newTokenReserve, uint256 newMonReserve)",
]);

export const mockClaimAbi = parseAbi([
  "error SlotAlreadyClaimed(uint256 slotId)",
  "error InvalidSlot()",
  "function claim(uint256 slotId)",
  "function isClaimed(uint256 slotId) view returns (bool)",
  "function totalClaimed() view returns (uint256)",
  "function remainingSlots() view returns (uint256)",
]);

// ERC-20 surface used only to recognise approve() calldata for the
// approval-exposure signal — deliberately minimal, not the full ERC-20.
const erc20ApproveAbi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
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
  nonce: number;
};

export type PSGForecast = {
  simulationSuccess: boolean;
  revertReason: string | null;
  simulatedOutput: string | null;
  quotedOutput: string | null;
  outputDriftPercent: number | null;
  gasEstimate: string | null;
  balanceSufficient: boolean | null;
  nonceCurrent: boolean | null;
  nonceIssue: "STALE" | "GAP" | null;
  contentionScore: number | null;
  riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  flags: string[];
  timestamp: number;
};

// ── Error selectors ────────────────────────────────────────────────────

const INSUFFICIENT_OUTPUT_AMOUNT_SELECTOR = toFunctionSelector(
  "InsufficientOutputAmount(uint256 expected, uint256 actual)",
);
const INVALID_LIQUIDITY_AMOUNTS_SELECTOR = toFunctionSelector("InvalidLiquidityAmounts()");
const UNAUTHORIZED_SELECTOR = toFunctionSelector("Unauthorized()");
const REENTRANCY_DETECTED_SELECTOR = toFunctionSelector("ReentrancyDetected()");
const SLOT_ALREADY_CLAIMED_SELECTOR = toFunctionSelector("SlotAlreadyClaimed(uint256 slotId)");
const INVALID_SLOT_SELECTOR = toFunctionSelector("InvalidSlot()");

// ── Panic code decoder ─────────────────────────────────────────────────

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

// ── Revert reason decoder ──────────────────────────────────────────────

/**
 * Walk the viem error cause chain to find the underlying revert hex data.
 * Viem nests errors: CallExecutionError → RawContractError (has .data),
 * or ContractFunctionExecutionError → ContractFunctionRevertedError (has .raw).
 * Returns the hex revert data string, or undefined if none found.
 */
function findViemRevertData(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const e = error as Record<string, unknown>;

  // ContractFunctionRevertedError stores the raw hex at .raw
  if (typeof e.raw === "string" && e.raw.startsWith("0x") && e.raw.length >= 10) {
    return e.raw;
  }

  // RawContractError / plain contract errors store the hex at .data
  if (typeof e.data === "string" && e.data.startsWith("0x") && e.data.length >= 10) {
    return e.data;
  }

  // Walk the cause chain
  if (e.cause) {
    return findViemRevertData(e.cause);
  }

  return undefined;
}

export function decodeRevertReason(error: unknown): string {
  try {
    const err = error as { shortMessage?: string; message?: string };

    // Walk viem error chain first (handles simulateContract / client.call errors).
    // Fall back to a direct .data check for plain error objects (test fixtures, older errors).
    const errData = findViemRevertData(error) ?? (error as { data?: string }).data;

    if (typeof errData !== "string" || errData.length < 10) {
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
          // ABI-encoded Error(string): selector + offset(0x20) + length + data.
          // Some providers emit a legacy layout with the length directly in the
          // first word — detect the standard offset form and fall back otherwise.
          const firstWord = argsHex.slice(0, 64);
          const standard = BigInt("0x" + firstWord) === 0x20n; // offset 0x20
          const lengthHex = standard ? argsHex.slice(64, 128) : firstWord;
          const rawLength = BigInt("0x" + lengthHex);
          if (rawLength > 10_000n) return "Error(string) — data truncated";
          const stringLength = Number(rawLength);
          const dataStart = standard ? 128 : 64;
          const neededHex = stringLength * 2;
          if (argsHex.length < dataStart + neededHex) return "Error(string) — data truncated";
          const stringBytes = new Uint8Array(
            argsHex.slice(dataStart, dataStart + neededHex).match(/.{1,2}/g)?.map((b) => parseInt(b, 16)) ?? []
          );
          let end = stringBytes.length;
          while (end > 0 && stringBytes[end - 1] === 0) end--;
          const str = new TextDecoder().decode(stringBytes.slice(0, end));
          return `Error(string): "${str}"`;
        } catch {
          return "Error(string): (unable to decode)";
        }
      }
      case INSUFFICIENT_OUTPUT_AMOUNT_SELECTOR: {
        if (argsHex.length < 128) return "InsufficientOutputAmount() — malformed";
        const expected = BigInt("0x" + argsHex.slice(0, 64));
        const actual = BigInt("0x" + argsHex.slice(64));
        return `InsufficientOutputAmount(expected=${expected}, actual=${actual})`;
      }
      case INVALID_LIQUIDITY_AMOUNTS_SELECTOR: {
        return "InvalidLiquidityAmounts()";
      }
      case UNAUTHORIZED_SELECTOR: {
        return "Unauthorized()";
      }
      case REENTRANCY_DETECTED_SELECTOR: {
        return "ReentrancyDetected()";
      }
      case SLOT_ALREADY_CLAIMED_SELECTOR: {
        if (argsHex.length < 64) return "SlotAlreadyClaimed() — malformed";
        const slotId = BigInt("0x" + argsHex.slice(-64));
        return `SlotAlreadyClaimed(slotId=${slotId})`;
      }
      case INVALID_SLOT_SELECTOR: {
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

// ── Low-level safe call ────────────────────────────────────────────────

async function safeCall(
  client: ReturnType<typeof createPublicClient>,
  tx: VantageTxRequest
): Promise<{ data: Hex | null; error?: unknown }> {
  try {
    const result = await client.call({
      from: tx.from,
      to: tx.to,
      data: tx.data,
      value: tx.value > 0n ? tx.value : undefined,
    } as Parameters<typeof client.call>[0]);
    return { data: result.data ?? null };
  } catch (err) {
    return { data: null, error: err };
  }
}

// ── Simulation forecast (existing, with quotedOutput fix) ──────────────

export async function getForecast(
  tx: VantageTxRequest,
  quotedOutput?: bigint
): Promise<PSGForecast> {
  const timestamp = Date.now();

  const base = (): PSGForecast => ({
    simulationSuccess: false,
    revertReason: null,
    simulatedOutput: null,
    quotedOutput: quotedOutput !== undefined ? quotedOutput.toString() : null,
    outputDriftPercent: null,
    gasEstimate: null,
    balanceSufficient: null,
    nonceCurrent: null,
    nonceIssue: null,
    contentionScore: null,
    riskLevel: "LOW",
    flags: [],
    timestamp,
  });

  const fallback = (revertReason: string): PSGForecast => ({
    ...base(),
    revertReason,
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

    if (known) {
      let decoded: { functionName: string; args: readonly unknown[] };
      try {
        decoded = decodeFunctionData({ abi: known.abi, data: tx.data });
      } catch {
        return fallback("Unable to decode function call data");
      }

      try {
        const simResult = await simulateContract(
          client,
          {
            address: tx.to,
            abi: known.abi,
            functionName: decoded.functionName,
            args: decoded.args as unknown[] | undefined,
            account: tx.from,
            value: tx.value > 0n ? tx.value : undefined,
          } as unknown as Parameters<typeof simulateContract>[1]
        );
        const resultValue = simResult.result as bigint | undefined;

        let simulatedOutput: string | null = null;
        let outputDriftPercent: number | null = null;

        if (decoded.functionName === "swap") {
          const swapArgs = decoded.args as readonly [bigint, boolean, bigint];
          const [, inputIsToken, inputAmount] = swapArgs;
          const expectedSim = await simulateContract(
            client,
            {
              address: tx.to,
              abi: mockAmmAbi,
              functionName: "getExpectedOutput",
              args: [inputAmount, inputIsToken],
              account: tx.from,
            } as unknown as Parameters<typeof simulateContract>[1]
          );
          const expectedOut = expectedSim.result as bigint | undefined;
          if (expectedOut !== undefined) {
            simulatedOutput = expectedOut.toString();
            if (quotedOutput !== undefined && quotedOutput !== 0n) {
              const drift = Number((((expectedOut - quotedOutput) * 10000n) / quotedOutput));
              outputDriftPercent = drift / 100;
            }
          }
        } else if (resultValue !== undefined) {
          simulatedOutput = resultValue.toString();
          if (quotedOutput !== undefined && quotedOutput !== 0n) {
            const drift = Number((((resultValue - quotedOutput) * 10000n) / quotedOutput));
            outputDriftPercent = drift / 100;
          }
        }

        return {
          ...base(),
          simulationSuccess: true,
          simulatedOutput,
          quotedOutput: quotedOutput !== undefined ? quotedOutput.toString() : null,
          outputDriftPercent,
          gasEstimate: gasEstimate?.toString() ?? null,
        };
      } catch (simErr) {
        return fallback(decodeRevertReason(simErr));
      }
    }

    const callResult = await safeCall(client, tx);

    if (callResult.error !== undefined) {
      return fallback(decodeRevertReason(callResult.error));
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
          // First 32-byte word only. Converting the whole blob turned a
          // (uint256 amount, uint256 fee) return of (100, 2) into ~3.4e40,
          // which then suppressed the drift check, was persisted into
          // forecast_json, and was handed to the explainer as fact.
          const decodedOutput = BigInt(`0x${callData.slice(2, 66)}`);
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
      ...base(),
      simulationSuccess: true,
      simulatedOutput,
      quotedOutput: quotedOutput !== undefined ? quotedOutput.toString() : null,
      outputDriftPercent,
      gasEstimate: gasEstimate?.toString() ?? null,
    };
  } catch (outerErr: unknown) {
    return fallback(decodeRevertReason(outerErr));
  }
}

// ── Pre-Submit Validity Checker ────────────────────────────────────────

/**
 * Check whether the account's nonce is current (no pending-tx gap / stale nonce)
 * and whether its balance covers the estimated gas cost plus tx value.
 *
 * Three-way nonce check against the chain's pending nonce:
 *   tx.nonce < pendingNonce  → stale (already used)
 *   tx.nonce === pendingNonce → ready to submit
 *   tx.nonce > pendingNonce  → gap (prior nonces need to land first)
 */
export async function checkValidity(
  tx: VantageTxRequest
): Promise<{
  nonceCurrent: boolean | null;
  nonceIssue: "STALE" | "GAP" | null;
  balanceSufficient: boolean | null;
}> {
  const client = getPublicClient();
  if (!client) return { nonceCurrent: null, nonceIssue: null, balanceSufficient: null };

  try {
    const pendingNonce = await client.getTransactionCount({
      address: tx.from,
      blockTag: "pending",
    });

    let nonceCurrent: boolean | null;
    let nonceIssue: "STALE" | "GAP" | null;

    if (tx.nonce < pendingNonce) {
      nonceCurrent = false;
      nonceIssue = "STALE";
    } else if (tx.nonce === pendingNonce) {
      nonceCurrent = true;
      nonceIssue = null;
    } else {
      nonceCurrent = false;
      nonceIssue = "GAP";
    }

    const [balance, gasPrice] = await Promise.all([
      client.getBalance({ address: tx.from }),
      client.getGasPrice().catch(() => null),
    ]);

    let balanceSufficient: boolean | null = null;
    if (gasPrice !== null) {
      try {
        const gasEstimate = await client
          .estimateGas({
            from: tx.from,
            to: tx.to,
            data: tx.data,
            value: tx.value > 0n ? tx.value : undefined,
            account: tx.from,
          } as Parameters<typeof client.estimateGas>[0])
          .catch(() => 100_000n); // fallback gas budget

        const gasCost = gasEstimate * gasPrice;
        const totalNeeded = gasCost + tx.value;
        balanceSufficient = balance >= totalNeeded;
      } catch {
        balanceSufficient = null;
      }
    }

    return { nonceCurrent, nonceIssue, balanceSufficient };
  } catch {
    return { nonceCurrent: null, nonceIssue: null, balanceSufficient: null };
  }
}

// ── Live Contention Scanner ────────────────────────────────────────────

// Contention window is time-based (not block-count-based) so it captures a
// fixed amount of real wall-clock activity regardless of block speed.
const CONTENTION_WINDOW_SECONDS = 180; // ~3 minutes of activity
const DEFAULT_BLOCK_TIME_SECONDS = 2; // conservative fallback — Monad testnet is faster, so this errs toward a wider window
const BLOCK_TIME_SAMPLE_MS = 2_000; // how far apart the two block samples are taken
const BLOCK_TIME_CACHE_TTL_MS = 60_000; // don't re-pay the sampling sleep on every poll iteration
const LOG_QUERY_CHUNK_BLOCKS = 100n; // the Monad testnet RPC rejects a single eth_getLogs wider than ~100 blocks

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

let cachedBlockTimeSeconds: number | null = null;
let cachedBlockTimeAt = 0;

/**
 * Estimate average block production time (seconds/block) by sampling the
 * latest block twice a couple of seconds apart. Falls back to a fixed
 * conservative estimate when the sample is degenerate or the RPC errors.
 *
 * Cached briefly so the hold-and-recheck poll loop does not re-pay the
 * sampling sleep on every iteration.
 */
async function estimateBlockTime(
  client: ReturnType<typeof createPublicClient>
): Promise<number> {
  if (
    cachedBlockTimeSeconds !== null &&
    Date.now() - cachedBlockTimeAt < BLOCK_TIME_CACHE_TTL_MS
  ) {
    return cachedBlockTimeSeconds;
  }

  const fallback = () => {
    cachedBlockTimeSeconds = DEFAULT_BLOCK_TIME_SECONDS;
    cachedBlockTimeAt = Date.now();
    return DEFAULT_BLOCK_TIME_SECONDS;
  };

  try {
    const first = await client.getBlock({ blockTag: "latest" });
    await sleep(BLOCK_TIME_SAMPLE_MS);
    const second = await client.getBlock({ blockTag: "latest" });

    const firstNum = first.number;
    const secondNum = second.number;
    if (firstNum === null || secondNum === null) return fallback();

    const blockDelta = secondNum - firstNum;
    const timeDelta = Number(second.timestamp - first.timestamp);

    // Need at least one new block and a measurable elapsed time to estimate.
    if (blockDelta <= 0n || timeDelta <= 0) return fallback();

    const blockTime = timeDelta / Number(blockDelta);
    if (!Number.isFinite(blockTime) || blockTime <= 0) return fallback();

    cachedBlockTimeSeconds = blockTime;
    cachedBlockTimeAt = Date.now();
    return blockTime;
  } catch {
    return fallback();
  }
}

/**
 * Block number roughly `CONTENTION_WINDOW_SECONDS` before `latestBlock`,
 * given an estimated seconds-per-block cadence. Clamped to the chain start.
 */
export function contentionWindowFromBlock(
  latestBlock: bigint,
  blockTimeSeconds: number
): bigint {
  const blocksAgo = Math.ceil(CONTENTION_WINDOW_SECONDS / blockTimeSeconds);
  const fromBlock = latestBlock - BigInt(blocksAgo);
  return fromBlock < 0n ? 0n : fromBlock;
}

/**
 * Fetch all logs for `address` across [fromBlock, toBlock], walking the
 * range in ≤100-block chunks. The Monad testnet RPC caps a single
 * eth_getLogs at ~100 blocks (HTTP 413), so a time-based window (~560
 * blocks at ~0.32s/block) must be fetched piecewise.
 */
async function getLogsChunked(
  client: ReturnType<typeof createPublicClient>,
  address: Address,
  fromBlock: bigint,
  toBlock: bigint
): Promise<unknown[]> {
  const logs: unknown[] = [];
  let cursor = fromBlock;

  while (cursor <= toBlock) {
    const chunkEnd =
      cursor + LOG_QUERY_CHUNK_BLOCKS - 1n < toBlock
        ? cursor + LOG_QUERY_CHUNK_BLOCKS - 1n
        : toBlock;
    const chunkLogs = await client.getLogs({
      address,
      fromBlock: cursor,
      toBlock: chunkEnd,
    });
    logs.push(...chunkLogs);
    if (chunkEnd >= toBlock) break;
    cursor = chunkEnd + 1n;
  }

  return logs;
}

/**
 * Score recent call density for a target contract address.
 * Polls event logs over the last ~3 minutes of activity and maps count to
 * [0.0, 1.0].  0 logs → 0.0,  20+ logs → 1.0.
 */
export async function getContentionScore(address: Address): Promise<number> {
  const client = getPublicClient();
  if (!client) return 0;

  try {
    const latestBlock = await client.getBlockNumber();
    const blockTimeSeconds = await estimateBlockTime(client);
    const fromBlock = contentionWindowFromBlock(latestBlock, blockTimeSeconds);

    const logs = await getLogsChunked(client, address, fromBlock, latestBlock);

    return Math.min(logs.length / 20, 1.0);
  } catch {
    return 0;
  }
}

/**
 * Count logs for `address` over the trailing `windowMs` plus the wall-clock
 * time of the most recent one. Reuses the chunked log walker so the Monad RPC
 * per-request block cap is respected. Used by the watchdog for the inactivity
 * alert — not a parallel scanner, just the existing one exposed with a window.
 */
export async function getRecentActivity(
  client: ReturnType<typeof createPublicClient>,
  address: Address,
  windowMs: number,
): Promise<{ logCount: number; lastLogAt: number | null }> {
  try {
    const latestBlock = await client.getBlockNumber();
    const blockTimeSeconds = await estimateBlockTime(client);
    const blocksAgo = Math.ceil(windowMs / 1000 / Math.max(blockTimeSeconds, 0.1));
    const fromBlock = latestBlock - BigInt(blocksAgo);
    const logs = await getLogsChunked(client, address, fromBlock < 0n ? 0n : fromBlock, latestBlock);

    let lastLogAt: number | null = null;
    if (logs.length > 0) {
      const newest = logs[logs.length - 1] as { blockNumber?: bigint };
      if (newest.blockNumber !== undefined) {
        const block = await client.getBlock({ blockNumber: newest.blockNumber });
        lastLogAt = Number(block.timestamp) * 1000;
      }
    }
    return { logCount: logs.length, lastLogAt };
  } catch {
    return { logCount: 0, lastLogAt: null };
  }
}

// ── Approval-exposure signal (approve-shaped calldata) ─────────────────

/**
 * Recognise an ERC-20 approve(spender, amount) call and decide whether it
 * grants the spender a large share of the sender's balance (>= 50%, mirroring
 * the watchdog's checkApprovalExposure threshold). Surfaced as the
 * APPROVAL_EXPOSURE forecast flag so the Guard console's "Unlimited approval"
 * card exercises the approval-exposure module synchronously in /api/evaluate —
 * not only via the background watchdog poll. Never throws: any unreadable or
 * non-approve call, or an account with no balance, is simply not flagged.
 */
async function checkApprovalExposure(tx: VantageTxRequest): Promise<boolean> {
  const client = getPublicClient();
  if (!client) return false;
  try {
    let decoded: { functionName: string; args: readonly unknown[] };
    try {
      decoded = decodeFunctionData({ abi: erc20ApproveAbi, data: tx.data });
    } catch {
      return false; // not an approve() call — leave untouched
    }
    if (decoded.functionName !== "approve") return false;
    const amount = decoded.args[1] as bigint;
    const balance = await client
      .readContract({
        address: tx.to,
        abi: erc20ApproveAbi,
        functionName: "balanceOf",
        args: [tx.from],
      })
      .catch(() => 0n);
    if (balance === 0n) return false; // nothing exposed to compare against
    return amount >= (balance * 50n) / 100n; // same >= 0.5 ratio as the watchdog
  } catch {
    return false;
  }
}

// ── Top-level PSG aggregator ───────────────────────────────────────────

/**
 * Derive a risk level from the set of signal flags.
 */
function deriveRiskLevel(
  flags: string[],
  contentionScore: number | null,
  holdThreshold: number = DEFAULT_HOLD_THRESHOLD
): "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" {
  if (flags.includes("REVERT")) return "CRITICAL";
  if (
    flags.includes("STALE_STATE") ||
    flags.includes("LOW_BALANCE") ||
    flags.includes("NONCE_STALE") ||
    flags.includes("NONCE_GAP")
  ) {
    return "HIGH";
  }
  if (flags.includes("HIGH_CONTENTION")) {
    // Threshold is the per-contract calibrated value (default 0.7), not a constant.
    return contentionScore !== null && contentionScore >= holdThreshold ? "HIGH" : "MEDIUM";
  }
  // An unlimited/large approval warrants caution, not a stop — same severity
  // as the watchdog's approval_exposure warning.
  if (flags.includes("APPROVAL_EXPOSURE")) return "MEDIUM";
  return "LOW";
}

/**
 * Run a full PSG forecast: simulate, check validity, score contention,
 * then merge everything into a single PSGForecast with a derived riskLevel
 * and human-readable flags array.
 */
export async function getPSGForecast(
  tx: VantageTxRequest,
  quotedOutput?: bigint
): Promise<PSGForecast> {
  const [forecast, validity, contentionScore, approvalExposure] = await Promise.all([
    getForecast(tx, quotedOutput),
    checkValidity(tx),
    getContentionScore(tx.to),
    checkApprovalExposure(tx),
  ]);

  const flags: string[] = [];

  if (!forecast.simulationSuccess && forecast.revertReason !== null) {
    flags.push("REVERT");
  }

  if (forecast.outputDriftPercent !== null && forecast.outputDriftPercent < -5) {
    flags.push("STALE_STATE");
  }

  if (validity.balanceSufficient === false) {
    flags.push("LOW_BALANCE");
  }

  if (validity.nonceCurrent === false) {
    if (validity.nonceIssue === "STALE") {
      flags.push("NONCE_STALE");
    } else {
      flags.push("NONCE_GAP");
    }
  }

  if (contentionScore >= 0.3) {
    flags.push("HIGH_CONTENTION");
  }

  if (approvalExposure) {
    flags.push("APPROVAL_EXPOSURE");
  }

  // Hold threshold comes from the per-contract calibrated history, falling
  // back to the 0.7 default when the ledger has no calibration yet.
  const holdThreshold = getThreshold(tx.to);
  const riskLevel = deriveRiskLevel(flags, contentionScore, holdThreshold);

  return {
    ...forecast,
    nonceCurrent: validity.nonceCurrent,
    nonceIssue: validity.nonceIssue,
    balanceSufficient: validity.balanceSufficient,
    contentionScore,
    riskLevel,
    flags,
  };
}