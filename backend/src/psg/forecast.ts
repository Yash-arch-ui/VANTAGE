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

export function getPublicClient(): ReturnType<typeof createPublicClient> | null {
  if (_publicClient) return _publicClient;
  if (!rpcUrl) return null;
  try {
    _publicClient = createPublicClient({
      chain: monadTestnet,
      transport: http(rpcUrl, { timeout: 15_000 }),
    });
    return _publicClient;
  } catch {
    return null;
  }
}

// ── Deployments from JSON ──────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Candidate locations for deployments.json.
 *
 * 1. Full-monorepo layout (local dev, or a deploy that ships the whole repo):
 *    <repo>/contracts/deployments.json — reached via ../../../ from src/psg or
 *    dist/psg.
 * 2. Backend-only deploy (rootDir: backend, so contracts/ is never present):
 *    backend/deployments.json — committed copy kept in sync with
 *    contracts/deployments.json (reached via ../../ from src/psg or dist/psg).
 * 3. dist/deployments.json — copied in by scripts/copy-assets.mjs from either
 *    of the above.
 *
 * Without the file, KNOWN_CONTRACTS stays empty and every call takes the
 * generic path — which, combined with the old `from:` bug, made the deployed
 * backend report "insufficient allowance" for every swap.
 */
const DEPLOYMENTS_CANDIDATES = [
  resolve(__dirname, "../../../contracts/deployments.json"),
  resolve(__dirname, "../../deployments.json"),
  resolve(__dirname, "../deployments.json"),
];

function loadDeployments(): Record<string, string> {
  for (const candidate of DEPLOYMENTS_CANDIDATES) {
    try {
      if (existsSync(candidate)) {
        const raw = readFileSync(candidate, "utf-8");
        return JSON.parse(raw);
      }
    } catch {
      // try the next candidate
    }
  }
  return {};
}

const deployments = loadDeployments();

export const AMM_ADDRESS = (deployments.AMM || "") as Address;
export const CLAIM_CONTRACT_ADDRESS = (deployments.ClaimContract || "") as Address;

