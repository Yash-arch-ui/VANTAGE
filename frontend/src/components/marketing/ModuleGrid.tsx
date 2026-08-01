"use client";
import { motion } from "motion/react";
import { SpotlightCard } from "../spotlight-card";

/**
 * The seven modules, each stated as the problem it solves and whether it uses
 * AI. The split is the point of the section: six of seven are deterministic,
 * and claiming that only lands if every row is auditable at a glance.
 */
const MODULES = [
  {
    n: "01",
    title: "Simulation",
    problem: "The transaction executes differently than you were shown.",
    how: "Runs your unsigned transaction against current chain state as a read-only call — no gas, nothing committed — and diffs the result against your quote.",
    ai: false,
    span: "md:col-span-2",
  },
  {
    n: "02",
    title: "Stale-state detector",
    problem: "Someone else changed the state while you were reading the page.",
    how: "Re-checks the contract immediately before you sign. If the slot was claimed or the liquidity drained in between, the simulation reverts and you are told why.",
    ai: false,
    span: "",
  },
  {
    n: "03",
    title: "Transaction watcher",
    problem: "The transaction appears to vanish after you submit it.",
    how: "Monad's async mempool makes 'still propagating', 'stuck' and 'dropped' look identical to naive polling. This tells them apart.",
    ai: false,
    span: "",
  },
  {
    n: "04",
    title: "Congestion detector",
    problem: "Execution gets unpredictable when a contract is busy.",
    how: "Counts recent calls hitting the target contract and scores how contended it is. Above the calibrated threshold, the guard holds and re-checks rather than letting you sign into a moving target.",
    ai: false,
    span: "md:col-span-2",
  },
  {
    n: "05",
    title: "Approval risk",
    problem: "Unlimited token approvals, granted in one click.",
    how: "Decodes the calldata, spots an approve() for 2^256-1, and tells you the exact amount you actually needed.",
    ai: false,
    span: "",
  },
  {
    n: "06",
    title: "Explainer",
    problem: "Risk output is dense numbers. That is a communication problem, not a detection one.",
    how: "Takes the numbers the five modules above already computed and writes one plain-English sentence. It never computes risk and never adds a claim that was not in its input.",
    ai: true,
    span: "",
  },
  {
    n: "07",
    title: "Execution memory",
    problem: "Every safety claim needs evidence behind it.",
    how: "Records every decision and what actually happened afterwards, then feeds that back: contracts get a score, and each contract's hold threshold recalibrates from its own real outcomes.",
    ai: false,
    span: "md:col-span-2",
  },
];

export function ModuleGrid() {
  return (
    <section className="relative mx-auto max-w-[1400px] px-6 py-32">
      <p className="tabular text-[10px] uppercase tracking-[0.3em] text-text-secondary">
        / 03 · What is actually running
      </p>
      <h2 className="mt-6 max-w-2xl font-serif text-4xl leading-tight tracking-tight md:text-5xl">
        Seven modules. Six of them are just code.
      </h2>
      <p className="mt-6 max-w-2xl text-base leading-relaxed text-text-secondary">
        Real simulation, real math, real on-chain data. Exactly one component uses an LLM, and its
        only job is turning already-computed numbers into a sentence a human can read.
      </p>

      <div className="mt-14 grid gap-4 md:grid-cols-3">
        {MODULES.map((m, i) => (
          <motion.div
            key={m.n}
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-80px" }}
            transition={{ delay: i * 0.05, duration: 0.6 }}
            className={m.span}
          >
            <SpotlightCard className="h-full p-6">
              <div className="flex items-start justify-between gap-4">
                <span className="tabular text-[10px] uppercase tracking-[0.25em] text-text-secondary">
                  {m.n}
                </span>
                <span
                  className={`tabular rounded-full border px-2.5 py-1 text-[9px] uppercase tracking-[0.18em] ${
                    m.ai
                      ? "border-[color:var(--caution)]/30 bg-[color:var(--caution)]/10 text-[color:var(--caution)]"
                      : "border-white/10 text-text-secondary"
                  }`}
                >
                  {m.ai ? "AI" : "Deterministic"}
                </span>
              </div>

              <h3 className="mt-4 text-lg tracking-tight text-white/90">{m.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-white/70">{m.problem}</p>
              <p className="mt-3 text-xs leading-relaxed text-text-secondary">{m.how}</p>
            </SpotlightCard>
          </motion.div>
        ))}
      </div>
    </section>
  );
}
