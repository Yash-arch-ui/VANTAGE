"use client";
import { motion } from "motion/react";
import { ArrowUpRight } from "lucide-react";
import { Link } from "@tanstack/react-router";

export function FooterCTA() {
  const text = " VANTAGE · ";
  const long = text.repeat(20);
  return (
    <section className="w-full min-h-[70vh] flex flex-col items-center justify-center relative bg-[#08080A] border-t border-white/5 overflow-hidden">
      <div className="absolute inset-0 flex items-center pointer-events-none select-none">
        <motion.div
          animate={{ x: ["0%", "-50%"] }}
          transition={{ repeat: Infinity, duration: 40, ease: "linear" }}
          className="whitespace-nowrap text-[15vw] font-serif italic font-medium leading-none text-transparent"
          style={{ WebkitTextStroke: "1px rgba(255,255,255,0.04)" }}
        >
          {long}
          {long}
        </motion.div>
      </div>

      <div className="relative z-10 flex flex-col items-center text-center px-6">
        <p className="text-[10px] font-mono text-[#8B8D98] uppercase tracking-[0.3em] mb-8">
          / 05 · Gateway
        </p>
        <h2 className="text-5xl md:text-7xl font-serif italic text-[#F3F4F6] tracking-tight leading-[1.05]">
          Look before you sign.
        </h2>
        <p className="text-sm font-mono text-[#8B8D98] mt-6 mb-12 uppercase tracking-[0.25em]">
          Six deterministic checks. One sentence you can read.
        </p>
        <Link
          to="/app"
          className="px-10 py-5 bg-white text-black text-xs font-bold tracking-[0.2em] uppercase rounded-full transition-all duration-500 hover:scale-[1.02] hover:shadow-[0_0_60px_rgba(255,255,255,0.15)] flex items-center gap-3 cursor-pointer"
        >
          Open the Guard
          <ArrowUpRight size={14} />
        </Link>
      </div>

      <div className="absolute bottom-6 left-0 right-0 px-6 flex items-center justify-between text-[10px] font-mono text-[#8B8D98] uppercase tracking-[0.25em] z-10">
        <span>© 2026 Vantage</span>
        <span className="flex items-center gap-2">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-[#10B981] pulse-live" />
          Monad Testnet
        </span>
      </div>
    </section>
  );
}
