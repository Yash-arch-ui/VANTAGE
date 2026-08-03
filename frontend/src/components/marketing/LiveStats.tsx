"use client";
import { motion } from "motion/react";
import { useStats } from "../../hooks/api";
import MagicRings from "./MagicRings";

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
    <section className="relative overflow-hidden border-y border-white/5 bg-white/[0.01]">
      {/*
        MagicRings shader animation, layered over the card. The renderer is
        alpha-blended and sits below the stats (z-0 vs z-10), so the numbers
        stay fully readable while the rings glow around them. Purely decorative
        — aria-hidden and pointer-events: none.
      */}
      <div aria-hidden className="pointer-events-none absolute inset-0 z-0">
        <MagicRings
          color="#A855F7"
          colorTwo="#6366F1"
          ringCount={6}
          speed={1}
          attenuation={12}
          lineThickness={2}
          baseRadius={0.35}
          radiusStep={0.1}
          scaleRate={0.1}
          opacity={0.5}
          noiseAmount={0.08}
          rotation={0}
          ringGap={1.5}
          fadeIn={0.7}
          fadeOut={0.5}
          followMouse={false}
          parallax={0.05}
        />
      </div>
      <div className="relative z-10 mx-auto grid max-w-[1400px] gap-px px-6 py-14 sm:grid-cols-2 lg:grid-cols-4">
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
      <p className="relative z-10 tabular pb-8 text-center text-[10px] uppercase tracking-[0.25em] text-text-secondary">
        <span className="pulse-live mr-2 inline-block h-1.5 w-1.5 rounded-full bg-[color:var(--safe)]" />
        Live from the execution ledger
      </p>
    </section>
  );
}