export const ammAbi = parseAbi([
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

export const claimContractAbi = parseAbi([
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
  [AMM_ADDRESS, { abi: ammAbi, name: "AMM" }],
  [CLAIM_CONTRACT_ADDRESS, { abi: claimContractAbi, name: "ClaimContract" }],
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
  /** ECA contract-level conflict estimator, 0–1. Null when never scanned. */
  conflictScore?: number | null;
  /** Conflict flags raised by the ECA: POTENTIAL_STATE_CONFLICT | HIGH_STATE_CONFLICT. */
  conflictFlags?: ConflictFlag[];
  /** Deterministic evidence snapshot behind conflictScore (persisted to the audit ledger). */
  conflictEvidence?: ConflictEvidence | null;
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
    // `account` (not `from`) sets the eth_call sender — viem silently drops
    // `from`, so a swap from a max-allowance wallet was simulated as address(0)
    // and always reverted with a phantom "MockERC20: insufficient allowance".
    const result = await client.call({
      account: tx.from,
      to: tx.to,
      data: tx.data,
      value: tx.value > 0n ? tx.value : undefined,
    } as Parameters<typeof client.call>[0]);
    return { data: result.data ?? null };
  } catch (err) {
    return { data: null, error: err };
  }
}

// ── Drift math ────────────────────────────────────────────────────────

/**
 * Signed percentage drift between what the chain currently returns and the
 * quote the user was shown: (simulated - quoted) / quoted * 100.
 *
 * Measured against the caller's `quoted` — for a background recheck that is
 * the ORIGINAL quote persisted on the ledger entry, never a freshly re-quoted
 * price, so a pool move shows up as a real number instead of being
 * re-baselined away. One formula, shared by the known-contract and generic
 * simulation paths.
 */
export function computeDriftPercent(simulated: bigint, quoted: bigint): number {
  return Number(((simulated - quoted) * 10_000n) / quoted) / 100;
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
    conflictScore: null,
    conflictFlags: [],
    conflictEvidence: null,
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
          // A MON→token swap ignores inputAmount and spends msg.value instead,
          // so the drift comparison must quote against the same number the swap
          // actually moves — otherwise every MON swap decodes as input 0 and
          // reads as a constant −100% drift.
          const swapInput = inputIsToken ? inputAmount : tx.value;
          const expectedSim = await simulateContract(
            client,
            {
              address: tx.to,
              abi: ammAbi,
              functionName: "getExpectedOutput",
              args: [swapInput, inputIsToken],
              account: tx.from,
            } as unknown as Parameters<typeof simulateContract>[1]
          );
          const expectedOut = expectedSim.result as bigint | undefined;
          if (expectedOut !== undefined) {
            simulatedOutput = expectedOut.toString();
            if (quotedOutput !== undefined && quotedOutput !== 0n) {
              outputDriftPercent = computeDriftPercent(expectedOut, quotedOutput);
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
            outputDriftPercent = computeDriftPercent(decodedOutput, quotedOutput);
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

// ── Execution Conflict Analyzer (ECA) — contract-level ─────────────────
//
// A deterministic, evidence-based estimator of execution conflict at the
// CONTRACT level (per the ECA spec: no storage-slot tracing, no OCC
// reconstruction, and never a claim of true conflict detection).
//
// The mempool is enumerated through the pending block — the one primitive the
// public Monad RPC exposes. The Stage 0 capability probe showed txpool_content
// and txpool_inspect answer -32601 "Method not found", while
// eth_getBlockByNumber("pending", true) returns full pending transactions
// (hash, from, to, input, nonce, gasPrice, value). When that call degrades,
// the scanner falls back to the log/calldata strategy (log density on the
// target contract, via the existing getContentionScore).
//
// Signals (all counts come from the pending block, pre-filtered for viability
// and same-sender serialization, and excluding the transaction being evaluated
// itself — matched on from+nonce so a recheck of an already-submitted tx never
// counts itself):
//   sameContract     — viable, other-sender pending txs to the evaluated target
//   competingSwap    — pending swap() calls on the AMM (evaluated tx is a swap)
//   poolWriter       — pending non-swap reserve movers decoded from the AMM ABI
//                      (evaluated tx is a swap) — half-weight direct conflicts
//   competingClaim   — pending claim(slotId) calls for the SAME slot (eval is a claim)
//   poolPressure     — viable pending txs chain-wide (mempool load context)
//
// Score (recalibrated v3 — audit-driven constant rebalance. Same curve family
// g(n, k) = n / (n + k), but the weights and curve shapes now read the audit
// findings):
//   g(n, k) = n / (n + k)
//   sameContractScore   = g(competingTxCount, 2)
//   directConflictScore = g(effDirect, 1)              // effDirect = swaps + 0.5·writers
//                         g(competingClaimCount, 0.5)  // same-slot claims: winner-take-all
//   poolPressureScore   = g(pendingPoolSize, 250)
//   conflictScore = min(1, 0.08·sameContractScore + 0.86·directConflictScore + 0.06·poolPressureScore)
//
// Flags (severity ladder — HIGH subsumes POTENTIAL):
//   POTENTIAL_STATE_CONFLICT at conflictScore >= 0.30 (mirrors the HIGH_CONTENTION floor)
//   HIGH_STATE_CONFLICT      at conflictScore >= 0.60
//
// The 0.30 / 0.60 policy thresholds are unchanged, and every policy anchor
// survives — one direct competitor → POTENTIAL (WARN), two → HIGH (HOLD), a
// single same-slot claim → HIGH, ambient-only pressure never flags. What
// changed (v3 calibration):
//   - direct-conflict weight 0.80 → 0.86: the score is dominated by the
//     question "who is racing me", not "what is near me";
//   - same-contract weight 0.14 → 0.08 AND curve k 1 → 2: ambient context
//     rises half as fast, so 25 undecodable same-contract txs now contribute
//     ≈0.074 instead of ≈0.135 — a wide margin below the 0.30 flag floor;
//   - claim curve k 0.4 → 0.5: same-slot claims stay winner-take-all (one
//     claim → HIGH) but the 2→25 same-slot-claim range now discriminates
//     (≈0.15 → ≈0.19 of score spread instead of flattening at ~0.88);
//   - pool curve k 300 → 250: chain-wide pressure responds sooner — at 150
//     pending txs its contribution roughly doubles (≈0.013 → ≈0.025).
//
// Why not flatten the swap/direct curve further? The policy anchors cap the
// dynamic range: two competing swaps must score ≥ 0.60 (HIGH) and a single
// swap must stay under 0.60, which pins the direct curve to k ≈ 1 and the
// combined non-pool weight to ≈ 0.94 — the 2→25 competitor spread is bounded
// at ≈ 0.33 by construction. The v3 rebalance widens the measured spread to
// the achievable maximum (≈0.28 → ≈0.29 for swaps, ≈0.15 → ≈0.19 for claims)
// without crossing an anchor. Ambient same-contract + pool pressure alone can
// never reach even POTENTIAL (max 0.08 + 0.06 = 0.14): some direct evidence is
// required to flag. In the logs-fallback the score caps at contention·0.5 ≤ 0.5,
// so HIGH_STATE_CONFLICT is never claimed without mempool evidence.

export type ConflictFlag = "POTENTIAL_STATE_CONFLICT" | "HIGH_STATE_CONFLICT";

/** One pending transaction kept in the persisted evidence snapshot. */
export type PendingTxSummary = {
  from: string;
  to: string | null;
  /** First 4 bytes of calldata — the function selector, when calldata is present. */
  selector: string | null;
  nonce: string;
};

/**
 * The deterministic evidence behind a conflictScore. Persisted verbatim into
 * forecast_json so every audit row carries the evidence that produced it.
 */
export type ConflictEvidence = {
  /** pending-block = real mempool enumeration; logs-fallback = log-density proxy. */
  source: "pending-block" | "logs-fallback";
  scannedAt: number;
  competingTxCount: number;
  competingSwapCount: number;
  /** Non-swap AMM reserve movers (decoded from the AMM ABI) — half-weight direct conflicts. */
  competingPoolWriterCount: number;
  competingClaimCount: number;
  /** Viable pending txs chain-wide (non-viable txs are filtered out). */
  pendingPoolSize: number;
  /** Same-sender pending txs excluded as serialized (never competitors). */
  excludedSameSenderCount: number;
  /** Pending txs excluded for explicit gasPrice 0 / gas 0 (cannot mine). */
  excludedNonViableCount: number;
  /** Bounded snapshot of counted competitors to the evaluated target (cap ECA_EVIDENCE_TX_CAP). */
  relevantTxs: PendingTxSummary[];
  error?: string;
};

export type ConflictScanResult = {
  conflictScore: number;
  flags: ConflictFlag[];
  evidence: ConflictEvidence;
};

/** Structural view of a pending-block transaction — only what the ECA reads. */
export type PendingTxLike = {
  from: string;
  to: string | null;
  input?: string;
  nonce: string | number | bigint;
  /** Optional viability fields — explicit 0 (the Monad mempool artifact) marks a tx that cannot mine. */
  gasPrice?: string | number | bigint | null;
  gas?: string | number | bigint | null;
};

// ── ECA constants ───────────────────────────────────────────────────────

// Recalibrated (v3) weights: the direct-conflict signal dominates (0.86), ambient
// same-contract pressure is minor context (0.08), chain-wide pool pressure is a
// slow background term with real headroom (0.06).
const ECA_SAME_CONTRACT_WEIGHT = 0.08;
const ECA_DIRECT_CONFLICT_WEIGHT = 0.86;
const ECA_POOL_PRESSURE_WEIGHT = 0.06;
// Diminishing-returns curve shapes — g(n, k) = n / (n + k). The direct curve
// stays at k=1 (a single competitor at half weight; k>1 would push two
// competing swaps under the 0.60 HIGH anchor). The claim curve (k=0.5) keeps
// same-slot claims winner-take-all while leaving room to discriminate 2 vs 25
// racers. The same-contract curve (k=2) rises half as fast as before, so
// ambient context stays far below the flag floor.
const ECA_SAME_CONTRACT_K = 2;
const ECA_DIRECT_K = 1;
const ECA_CLAIM_DIRECT_K = 0.5;
// Chain-wide pool pressure grows slowly (denominator 250) and never saturates —
// the old min(pool/50, 1) flattened at 50 pending txs.
const ECA_POOL_PRESSURE_K = 250;
// A non-swap reserve mover (addLiquidity / removeLiquidity / …) counts as half
// a competing swap: it moves the reserves the evaluated swap's quote depends on.
const ECA_POOL_WRITER_FACTOR = 0.5;
const ECA_POTENTIAL_THRESHOLD = 0.3; // mirrors the HIGH_CONTENTION flag floor
const ECA_HIGH_THRESHOLD = 0.6;
const ECA_EVIDENCE_TX_CAP = 20; // bound the persisted evidence snapshot
const ECA_FALLBACK_CONTENTION_FACTOR = 0.5; // log density is weaker than mempool evidence

const normAddr = (a: string): string => a.toLowerCase();

/** First 4 bytes of calldata, or null when absent / malformed. */
function calldataSelector(input: string | undefined): string | null {
  if (!input || !input.startsWith("0x") || input.length < 10) return null;
  return input.slice(0, 10);
}

/** Decode a known-ABI function name from calldata, or null when undecodable. */
function decodeFunctionName(data: string | undefined, abi: readonly unknown[]): string | null {
  if (!data || data === "0x") return null;
  try {
    return decodeFunctionData({ abi, data: data as Hex }).functionName;
  } catch {
    return null;
  }
}

/** Decode the slotId argument of a claim(slotId) call, or null when not a claim. */
function decodeClaimSlot(data: string | undefined): bigint | null {
  if (!data || data === "0x") return null;
  try {
    const decoded = decodeFunctionData({ abi: claimContractAbi, data: data as Hex });
    if (decoded.functionName !== "claim") return null;
    return decoded.args[0] as bigint;
  } catch {
    return null;
  }
}

/**
 * AMM functions that write pool state (everything but the swap path and the
 * view functions). Used to recognise non-swap reserve movers (pool writers).
 */
const AMM_MUTATING_FUNCTIONS: ReadonlySet<string> = new Set(
  ammAbi
    .filter(
      (item): item is Extract<(typeof ammAbi)[number], { type: "function" }> =>
        item.type === "function",
    )
    .filter((fn) => fn.stateMutability === "payable" || fn.stateMutability === "nonpayable")
    .map((fn) => fn.name),
);

/**
 * True when a pending tx could plausibly mine: no explicit 0 gasPrice / gas.
 * The Stage 0 probe found 0-gasPrice/0-gas txs sitting in Monad's pending
 * block — they can never be included, so they must not count as competitors
 * or as pool pressure. Missing fields are treated as viable (undefined ≠ 0).
 * Never throws: an unparseable value is treated as viable.
 */
function isViablePendingTx(p: PendingTxLike): boolean {
  for (const field of [p.gasPrice, p.gas]) {
    if (field === undefined || field === null) continue;
    try {
      if (BigInt(field) === 0n) return false;
    } catch {
      // unparseable — not evidence of non-viability
    }
  }
  return true;
}

/**
 * Diminishing-returns curve: g(n, k) = n / (n + k). Monotonic and never fully
 * saturates — the replacement for the old min(n/denominator, 1) linear caps.
 */
function diminishing(n: number, k: number): number {
  if (n <= 0) return 0;
  return n / (n + k);
}

/** The evaluated tx itself, when it is already pending (recheck after sign). */
function isEvaluatedTx(p: PendingTxLike, tx: VantageTxRequest): boolean {
  return normAddr(p.from) === normAddr(tx.from) && String(p.nonce) === String(tx.nonce);
}

/**
 * The conflict flags for a score — a severity ladder: none < POTENTIAL < HIGH.
 */
function conflictFlagsFor(score: number): ConflictFlag[] {
  if (score >= ECA_HIGH_THRESHOLD) return ["HIGH_STATE_CONFLICT"];
  if (score >= ECA_POTENTIAL_THRESHOLD) return ["POTENTIAL_STATE_CONFLICT"];
  return [];
}

/**
 * Pure, deterministic core of the ECA — unit-testable without any RPC.
 * Counts competing pending transactions against the evaluated tx and derives
 * the 0–1 conflictScore + flags. Never throws.
 *
 * Pre-filters (each count is filtered before it becomes evidence):
 *   - same-sender txs (other nonces) are excluded: a sender's own nonce
 *     sequence serializes deterministically, so those txs can never race the
 *     evaluated tx (they are not competitors);
 *   - non-viable txs (explicit gasPrice 0 or gas 0 — the Monad mempool
 *     artifact found by the Stage 0 probe) are excluded from every count;
 *   - non-swap AMM reserve movers (decoded from the AMM ABI) count as
 *     half-weight direct conflicts — they move the pool reserves the
 *     evaluated swap's quote depends on.
 *
 * v3 recalibration — weights (same 0.08 / direct 0.86 / pool 0.06) and curve
 * shapes (same k=2, claim k=0.5, pool k=250) only. No signal added or removed,
 * thresholds untouched.
 */
export function analyzePendingTxs(
  tx: VantageTxRequest,
  pending: readonly PendingTxLike[],
  scannedAt: number,
): ConflictScanResult {
  const target = normAddr(tx.to);
  const amm = normAddr(AMM_ADDRESS);
  const claim = normAddr(CLAIM_CONTRACT_ADDRESS);

  const evaluatedSwap = decodeFunctionName(tx.data, ammAbi) === "swap";
  const evaluatedClaimSlot = decodeClaimSlot(tx.data);

  let competingTxCount = 0;
  let competingSwapCount = 0;
  let competingPoolWriterCount = 0;
  let competingClaimCount = 0;
  let excludedSameSenderCount = 0;
  let excludedNonViableCount = 0;
  let viablePoolSize = 0;
  const relevantTxs: PendingTxSummary[] = [];

  for (const p of pending) {
    if (!isViablePendingTx(p)) {
      excludedNonViableCount++;
      continue;
    }
    viablePoolSize++;
    if (isEvaluatedTx(p, tx)) continue; // never count the tx being evaluated
    if (normAddr(p.from) === normAddr(tx.from)) {
      excludedSameSenderCount++; // serialized by the sender's nonce — not a competitor
      continue;
    }
    const to = p.to ? normAddr(p.to) : null;
    if (to !== target) continue; // same contract access only
    competingTxCount++;
    if (relevantTxs.length < ECA_EVIDENCE_TX_CAP) {
      relevantTxs.push({
        from: p.from,
        to: p.to,
        selector: calldataSelector(p.input),
        nonce: String(p.nonce),
      });
    }
    if (target === amm && evaluatedSwap) {
      const fn = decodeFunctionName(p.input, ammAbi);
      if (fn === "swap") {
        competingSwapCount++;
      } else if (fn !== null && AMM_MUTATING_FUNCTIONS.has(fn)) {
        competingPoolWriterCount++;
      }
    }
    if (target === claim && evaluatedClaimSlot !== null) {
      const slot = decodeClaimSlot(p.input);
      if (slot !== null && slot === evaluatedClaimSlot) competingClaimCount++;
    }
  }

  const pendingPoolSize = viablePoolSize;
  const effectiveDirect = evaluatedSwap
    ? competingSwapCount + ECA_POOL_WRITER_FACTOR * competingPoolWriterCount
    : competingClaimCount;
  const directK = evaluatedSwap ? ECA_DIRECT_K : ECA_CLAIM_DIRECT_K;
  const sameContractScore = diminishing(competingTxCount, ECA_SAME_CONTRACT_K);
  const directConflictScore = diminishing(effectiveDirect, directK);
  const poolPressureScore = diminishing(pendingPoolSize, ECA_POOL_PRESSURE_K);

  const raw =
    ECA_SAME_CONTRACT_WEIGHT * sameContractScore +
    ECA_DIRECT_CONFLICT_WEIGHT * directConflictScore +
    ECA_POOL_PRESSURE_WEIGHT * poolPressureScore;
  const conflictScore = Math.min(1, Math.round(raw * 1000) / 1000);

  return {
    conflictScore,
    flags: conflictFlagsFor(conflictScore),
    evidence: {
      source: "pending-block",
      scannedAt,
      competingTxCount,
      competingSwapCount,
      competingPoolWriterCount,
      competingClaimCount,
      pendingPoolSize,
      excludedSameSenderCount,
      excludedNonViableCount,
      relevantTxs,
    },
  };
}

/**
 * Log/calldata fallback — used when the mempool is not enumerable (RPC error
 * or no client). Reuses the existing contention scanner as a pressure proxy,
 * halved because log density is weaker evidence than a real mempool view.
 * Never throws.
 */
async function fallbackConflict(
  tx: VantageTxRequest,
  error: unknown,
): Promise<ConflictScanResult> {
  const contention = await getContentionScore(tx.to);
  const conflictScore = Math.min(
    1,
    Math.round(contention * ECA_FALLBACK_CONTENTION_FACTOR * 1000) / 1000,
  );
  return {
    conflictScore,
    flags: conflictFlagsFor(conflictScore),
    evidence: {
      source: "logs-fallback",
      scannedAt: Date.now(),
      competingTxCount: 0,
      competingSwapCount: 0,
      competingPoolWriterCount: 0,
      competingClaimCount: 0,
      pendingPoolSize: 0,
      excludedSameSenderCount: 0,
      excludedNonViableCount: 0,
      relevantTxs: [],
      error: error instanceof Error ? error.message : String(error),
    },
  };
}

/**
 * Scan the mempool for competing pending transactions against `tx`.
 *
 * Enumerates the pending block with full transactions (the one mempool
 * primitive the public Monad RPC exposes). When the pending block is
 * unavailable (RPC error) or no client exists, automatically falls back to
 * the log/calldata strategy. Never throws.
 */
export async function scanConflict(tx: VantageTxRequest): Promise<ConflictScanResult> {
  const client = getPublicClient();
  if (!client) {
    return fallbackConflict(tx, new Error("No RPC client available — mempool not enumerable"));
  }
  try {
    const block = await client.getBlock({ blockTag: "pending", includeTransactions: true });
    const pending = (block.transactions ?? []) as unknown as readonly PendingTxLike[];
    return analyzePendingTxs(tx, pending, Date.now());
  } catch (err) {
    return fallbackConflict(tx, err);
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
    flags.includes("NONCE_GAP") ||
    flags.includes("HIGH_STATE_CONFLICT")
  ) {
    return "HIGH";
  }
  if (flags.includes("HIGH_CONTENTION")) {
    // Threshold is the per-contract calibrated value (default 0.7), not a constant.
    return contentionScore !== null && contentionScore >= holdThreshold ? "HIGH" : "MEDIUM";
  }
  // An unlimited/large approval warrants caution, not a stop — same severity
  // as the watchdog's approval_exposure warning. POTENTIAL_STATE_CONFLICT is
  // the ECA's WARN-tier flag: real (mempool-derived) but not severe.
  if (flags.includes("APPROVAL_EXPOSURE") || flags.includes("POTENTIAL_STATE_CONFLICT")) {
    return "MEDIUM";
  }
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
  const [forecast, validity, contentionScore, approvalExposure, conflict] = await Promise.all([
    getForecast(tx, quotedOutput),
    checkValidity(tx),
    getContentionScore(tx.to),
    checkApprovalExposure(tx),
    scanConflict(tx),
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

  // ECA — the conflict flags ride the same flags[] surface as every other
  // signal, so risk derivation and the policy engine see them unchanged.
  flags.push(...conflict.flags);

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
    conflictScore: conflict.conflictScore,
    conflictFlags: conflict.flags,
    conflictEvidence: conflict.evidence,
    riskLevel,
    flags,
  };
}