import { Component, useEffect, useState, type ReactNode } from "react";
import Hyperspeed from "./Hyperspeed";
import type { HyperspeedOptions } from "./Hyperspeed";

/**
 * Strict-containment wrapper for the Ledger page's ambient Hyperspeed backdrop.
 *
 * Same containment contract as GuardBackground / MonitorBackground / ScoreBackground
 * (load-bearing, do not relax):
 * - `position: fixed; inset: 0; zIndex: 0` — covers the viewport and paints in
 *   the positioned layer, strictly behind the `relative z-10` content wrapper
 *   in ledger.tsx (header, aggregate tiles, the timeline table, pagination).
 * - `pointerEvents: 'none'` — the canvas can never intercept a click, hover or
 *   focus; the ledger's Previous/Next buttons, explorer links and table stay
 *   fully interactive.
 * - Subdued: the scene renders at 0.45 opacity under a thin 18% dark veil, so
 *   the synthwave road and car lights stay clearly visible while the ledger's
 *   text and tone-colored verdict badges keep full contrast.
 * - Fail-soft: if WebGL is unavailable, or the scene throws at runtime, the
 *   boundary renders nothing instead of crashing the page.
 */
class HyperspeedBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    // Decorative only — fail quiet, never take the page down with us.
    console.warn("Hyperspeed background disabled:", error);
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * The ledger's flavour of the classic synthwave road: dark asphalt (matching
 * the page's #08080A), pink/violet lights streaming away on the left, cyan on
 * the right. Module-level constant so the WebGL scene is never recreated on
 * re-renders (Hyperspeed recreates the scene whenever effectOptions changes).
 */
const LEDGER_EFFECT_OPTIONS: Partial<HyperspeedOptions> = {
  distortion: "turbulentDistortion",
  length: 400,
  roadWidth: 10,
  islandWidth: 2,
  lanesPerRoad: 3,
  fov: 90,
  fovSpeedUp: 150,
  speedUp: 2,
  carLightsFade: 0.4,
  totalSideLightSticks: 20,
  lightPairsPerRoadWay: 40,
  shoulderLinesWidthPercentage: 0.05,
  brokenLinesWidthPercentage: 0.1,
  brokenLinesLengthPercentage: 0.5,
  lightStickWidth: [0.12, 0.5],
  lightStickHeight: [1.3, 1.7],
  movingAwaySpeed: [60, 80],
  movingCloserSpeed: [-120, -160],
  carLightsLength: [12, 80],
  carLightsRadius: [0.05, 0.14],
  carWidthPercentage: [0.3, 0.5],
  carShiftX: [-0.8, 0.8],
  carFloorSeparation: [0, 5],
  colors: {
    roadColor: 0x080808,
    islandColor: 0x0a0a0a,
    background: 0x000000,
    shoulderLines: 0x131318,
    brokenLines: 0x131318,
    leftCars: [0xd856bf, 0x6750a2, 0xc247ac],
    rightCars: [0x03b3c3, 0x0e5ea5, 0x324555],
    sticks: 0x03b3c3,
  },
};

export function LedgerBackground() {
  const [webgl, setWebgl] = useState(false);

  // Probe for a WebGL context before mounting the renderer. Wrapped in try/catch
  // so a hostile environment renders nothing rather than throwing during mount.
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
    <HyperspeedBoundary>
      <div
        aria-hidden
        data-testid="ledger-background"
        // Inline rather than utility classes: containment is behavioral, must
        // survive any CSS purge, and must be assertable in jsdom.
        style={{ position: "fixed", inset: 0, zIndex: 0, pointerEvents: "none" }}
      >
        {/* The scene fills the wrapper; opacity keeps the ledger text readable
            while the road stays clearly visible beneath it. */}
        <div style={{ position: "absolute", inset: 0, opacity: 0.45 }}>
          <Hyperspeed effectOptions={LEDGER_EFFECT_OPTIONS} />
        </div>
        {/* Thin dark veil over the scene, strictly behind the content layer:
            pulls the brightest glows down a notch so the table text on top
            keeps full contrast. */}
        <div style={{ position: "absolute", inset: 0, background: "rgba(8, 8, 10, 0.18)" }} />
      </div>
    </HyperspeedBoundary>
  );
}
