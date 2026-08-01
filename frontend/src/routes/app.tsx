import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useAccount, useSendTransaction } from "wagmi";
import type { Hex } from "viem";
import { AppShell } from "../components/app-shell";
import { Evaluating } from "../components/guard/evaluating";
import { VerdictPanel } from "../components/guard/verdict-panel";
import { WatcherStrip } from "../components/guard/watcher-strip";
import { PRESETS, useTxBuilder, type BuiltTx, type Preset } from "../hooks/useTxBuilder";
import { useEvaluate, useReportOutcome, useTxStatus } from "../hooks/api";
import {
  ApiError,
  type EvaluateResponse,
  type TxOutcome,
  type TxWatchStatus,
  type UserAction,
} from "../lib/api";
import { shortAddress } from "../lib/format";
import { actionTone, toneClasses } from "../lib/risk";

export const Route = createFileRoute("/app")({
  component: GuardConsole,
});

/**
 * Watcher statuses that end the story, mapped to the outcome recorded against
 * the ledger entry. STUCK is terminal too: the transaction has sat well past
 * its expected inclusion time, and leaving it out meant the watcher polled
 * forever and the outcome was never recorded at all.
 */
const TERMINAL_OUTCOME: Partial<Record<TxWatchStatus, TxOutcome>> = {
  CONFIRMED: "CONFIRMED",
  FAILED: "FAILED",
  DROPPED: "DROPPED",
  STUCK: "STUCK",
};

