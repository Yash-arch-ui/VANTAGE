import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { LedgerBackground } from "./LedgerBackground";
import Hyperspeed from "./Hyperspeed";

// WebGL cannot run in jsdom, so the scene component is stubbed and the WebGL
// probe is stubbed. These tests verify the containment contract the page
// depends on: the wrapper's position/z-index/pointer-events and the fail-soft
// fallback, mirroring GuardBackground.test.tsx.
vi.mock("./Hyperspeed", () => ({
  default: vi.fn(() => <div data-testid="hyperspeed-mock" />),
}));

const HyperspeedMock = vi.mocked(Hyperspeed);
const originalGetContext = HTMLCanvasElement.prototype.getContext;

describe("LedgerBackground", () => {
  beforeEach(() => {
    HyperspeedMock.mockClear();
    HTMLCanvasElement.prototype.getContext = vi.fn();
  });

  afterEach(() => {
    HTMLCanvasElement.prototype.getContext = originalGetContext;
  });

  it("renders nothing when WebGL is unavailable — never crashes the page", () => {
    HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue(null);

    const { container } = render(<LedgerBackground />);

    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId("ledger-background")).not.toBeInTheDocument();
    expect(HyperspeedMock).not.toHaveBeenCalled();
  });

  it("is strictly contained: fixed, inset 0, z-index 0, pointer-events none", () => {
    HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue({});

    render(<LedgerBackground />);

    const bg = screen.getByTestId("ledger-background");
    expect(bg).toBeInTheDocument();
    expect(bg.getAttribute("aria-hidden")).toBe("true");
    // Positioned at z-index 0: paints strictly behind the `relative z-10`
    // content wrapper in ledger.tsx, never over a card or button.
    expect(bg.style.position).toBe("fixed");
    expect(bg.style.inset).toBe("0px");
    expect(bg.style.zIndex).toBe("0");
    // pointer-events: none — the browser-level guarantee that the canvas can
    // never become the hit-test target, so nothing underneath is intercepted.
    expect(bg.style.pointerEvents).toBe("none");
    // The scene mounts inside the contained wrapper, subdued so the ledger
    // text stays readable above it.
    const sceneWrapper = bg.children[0] as HTMLElement;
    expect(sceneWrapper.style.opacity).toBe("0.45");
    expect(sceneWrapper.firstElementChild).toHaveAttribute("data-testid", "hyperspeed-mock");
  });

  it("mounts first (behind) the interactive content and never intercepts clicks", () => {
    HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue({});

    const { container } = render(
      <div>
        <LedgerBackground />
        <button type="button">Next</button>
      </div>,
    );

    const bg = screen.getByTestId("ledger-background");
    const button = screen.getByRole("button", { name: "Next" });

    // The background is the first element in the tree; every interactive
    // element follows it, so with both in positioned layers it sits behind.
    expect(bg.nextElementSibling).toBe(button);
    expect(bg.parentElement).toBe(container.firstChild);
    expect(bg.style.pointerEvents).toBe("none");

    // And the interactive element remains fully clickable.
    const onClick = vi.fn();
    button.addEventListener("click", onClick);
    button.click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
