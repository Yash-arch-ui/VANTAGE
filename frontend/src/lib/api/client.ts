/**
 * The only module that knows the backend speaks HTTP.
 *
 * Everything above this layer works with typed values and a single ApiError.
 */

const BASE_URL = (import.meta.env.VITE_API_URL ?? "http://localhost:4000").replace(/\/+$/, "");

/**
 * Default request budget. Generous relative to the backend's sub-100ms SQLite
 * reads, tight enough that a wedged network surfaces as an error rather than a
 * spinner that never resolves.
 */
const DEFAULT_TIMEOUT_MS = 8_000;

/**
 * /api/evaluate is the one slow endpoint: when the policy resolves to
 * HOLD_AND_RECHECK it polls the chain for up to 30 seconds before answering.
 * 45s leaves room for that plus RPC slack.
 */
export const EVALUATE_TIMEOUT_MS = 45_000;

export type ApiErrorKind =
  | "ValidationError"
  | "NotFound"
  | "AlreadyWatching"
  | "InternalServerError"
  | "Timeout"
  | "Network"
  | "Unknown";

export type ValidationDetail = { path: string; message: string };

/** Every failure mode of the API, normalized into one throwable. */
export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | null;
  readonly details: ValidationDetail[];
  /** Full parsed body, for the rare caller that needs a field we didn't model. */
  readonly body: unknown;

  constructor(
    kind: ApiErrorKind,
    message: string,
    opts: { status?: number | null; details?: ValidationDetail[]; body?: unknown } = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    this.status = opts.status ?? null;
    this.details = opts.details ?? [];
    this.body = opts.body;
  }
}

function errorKindFor(status: number, body: unknown): ApiErrorKind {
  const named = (body as { error?: unknown } | null)?.error;
  if (
    named === "ValidationError" ||
    named === "NotFound" ||
    named === "AlreadyWatching" ||
    named === "InternalServerError"
  ) {
    return named;
  }
  if (status === 404) return "NotFound";
  if (status === 409) return "AlreadyWatching";
  if (status >= 500) return "InternalServerError";
  if (status === 400) return "ValidationError";
  return "Unknown";
}

export type ApiFetchOptions = RequestInit & { timeoutMs?: number };

/**
 * Typed fetch against the Vantage backend. Throws ApiError on any non-2xx,
 * timeout, or transport failure — callers never inspect a Response.
 */
export async function apiFetch<T>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal, ...init } = options;

  // Compose our deadline with any caller-supplied signal (e.g. React Query
  // cancelling a superseded query) so whichever fires first wins.
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const composed = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      ...init,
      signal: composed,
      headers: {
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
    });
  } catch (err) {
    if (timeoutSignal.aborted) {
      throw new ApiError("Timeout", `Request to ${path} timed out after ${timeoutMs}ms.`);
    }
    // A caller-initiated abort is not an error condition — let it propagate so
    // React Query can distinguish cancellation from failure.
    if (signal?.aborted) throw err;
    throw new ApiError(
      "Network",
      `Could not reach the Vantage backend at ${BASE_URL}. Is it running?`,
    );
  }

  const raw = await response.text();
  const body: unknown = raw ? safeParse(raw) : null;

  if (!response.ok) {
    const b = body as { message?: string; details?: ValidationDetail[] } | null;
    throw new ApiError(
      errorKindFor(response.status, body),
      b?.message ?? `Request to ${path} failed with ${response.status}.`,
      { status: response.status, details: b?.details ?? [], body },
    );
  }

  return body as T;
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Build a query string, dropping undefined values. */
export function qs(params: Record<string, string | number | boolean | undefined>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return "";
  return `?${new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString()}`;
}