function GuardConsole() {
  const { isConnected } = useAccount();
  const [preset, setPreset] = useState<Preset>(PRESETS[0]);
  const [input, setInput] = useState(PRESETS[0].defaultInput);
  const [result, setResult] = useState<EvaluateResponse | null>(null);
  // The exact transaction that was evaluated. Signing must use this and not a
  // rebuild — a rebuild would re-fetch the nonce and re-quote the pool, so the
  // user would be signing something other than what the verdict describes.
  const [built, setBuilt] = useState<BuiltTx | null>(null);
  const [txHash, setTxHash] = useState<Hex | null>(null);
  const [submittedAt, setSubmittedAt] = useState<number | null>(null);
  const [outcomeReported, setOutcomeReported] = useState(false);
  /**
   * What the user actually chose. The terminal-status report used to hardcode
   * "SIGNED", and the backend's COALESCE takes any non-null value, so an
   * OVERRIDDEN record was clobbered seconds after it was written — leaving
   * every "overridden" counter permanently at zero for exactly the overrides
   * that went on to confirm.
   */
  const [userAction, setUserAction] = useState<UserAction | null>(null);

  const { build, isBuilding } = useTxBuilder();
  const evaluateMutation = useEvaluate();
  const reportOutcome = useReportOutcome();
  const { sendTransactionAsync, isPending: isSending } = useSendTransaction();

  // Watch the broadcast transaction so the outcome we report is the real one.
  const { data: watchStatus } = useTxStatus(txHash ?? undefined, submittedAt ?? undefined);

  const reset = () => {
    setResult(null);
    setBuilt(null);
    setTxHash(null);
    setSubmittedAt(null);
    setOutcomeReported(false);
    setUserAction(null);
  };

  /**
   * A transaction is in flight until the watcher reaches a terminal state.
   * Starting a new evaluation before then used to clear txHash, which
   * permanently short-circuited the reporting effect — so that transaction's
   * outcome was never recorded and the ledger quietly lost a row it advertises
   * as "what actually happened".
   */
  const isAwaitingOutcome = txHash !== null && !outcomeReported;

  const selectPreset = (p: Preset) => {
    if (isAwaitingOutcome) {
      toast.error("Wait for the current transaction to settle first.");
      return;
    }
    setPreset(p);
    setInput(p.defaultInput);
    reset();
  };

  /**
   * Editing the amount invalidates the verdict on screen. Without this the user
   * could read "PROCEED" for 1 token, type 500, and sign — signing the 1-token
   * transaction the verdict actually described while the field said 500.
   */
  const handleInputChange = (value: string) => {
    setInput(value);
    if (result && !isAwaitingOutcome) reset();
  };

  const handleEvaluate = async () => {
    if (isAwaitingOutcome) {
      toast.error("Wait for the current transaction to settle before evaluating another.");
      return;
    }
    reset();
    try {
      const next = await build(preset, input);
      setBuilt(next);
      const res = await evaluateMutation.mutateAsync(next.request);
      setResult(res);
    } catch (err) {
      const message =
        err instanceof ApiError || err instanceof Error ? err.message : "Evaluation failed.";
      toast.error(message);
    }
  };

  /** Report what the user chose. Outcome is attached later, once the tx settles. */
  const report = (action: UserAction, outcome?: TxOutcome, hash?: string) => {
    if (!result?.entryId) return;
    reportOutcome.mutate(
      { entryId: result.entryId, userAction: action, outcome, txHash: hash },
      {
        onError: (err) =>
          toast.error(
            err instanceof Error
              ? `Could not record the outcome: ${err.message}`
              : "Could not record the outcome.",
          ),
      },
    );
  };

  const handleSign = async (isOverride: boolean) => {
    if (!result || !built) return;
    const action: UserAction = isOverride ? "OVERRIDDEN" : "SIGNED";
    try {
      // Sign exactly what was evaluated.
      const hash = await sendTransactionAsync({
        to: built.request.tx.to as Hex,
        data: built.request.tx.data as Hex,
        value: BigInt(built.request.tx.value),
        // The wallet would otherwise pick its own nonce from the pending count,
        // while the guard evaluated the one in `built` — so with an earlier
        // transaction still pending, the verdict would describe a different
        // nonce than the one signed.
        nonce: built.request.tx.nonce,
      });
      setTxHash(hash);
      setSubmittedAt(Date.now());
      setUserAction(action);
      // Record the decision immediately — an override is the interesting signal
      // and must be captured whether or not the transaction later confirms.
      report(action, undefined, hash);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Wallet rejected the transaction.");
    }
  };

  const handleCancel = () => {
    report("CANCELLED");
    toast.success("Cancelled. The decision was recorded.");
    reset();
  };

  // Once the watcher reaches a terminal state, attach the real outcome to the
  // same ledger entry — that is what recalibrates the contract's threshold.
  useEffect(() => {
    if (!watchStatus || !txHash || outcomeReported || !result?.entryId) return;
    const outcome = TERMINAL_OUTCOME[watchStatus.status];
    if (!outcome) return;

    reportOutcome.mutate(
      {
        entryId: result.entryId,
        // The user's real choice, not a hardcoded "SIGNED". The backend
        // COALESCEs any non-null value over what is already stored, so sending
        // "SIGNED" here erased the OVERRIDDEN record written moments earlier.
        userAction: userAction ?? "SIGNED",
        outcome,
        txHash,
      },
      {
        onError: (err) =>
          toast.error(
            err instanceof Error
              ? `Could not record the outcome: ${err.message}`
              : "Could not record the outcome.",
          ),
      },
    );
    setOutcomeReported(true);
    // Depends on reportOutcome.mutate, which is stable, rather than the
    // mutation object — that is a fresh reference on every render and would
    // re-run this effect every time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchStatus, txHash, outcomeReported, result?.entryId, userAction, reportOutcome.mutate]);

  const isAbort = result?.policy.action === "ABORT";
  const busy = isBuilding || evaluateMutation.isPending;

  return (
    <AppShell>
      <header className="mb-8">
        <p className="tabular text-[10px] uppercase tracking-[0.3em] text-text-secondary">
          Pre-submission guard
        </p>
        <h1 className="mt-3 font-serif text-4xl tracking-tight">Guard console</h1>
        <p className="mt-2 max-w-xl text-sm text-text-secondary">
          Build a transaction, see what it will actually do against live chain state, then decide.
          Nothing is signed until you say so.
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-[380px_1fr]">
        {/* Builder */}
        <section className="vantage-glass h-fit rounded-2xl p-6">
          <p className="tabular text-[10px] uppercase tracking-[0.2em] text-text-secondary">
            Transaction
          </p>

          <div className="mt-4 space-y-2">
            {PRESETS.map((p) => (
              <button
                key={p.id}
                onClick={() => selectPreset(p)}
                className={`ease-precision w-full rounded-xl border p-3 text-left transition-all ${
                  preset.id === p.id
                    ? "border-white/25 bg-white/[0.06]"
                    : "border-white/[0.06] hover:border-white/15"
                }`}
              >
                <p className="text-sm text-white/90">{p.label}</p>
                <p className="mt-1 text-xs leading-relaxed text-text-secondary">{p.demonstrates}</p>
              </button>
            ))}
          </div>

          {preset.id !== "approve" && (
            <div className="mt-5">
              <label
                htmlFor="tx-input"
                className="tabular text-[10px] uppercase tracking-[0.2em] text-text-secondary"
              >
                {preset.inputLabel}
              </label>
              <input
                id="tx-input"
                value={input}
                onChange={(e) => handleInputChange(e.target.value)}
                inputMode="decimal"
                className="tabular mt-2 w-full rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-sm outline-none focus:border-white/25"
              />
            </div>
          )}

          <p className="tabular mt-5 text-[10px] uppercase tracking-[0.18em] text-text-secondary">
            Target {shortAddress(preset.target)}
          </p>

          <button
            onClick={handleEvaluate}
            disabled={!isConnected || busy}
            className="ease-precision mt-4 w-full rounded-full bg-white px-4 py-2.5 text-[11px] font-medium uppercase tracking-[0.25em] text-black transition-all hover:bg-white/90 disabled:opacity-40"
          >
            {busy ? "Evaluating…" : "Evaluate"}
          </button>

          {!isConnected && (
            <p className="mt-3 text-center text-xs text-text-secondary">
              Connect a wallet to build a transaction.
            </p>
          )}
        </section>

        {/* Verdict */}
        <div className="space-y-6">
          {built && (
            <p className="tabular text-[10px] uppercase tracking-[0.2em] text-text-secondary">
              {built.summary}
            </p>
          )}

          {evaluateMutation.isPending && <Evaluating />}

          {result && !evaluateMutation.isPending && (
            <>
              <VerdictPanel result={result} />

              {!txHash && (
                <div className="flex flex-wrap gap-3">
                  {isAbort ? (
                    <>
                      <button
                        onClick={handleCancel}
                        className="ease-precision rounded-full bg-white px-5 py-2.5 text-[11px] font-medium uppercase tracking-[0.25em] text-black transition-all hover:bg-white/90"
                      >
                        Don't sign
                      </button>
                      <button
                        onClick={() => handleSign(true)}
                        disabled={isSending}
                        className={`ease-precision rounded-full border px-5 py-2.5 text-[11px] uppercase tracking-[0.25em] transition-all disabled:opacity-40 ${toneClasses.danger.border} ${toneClasses.danger.text} hover:${toneClasses.danger.bg}`}
                      >
                        {isSending ? "Confirm in wallet…" : "Override and sign anyway"}
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        onClick={() => handleSign(false)}
                        disabled={isSending}
                        className={`ease-precision rounded-full border px-5 py-2.5 text-[11px] uppercase tracking-[0.25em] transition-all disabled:opacity-40 ${toneClasses[actionTone(result.policy.action)].border} ${toneClasses[actionTone(result.policy.action)].bg} ${toneClasses[actionTone(result.policy.action)].text}`}
                      >
                        {isSending ? "Confirm in wallet…" : "Sign and submit"}
                      </button>
                      <button
                        onClick={handleCancel}
                        className="ease-precision rounded-full border border-white/10 px-5 py-2.5 text-[11px] uppercase tracking-[0.25em] text-text-secondary transition-all hover:text-white/90"
                      >
                        Cancel
                      </button>
                    </>
                  )}
                </div>
              )}

              {txHash && submittedAt && <WatcherStrip txHash={txHash} submittedAt={submittedAt} />}
            </>
          )}

          {!result && !evaluateMutation.isPending && (
            <div className="rounded-2xl border border-dashed border-white/[0.08] p-12 text-center">
              <p className="text-sm text-text-secondary">
                Pick a transaction and evaluate it. The verdict appears here.
              </p>
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}
