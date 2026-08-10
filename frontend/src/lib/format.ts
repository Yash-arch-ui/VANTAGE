import { formatUnits } from "viem";

/** 0x1234…cdef */
export function shortAddress(address: string, lead = 6, tail = 4): string {
  if (address.length <= lead + tail) return address;
  return `${address.slice(0, lead)}…${address.slice(-tail)}`;
}

/**
 * Format a wei-scale decimal string for display. Returns "—" for null so
 * callers don't each invent their own empty state — the backend returns null
 * for any field it could not compute, and that is common enough to be normal.
 */
export function formatToken(
  value: string | null | undefined,
  decimals = 18,
  precision = 4,
): string {
  if (value === null || value === undefined) return "—";
  try {
    const wei = BigInt(value);
    const magnitude = wei < 0n ? -wei : wei;
    // Display threshold in exact integer wei (10^-precision tokens). A real
    // amount below it would round to all zeros at `precision` decimals and read
    // as "0", so render "<0.0001" instead. Integer math only — the double
    // `10 ** -precision` renders as 0.00009999999999999999, and Number-based
    // division loses tiny values.
    const thresholdWei = 10n ** BigInt(Math.max(0, decimals - precision));
    if (magnitude !== 0n && magnitude < thresholdWei) {
      // Same literal for every sub-threshold amount: "0." + (precision-1)
      // zeros + "1", built from the string, never from a floating division.
      return precision <= 0 ? "<1" : `<0.${"0".repeat(precision - 1)}1`;
    }
    const n = Number(formatUnits(wei, decimals));
    if (!Number.isFinite(n)) return "—";
    return n.toLocaleString(undefined, { maximumFractionDigits: precision });
  } catch {
    return "—";
  }
}

export function formatPercent(value: number | null | undefined, precision = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(precision)}%`;
}

/**
 * Drift for display, sign included (negative = worse than quoted, positive =
 * better than quoted). Deliberately shares formatPercent's signed rendering so
 * the drift readout and any other signed percentage can never disagree about
 * how the sign is displayed.
 */
export const formatDriftPercent = formatPercent;

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return value.toLocaleString();
}

export function formatGas(value: string | null | undefined): string {
  if (!value) return "—";
  try {
    return BigInt(value).toLocaleString();
  } catch {
    return "—";
  }
}

/** "3m ago" — the ledger and alert feeds are read at a glance, not audited by timestamp. */
export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
