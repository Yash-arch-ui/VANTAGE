import { AMM_ADDRESS } from "../../config/contracts";
import { usePoolReserves } from "../../hooks/usePoolReserves";
import { formatToken, shortAddress } from "../../lib/format";

/**
 * A single reserve row. Same markup as the verdict panel's Field — label on
 * top, value below, split by a hairline border — so the panel reads as part
 * of the same card family rather than a new component style.
 */
function ReserveField({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-t border-white/[0.06] py-3">
      <p className="tabular text-[10px] uppercase tracking-[0.2em] text-text-secondary">{label}</p>
      <p className="tabular mt-1 text-sm text-white/90">{value}</p>
    </div>
  );
}

/**
 * Read-only live view of AMM's reserves, shown on the Guard console while
 * the Swap preset is selected. Purely informational — the reserve numbers a
 * swap would actually move, so the drift check reads against current state.
 * formatToken renders "—" for null, so loading and RPC failure both degrade to
 * the same calm empty state instead of a spinner or an error row.
 */
export function PoolReserves() {
  const { data } = usePoolReserves();
  const tokenReserve = data ? data.tokenReserve.toString() : null;
  const monReserve = data ? data.monReserve.toString() : null;

  return (
    <section className="vantage-glass ease-precision rounded-2xl p-6">
      <div className="flex items-center gap-3">
        <span className="pulse-live h-1.5 w-1.5 rounded-full bg-[color:var(--safe)]" />
        <p className="tabular text-[10px] uppercase tracking-[0.25em] text-text-secondary">
          Pool reserves
        </p>
        <span className="tabular ml-auto text-[10px] uppercase tracking-[0.2em] text-text-secondary">
          {shortAddress(AMM_ADDRESS)}
        </span>
      </div>

      <div className="mt-4 grid gap-x-8 sm:grid-cols-2">
        <ReserveField label="Token reserve" value={formatToken(tokenReserve, 18, 2)} />
        <ReserveField label="MON reserve" value={formatToken(monReserve, 18, 2)} />
      </div>
    </section>
  );
}
