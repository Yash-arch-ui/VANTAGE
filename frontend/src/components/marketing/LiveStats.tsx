"use client";
import { motion } from "motion/react";
import { useStats } from "../../hooks/api";

/**
 * Real numbers from the ledger, not a claim about them. If the backend is
 * unreachable this renders nothing rather than zeros — a fabricated "0 caught"
 * would be worse than an absent strip.
 */
export function LiveStats() {
  const { data, isError } = useStats();
  if (isError || !data) return null;

  const flagged =
    (data.byAction.ABORT ?? 0) +
    (data.byAction.WARN ?? 0) +
    (data.byAction.SUGGEST_ADJUSTMENT ?? 0);

  const tiles = [
    { label: "Transactions evaluated", value: data.total },
    { label: "Flagged before signing", value: flagged },
    { label: "Confirmed after approval", value: data.byOutcome.CONFIRMED ?? 0 },
    { label: "Warnings overridden", value: data.overridden },
  ];

  return (
    <section className="relative border-y border-white/5 bg-white/[0.01]">
      <div className="mx-auto grid max-w-[1400px] gap-px px-6 py-14 sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map((tile, i) => (
          <motion.div
            key={tile.label}
            initial={{ opacity: 0, y: 12 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ delay: i * 0.06, duration: 0.5 }}
          >
            <p className="tabular text-4xl text-white/90">{tile.value.toLocaleString()}</p>
            <p className="tabular mt-2 text-[10px] uppercase tracking-[0.2em] text-text-secondary">
              {tile.label}
            </p>
          </motion.div>
        ))}
      </div>
      <p className="tabular pb-8 text-center text-[10px] uppercase tracking-[0.25em] text-text-secondary">
        <span className="pulse-live mr-2 inline-block h-1.5 w-1.5 rounded-full bg-[color:var(--safe)]" />
        Live from the execution ledger
      </p>
    </section>
  );
}
