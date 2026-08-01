// One function per backend endpoint. No React here — these are plain async
// calls the hooks in src/hooks/api wrap.
import { apiFetch, qs, EVALUATE_TIMEOUT_MS } from "./client";
import { normalizeAlert, normalizeLedgerEntry, normalizeWatchlistItem } from "./normalize";
import type {
  Alert,
  AlertQuery,
  AlertSummary,
  EvaluateRequest,
  EvaluateResponse,
  LedgerEntry,
  OutcomeRequest,
  OutcomeResponse,
  ScoreResult,
  SessionStats,
  TxStatusReport,
  WatchType,
  WatchlistItem,
  WireAlert,
  WireLedgerEntry,
  WireWatchlistItem,
} from "./types";

export * from "./types";
export { ApiError } from "./client";

const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });

export function health(): Promise<{ status: string; service: string }> {
  return apiFetch("/health");
}

/**
 * Simulate, decide, explain and record — the core call.
 * Gets a long timeout because a HOLD_AND_RECHECK decision re-polls the chain
 * for up to 30 seconds before this resolves.
 */
export function evaluate(req: EvaluateRequest, signal?: AbortSignal): Promise<EvaluateResponse> {
  return apiFetch("/api/evaluate", {
    method: "POST",
    ...json(req),
    timeoutMs: EVALUATE_TIMEOUT_MS,
    signal,
  });
}

/** Report what the user did and what happened. Recalibrates the contract's threshold. */
export function reportOutcome(req: OutcomeRequest): Promise<OutcomeResponse> {
  return apiFetch("/api/outcome", { method: "POST", ...json(req) });
}

export function getStats(signal?: AbortSignal): Promise<SessionStats> {
  return apiFetch("/api/stats", { signal });
}

export function getScore(address: string, signal?: AbortSignal): Promise<ScoreResult> {
  return apiFetch(`/api/score/${address}`, { signal });
}

export async function getLedger(
  params: { limit?: number; offset?: number; contract?: string } = {},
  signal?: AbortSignal,
): Promise<{ items: LedgerEntry[]; total: number }> {
  const res = await apiFetch<{ items: WireLedgerEntry[]; total: number }>(
    `/api/ledger${qs(params)}`,
    { signal },
  );
  return { items: res.items.map(normalizeLedgerEntry), total: res.total };
}

/**
 * One-shot transaction status. `submittedAt` is the broadcast time in epoch ms —
 * without it the backend cannot tell a 2-second-old transaction from a
 * 2-minute-old one, which is the whole difference between "propagating" and
 * "stuck".
 */
export function getTxStatus(
  txHash: string,
  submittedAt?: number,
  signal?: AbortSignal,
): Promise<TxStatusReport> {
  return apiFetch(`/api/watch/${txHash}${qs({ since: submittedAt })}`, { signal });
}

export async function getWatchlist(signal?: AbortSignal): Promise<WatchlistItem[]> {
  const res = await apiFetch<{ items: WireWatchlistItem[] }>("/api/watchlist", { signal });
  return res.items.map(normalizeWatchlistItem);
}

/** Throws ApiError with kind "AlreadyWatching" (409) when the address is already on the list. */
export async function addToWatchlist(
  address: string,
  watchType: WatchType = "manual",
): Promise<WatchlistItem[]> {
  const res = await apiFetch<{ items: WireWatchlistItem[] }>("/api/watchlist", {
    method: "POST",
    ...json({ address, watchType }),
  });
  return res.items.map(normalizeWatchlistItem);
}

export function removeFromWatchlist(
  address: string,
): Promise<{ ok: true; address: string; removed: boolean }> {
  return apiFetch(`/api/watchlist/${address}`, { method: "DELETE" });
}

export async function getAlerts(query: AlertQuery = {}, signal?: AbortSignal): Promise<Alert[]> {
  const res = await apiFetch<{ items: WireAlert[] }>(
    `/api/alerts${qs({
      // The server only treats the literal string "true" as a filter.
      unread: query.unread ? "true" : undefined,
      severity: query.severity,
      address: query.address,
      limit: query.limit,
    })}`,
    { signal },
  );
  return res.items.map(normalizeAlert);
}

export function getAlertSummary(signal?: AbortSignal): Promise<AlertSummary> {
  return apiFetch("/api/alerts/summary", { signal });
}

export function updateAlert(
  id: string,
  patch: { read?: boolean; dismissed?: boolean },
): Promise<{ ok: true; id: string; read: boolean | null; dismissed: boolean | null }> {
  return apiFetch(`/api/alerts/${id}`, { method: "PATCH", ...json(patch) });
}
