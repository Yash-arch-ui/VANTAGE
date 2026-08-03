"use client";

import { motion } from "motion/react";
import { TextScramble } from "@/components/ui/text-scramble";
import { BGPattern } from "@/components/ui/bg-pattern";

export function Preloader({ onComplete }: { onComplete: () => void }) {
  return (
    <motion.div
      className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-[#08080A] overflow-hidden"
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15, ease: "linear" }}
    >
      <BGPattern variant="grid" mask="fade-edges" fill="rgba(255,255,255,0.06)" />

      <div className="relative z-10">
        <TextScramble
          className="font-mono uppercase text-2xl md:text-4xl lg:text-5xl text-[#F3F4F6] tracking-[0.2em] text-center px-6"
          duration={1.4}
          speed={0.04}
          onScrambleComplete={() => {
            setTimeout(onComplete, 200);
          }}
        >
          Vantage
        </TextScramble>
      </div>

      <div className="absolute bottom-12 left-0 right-0 flex justify-center">
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.3, duration: 0.6 }}
          className="text-[10px] font-mono uppercase tracking-[0.3em] text-[#8B8D98]"
        >
          Pre-submission guard X WATCHDOG SPEC
        </motion.div>
      </div>
    </motion.div>
  );
}
