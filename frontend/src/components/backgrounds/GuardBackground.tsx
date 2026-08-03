import { Component, useEffect, useState, type ReactNode } from "react";
import Lightfall from "./Lightfall";

/**
 * Strict-containment wrapper for the Guard console's ambient background.
 *
 * Containment contract (everything below is load-bearing — do not relax):
 * - `position: fixed; inset: 0; zIndex: 0` — covers the viewport and paints in
 *   the positioned layer, so it sits strictly behind the positioned content
 *   containers (the page header and the builder/verdict grid, which carry
 *   `relative z-10` in app.tsx). Verified against every existing surface:
 *   the transaction cards, the input, the verdict panel, the Pool Reserves
 *   panel and the action buttons all live in those positioned containers.
 * - `pointerEvents: 'none'` — the canvas can never intercept a click, hover or
 *   focus; every button (Evaluate, Sign and submit, Cancel, Override and sign
 *   anyway) stays fully interactive.
 * - Low intensity: `opacity` 0.25–0.35, `mouseInteraction: false` and a single
 *   streak keep GPU cost minimal while the page is actively used.
 * - Fail-soft: if WebGL is unavailable, or context/program creation throws at
 *   runtime, the boundary renders nothing instead of crashing the page.
 */
class LightfallBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    // Decorative only — fail quiet, never take the page down with us.
    console.warn("Lightfall background disabled:", error);
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export function GuardBackground() {
  const [webgl, setWebgl] = useState(false);

  // Probe for a WebGL context before mounting the shader. Wrapped in try/catch
  // so a hostile environment (headless, software-GL off, context loss at boot)
  // renders nothing rather than throwing during mount.
  useEffect(() => {
    try {
      const canvas = document.createElement("canvas");
      const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
      setWebgl(Boolean(gl));
    } catch {
      setWebgl(false);
    }
  }, []);

  if (!webgl) return null;

  return (
    <LightfallBoundary>
      <div
        aria-hidden
        data-testid="guard-background"
        // Inline rather than utility classes: containment is behavioral, must
        // survive any CSS purge, and must be assertable in jsdom.
        style={{ position: "fixed", inset: 0, zIndex: 0, pointerEvents: "none", opacity: 0.28 }}
      >
        <Lightfall
          colors={["#A6C8FF", "#5227FF", "#FF9FFC"]}
          backgroundColor="#0A29FF"
          speed={0.5}
          streakCount={1}
          streakWidth={1}
          streakLength={1}
          glow={1}
          density={0.6}
          twinkle={1}
          zoom={3}
          backgroundGlow={0.5}
          // dpr 1: decorative backdrop — never pays retina (4×) fill rate.
          dpr={1}
          mouseInteraction={false}
          mouseStrength={0.5}
          mouseRadius={1}
        />
      </div>
    </LightfallBoundary>
  );
}
