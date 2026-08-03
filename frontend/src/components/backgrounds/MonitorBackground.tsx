import { Component, useEffect, useState, type ReactNode } from "react";
import Beams from "../Beams";

/**
 * Strict-containment wrapper for the Monitor page's ambient background.
 *
 * Same containment contract as the Guard console's GuardBackground (load-bearing):
 * - `position: fixed; inset: 0; zIndex: 0` — covers the viewport and paints in
 *   the positioned layer, strictly behind the `relative z-10` content
 *   containers in monitor.tsx (header, stat tiles, watchlist, alert feed).
 * - `pointerEvents: 'none'` — the canvas can never intercept a click, hover or
 *   focus; the watchlist input, ADD button, filter tabs and the alert card
 *   MARK READ / DISMISS buttons all stay fully interactive.
 * - Conservative GPU load: `beamNumber` and `noiseIntensity` are reduced well
 *   below the component defaults (12 / 1.75) and the example usage (20 / 2.75)
 *   because this page polls alert/watchlist data every 15s — a heavy shader
 *   would fight the polling for CPU/GPU time.
 * - `lightColor` reuses the existing dark theme's `--caution` accent instead
 *   of plain white, so the glow stays inside the Vantage palette.
 * - Fail-soft: if WebGL is unavailable, or the scene throws at runtime, the
 *   boundary renders nothing instead of crashing the page.
 */
class BeamsBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    // Decorative only — fail quiet, never take the page down with us.
    console.warn("Beams background disabled:", error);
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export function MonitorBackground() {
  const [webgl, setWebgl] = useState(false);

  // Probe for a WebGL context before mounting the canvas. Wrapped in try/catch
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
    <BeamsBoundary>
      <div
        aria-hidden
        data-testid="monitor-background"
        // Inline rather than utility classes: containment is behavioral, must
        // survive any CSS purge, and must be assertable in jsdom.
        style={{ position: "fixed", inset: 0, zIndex: 0, pointerEvents: "none" }}
      >
        <Beams beamNumber={4} noiseIntensity={0.4} lightColor="#F59E0B" />
      </div>
    </BeamsBoundary>
  );
}
