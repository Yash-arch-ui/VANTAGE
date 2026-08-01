"use client";
import * as React from "react";
import { motion, useScroll, useTransform, MotionValue } from "motion/react";

const COPY =
  "You sign a transaction based on what a screen told you a moment ago. By the time it executes, the chain has moved. The price is worse, the slot is gone, the call reverts — and you find out afterwards, from a failed receipt. Vantage runs it first, against the chain as it is right now, and tells you before you sign.";

type Token =
  | { kind: "token"; value: string; animIndex: number | null }
  | { kind: "br"; value?: undefined; animIndex?: undefined };

function tokenizeWords(raw: string): Token[] {
  const lines = (raw ?? "").split("\n");
  const out: Token[] = [];
  let animIndex = 0;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const words = line.trim() ? line.trim().split(/\s+/) : [];
    for (let i = 0; i < words.length; i++) {
      out.push({ kind: "token", value: words[i], animIndex });
      animIndex++;
      // IMPORTANT: add a real space token so wrapping works
      if (i !== words.length - 1) {
        out.push({ kind: "token", value: " ", animIndex: null });
      }
    }
    if (!words.length) out.push({ kind: "token", value: "\u00A0", animIndex: null });
    if (li !== lines.length - 1) out.push({ kind: "br" });
  }
  return out;
}

function RevealToken({
  value,
  animIndex,
  totalAnimated,
  scroll,
}: {
  value: string;
  animIndex: number | null;
  totalAnimated: number;
  scroll: number;
}) {
  if (animIndex === null || totalAnimated <= 0) {
    return <span>{value}</span>;
  }
  const start = animIndex / totalAnimated;
  const end = start + 1 / totalAnimated;

  let opacity = 0;
  if (scroll >= end) opacity = 1;
  else if (scroll <= start) opacity = 0;
  else opacity = (scroll - start) / (end - start);

  return <span style={{ opacity, display: "inline" }}>{value}</span>;
}

function GhostLayer({
  raw,
  textColor,
  ghostOpacity,
  textAlign,
}: {
  raw: string;
  textColor: string;
  ghostOpacity: number;
  textAlign: "left" | "center" | "right";
}) {
  const content = raw.split("\n").map((line: string, li: number) => {
    const safeLine = line.trim() ? line.trim().split(/\s+/).join(" ") : "\u00A0";
    return (
      <React.Fragment key={`g-ln-${li}`}>
        {li > 0 && <br />}
        {safeLine}
      </React.Fragment>
    );
  });
  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        pointerEvents: "none",
        opacity: ghostOpacity,
        color: textColor,
        whiteSpace: "pre-wrap",
        textAlign,
      }}
    >
      {content}
    </div>
  );
}

export function ScrollManifesto() {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({
    target: containerRef,
    offset: ["start start", "end end"],
  });
  const [scroll, setScroll] = React.useState(0);

  // Use a native effect to listen to the motion value to avoid hook order issues if we import dynamically
  React.useEffect(() => {
    return scrollYProgress.on("change", (v) => setScroll(v));
  }, [scrollYProgress]);

  const wordTokens = React.useMemo(() => tokenizeWords(COPY), []);
  const totalAnimated = React.useMemo(() => {
    let max = -1;
    for (const t of wordTokens) {
      if (t.kind === "token" && t.animIndex !== null) max = Math.max(max, t.animIndex);
    }
    return max + 1;
  }, [wordTokens]);

  return (
    <section
      ref={containerRef}
      className="relative z-10 w-full bg-[#08080A]"
      style={{ height: "220vh" }}
    >
      {/* Soft gradient top edge instead of hard border */}
      <div className="pointer-events-none absolute top-0 inset-x-0 h-40 bg-gradient-to-b from-[#08080A] via-[#08080A]/60 to-transparent" />
      <div className="pointer-events-none absolute bottom-0 inset-x-0 h-40 bg-gradient-to-t from-[#08080A] via-[#08080A]/60 to-transparent" />

      <div className="absolute inset-0 grid-blueprint opacity-40" />
      {/* radial vignette to fade grid */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse at center, transparent 0%, transparent 40%, #08080A 90%)",
        }}
      />

      <div className="sticky top-0 h-screen flex items-center justify-center px-6">
        <div className="max-w-5xl mx-auto w-full">
          <p className="text-[10px] font-mono text-[#8B8D98] uppercase tracking-[0.3em] mb-10">
            / 02 · The Thesis
          </p>

          {/* Exactly matching the Framer Component DOM structure for flawless text overlay */}
          <div
            style={{
              position: "relative",
              width: "100%",
              whiteSpace: "pre-wrap",
              textAlign: "left",
              wordSpacing: "0.2em",
            }}
          >
            <div className="text-3xl md:text-5xl md:leading-[1.15] tracking-tight font-serif italic antialiased">
              <GhostLayer raw={COPY} textColor="#3a3b42" ghostOpacity={1} textAlign="left" />
              <div style={{ position: "relative", color: "#F3F4F6" }}>
                {wordTokens.map((t, i) =>
                  t.kind === "br" ? (
                    <br key={`br-${i}`} />
                  ) : (
                    <RevealToken
                      key={`t-${i}`}
                      value={t.value}
                      animIndex={t.animIndex}
                      totalAnimated={totalAnimated}
                      scroll={scroll}
                    />
                  ),
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
