"use client";
import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight } from "lucide-react";
import { ParametricMesh } from "../parametric-mesh";

/** The four failure modes Vantage exists to catch, in the user's words. */
const FAILURES = [
  "a worse price.",
  "a burned fee and nothing else.",
  "a transaction that never landed.",
  "a silent revert.",
];

export function Hero() {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setIndex((i) => (i + 1) % FAILURES.length), 2600);
    return () => clearInterval(id);
  }, []);

  return (
    <section className="relative flex min-h-screen items-center overflow-hidden">
      <div className="absolute inset-0 opacity-70">
        <ParametricMesh />
      </div>
      <div className="grid-blueprint pointer-events-none absolute inset-0 opacity-40" />

      <div className="relative z-10 mx-auto w-full max-w-[1400px] px-6">
        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.2, duration: 0.8 }}
          className="tabular text-[10px] uppercase tracking-[0.3em] text-text-secondary"
        >
          Pre-submission guard X WATCHDOG SPEC · Monad
        </motion.p>

        <motion.h1
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3, duration: 0.9 }}
          className="mt-6 max-w-4xl font-serif text-5xl leading-[1.05] tracking-tight md:text-7xl"
        >
          You signed it expecting one thing.
          <br />
          You got{" "}
          <span className="relative inline-block align-baseline">
            <AnimatePresence mode="wait">
              <motion.span
                key={FAILURES[index]}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -12 }}
                transition={{ duration: 0.4 }}
                className="inline-block italic text-[color:var(--danger)]"
              >
                {FAILURES[index]}
              </motion.span>
            </AnimatePresence>
          </span>
        </motion.h1>

        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.6, duration: 0.9 }}
          className="mt-8 max-w-xl text-base leading-relaxed text-text-secondary"
        >
          Vantage simulates your transaction before you sign, scores every contract in real-time,
          and watches the chain 24/7 — so parallel execution works for you, not against you.
        </motion.p>

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.8, duration: 0.9 }}
          className="mt-10 flex flex-wrap items-center gap-4"
        >
          <Link
            to="/app"
            className="ease-precision flex items-center gap-3 rounded-full bg-white px-8 py-4 text-[11px] font-bold uppercase tracking-[0.2em] text-black transition-all hover:shadow-[0_0_60px_rgba(255,255,255,0.15)]"
          >
            Open the Guard
            <ArrowUpRight size={14} />
          </Link>
          <Link
            to="/ledger"
            className="tabular rounded-full border border-white/15 px-8 py-4 text-[11px] uppercase tracking-[0.2em] text-white/70 transition-all hover:border-white/30 hover:text-white"
          >
            See what it caught
          </Link>
        </motion.div>
      </div>
    </section>
  );
}
