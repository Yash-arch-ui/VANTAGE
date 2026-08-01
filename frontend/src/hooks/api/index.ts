// TanStack Query bindings for the Vantage API.
//
// Poll cadences are matched to what actually changes on the server: the
// watchdog wakes every 15s, so polling alerts faster than ~10s only burns
// requests. Transaction status is the exception — a user staring at a pending
// transaction needs 2s feedback.
import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from "@tanstack/react-query";
import * as api from "../../lib/api";
import type {
  Alert,
  AlertQuery,
  AlertSummary,
  EvaluateRequest,
  EvaluateResponse,
  LedgerEntry,
  OutcomeRequest,
  ScoreResult,
  SessionStats,
  TxStatusReport,
  WatchType,
  WatchlistItem,
} from "../../lib/api";

/** Matches the watchdog's own 15s cycle without hammering it. */
const ALERT_POLL_MS = 10_000;
const STATS_POLL_MS = 15_000;
const TX_POLL_MS = 2_000;

export const queryKeys = {
  stats: ["stats"] as const,
  score: (address: string) => ["score", address] as const,
  ledger: (params: { limit?: number; offset?: number; contract?: string }) =>
    ["ledger", params] as const,
  watchlist: ["watchlist"] as const,
  alerts: (query: AlertQuery) => ["alerts", query] as const,
  alertSummary: ["alerts", "summary"] as const,
  // submittedAt belongs in the key: the server uses it to distinguish
  // propagating from stuck, so two consumers of the same hash with different
  // values must not share one cache entry.
  txStatus: (txHash: string | undefined, submittedAt: number | undefined) =>
    ["tx-status", txHash, submittedAt] as const,
};

// ── Reads ──────────────────────────────────────────────────────────────

export function useStats(options?: Partial<UseQueryOptions<SessionStats>>) {
  return useQuery({
    queryKey: queryKeys.stats,
    queryFn: ({ signal }) => api.getStats(signal),
    refetchInterval: STATS_POLL_MS,
    ...options,
  });
}

export function useScore(address: string | undefined) {
  return useQuery({
    queryKey: queryKeys.score(address ?? ""),
    queryFn: ({ signal }) => api.getScore(address!, signal) as Promise<ScoreResult>,
    enabled: Boolean(address),
  });
}

export function useLedger(params: { limit?: number; offset?: number; contract?: string } = {}) {
  return useQuery<{ items: LedgerEntry[]; total: number }>({
    queryKey: queryKeys.ledger(params),
    queryFn: ({ signal }) => api.getLedger(params, signal),
    // Keep the previous page on screen while the next one loads, so paging
    // doesn't flash an empty table.
    placeholderData: (prev) => prev,
  });
}

export function useWatchlist() {
  return useQuery<WatchlistItem[]>({
    queryKey: queryKeys.watchlist,
    queryFn: ({ signal }) => api.getWatchlist(signal),
    placeholderData: (prev) => prev,
  });
}

export function useAlerts(query: AlertQuery = {}) {
  return useQuery<Alert[]>({
    queryKey: queryKeys.alerts(query),
    queryFn: ({ signal }) => api.getAlerts(query, signal),
    refetchInterval: ALERT_POLL_MS,
    // Changing a filter changes the key, which left `data` undefined — the list
    // rendered nothing AND the empty state was suppressed, so the panel went
    // blank for the length of the request.
    placeholderData: (prev) => prev,
  });
}

export function useAlertSummary() {
  return useQuery<AlertSummary>({
    queryKey: queryKeys.alertSummary,
    queryFn: ({ signal }) => api.getAlertSummary(signal),
    refetchInterval: ALERT_POLL_MS,
  });
}

/**
 * Poll a submitted transaction until it reaches a terminal state.
 *
 * `submittedAt` must be when the transaction was broadcast — the server uses it
 * to distinguish "still propagating" from "stuck".
 */
export function useTxStatus(txHash: string | undefined, submittedAt: number | undefined) {
  return useQuery<TxStatusReport>({
    queryKey: queryKeys.txStatus(txHash, submittedAt),
    // The server requires submittedAt, so don't fire without it.
    queryFn: ({ signal }) => api.getTxStatus(txHash!, submittedAt!, signal),
    enabled: Boolean(txHash) && submittedAt !== undefined,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (!status) return TX_POLL_MS;
      // STUCK counts as terminal. It used to be treated as "keep waiting",
      // so a stuck transaction polled every 2s for as long as the tab stayed
      // open and its outcome was never recorded at all.
      return TERMINAL_STATUSES.has(status) ? false : TX_POLL_MS;
    },
  });
}

const TERMINAL_STATUSES: ReadonlySet<TxStatusReport["status"]> = new Set([
  "CONFIRMED",
  "FAILED",
  "DROPPED",
  "STUCK",
]);

// ── Writes ─────────────────────────────────────────────────────────────

export function useEvaluate() {
  const qc = useQueryClient();
  return useMutation<EvaluateResponse, api.ApiError, EvaluateRequest>({
    mutationFn: (req) => api.evaluate(req),
    onSuccess: (_data, req) => {
      // An evaluation writes a ledger row, auto-watches the target contract and
      // moves its score — refresh all three rather than waiting for a poll.
      void qc.invalidateQueries({ queryKey: ["ledger"] });
      void qc.invalidateQueries({ queryKey: queryKeys.stats });
      void qc.invalidateQueries({ queryKey: queryKeys.watchlist });
      void qc.invalidateQueries({ queryKey: queryKeys.score(req.tx.to) });
    },
  });
}

export function useReportOutcome() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: OutcomeRequest) => api.reportOutcome(req),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["ledger"] });
      void qc.invalidateQueries({ queryKey: queryKeys.stats });
      void qc.invalidateQueries({ queryKey: ["score"] });
    },
  });
}

export function useAddToWatchlist() {
  const qc = useQueryClient();
  return useMutation<WatchlistItem[], api.ApiError, { address: string; watchType?: WatchType }>({
    mutationFn: ({ address, watchType }) => api.addToWatchlist(address, watchType),
    onSuccess: () => void qc.invalidateQueries({ queryKey: queryKeys.watchlist }),
  });
}

export function useRemoveFromWatchlist() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (address: string) => api.removeFromWatchlist(address),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.watchlist });
      // Alerts cascade-delete with the watchlist row.
      void qc.invalidateQueries({ queryKey: ["alerts"] });
    },
  });
}

export function useUpdateAlert() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: { id: string; read?: boolean; dismissed?: boolean }) =>
      api.updateAlert(id, patch),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["alerts"] }),
  });
}
