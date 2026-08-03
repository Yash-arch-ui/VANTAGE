import { Component, useEffect, useState, type ReactNode } from "react";
import ColorBends from "./ColorBends";

/**
 * Strict-containment wrapper for the Score page's ambient ColorBends backdrop.
 *
 * Same containment contract as the Guard console's GuardBackground (load-bearing):
 * - `position: fixed; inset: 0; zIndex: 0` — covers the viewport and paints in
 *   the positioned layer, strictly behind the `relative z-10` content in
 *   score.tsx (header, quick links, address input, score cards).
 * - `pointerEvents: 'none'` — the canvas can never intercept a click, hover or
 *   focus; the address input, quick-link buttons and everything else stay fully
 *   interactive. The shader's mouse influence still works via trackWindow.
 * - Subdued: `opacity` 0.35 keeps the color bands behind the glass cards
 *   without fighting the score text for attention.
 * - Fail-soft: if WebGL is unavailable, or the scene throws at runtime, the
 *   boundary renders nothing instead of crashing the page.
 */
class ColorBendsBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    // Decorative only — fail quiet, never take the page down with us.
    console.warn("ColorBends background disabled:", error);
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export function ScoreBackground() {
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
    <ColorBendsBoundary>
      <div
        aria-hidden
        data-testid="score-background"
        // Inline rather than utility classes: containment is behavioral, must
        // survive any CSS purge, and must be assertable in jsdom.
        style={{ position: "fixed", inset: 0, zIndex: 0, pointerEvents: "none", opacity: 0.35 }}
      >
        <ColorBends
          colors={["#10B981", "#00E5FF", "#F59E0B"]}
          rotation={90}
          speed={0.2}
          scale={1}
          frequency={1}
          warpStrength={1}
          mouseInfluence={1}
          parallax={0.5}
          noise={0.15}
          iterations={1}
          intensity={1.5}
          bandWidth={6}
          transparent
          autoRotate={0}
          trackWindow
        />
      </div>
    </ColorBendsBoundary>
  );
}
