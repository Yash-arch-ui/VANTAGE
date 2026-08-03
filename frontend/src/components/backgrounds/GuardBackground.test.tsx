import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { GuardBackground } from "./GuardBackground";
import Lightfall from "./Lightfall";

// The shader cannot run in jsdom, so the child is stubbed and the WebGL probe
// is stubbed. These tests verify the containment contract the page depends on:
// the wrapper's position/z-index/pointer-events and the fail-soft fallback.
vi.mock("./Lightfall", () => ({
  default: vi.fn(() => <div data-testid="lightfall-mock" />),
}));

const LightfallMock = vi.mocked(Lightfall);
const originalGetContext = HTMLCanvasElement.prototype.getContext;

describe("GuardBackground", () => {
  beforeEach(() => {
    LightfallMock.mockClear();
    HTMLCanvasElement.prototype.getContext = vi.fn();
  });

  afterEach(() => {
    HTMLCanvasElement.prototype.getContext = originalGetContext;
  });

  it("renders nothing when WebGL is unavailable — never crashes the page", () => {
    HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue(null);

    const { container } = render(<GuardBackground />);

    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId("guard-background")).not.toBeInTheDocument();
    expect(LightfallMock).not.toHaveBeenCalled();
  });

  it("is strictly contained: fixed, inset 0, z-index 0, pointer-events none", () => {
    HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue({});

    render(<GuardBackground />);

    const bg = screen.getByTestId("guard-background");
    expect(bg).toBeInTheDocument();
    expect(bg.getAttribute("aria-hidden")).toBe("true");
    // Positioned at z-index 0: paints strictly behind the `relative z-10`
    // content containers in app.tsx, never over a card or button.
    expect(bg.style.position).toBe("fixed");
    expect(bg.style.inset).toBe("0px");
    expect(bg.style.zIndex).toBe("0");
    // pointer-events: none — the browser-level guarantee that the canvas can
    // never become the hit-test target, so nothing underneath is intercepted.
    expect(bg.style.pointerEvents).toBe("none");
    // Low intensity: 0.25–0.35 keeps GPU cost minimal during active use.
    const opacity = Number(bg.style.opacity);
    expect(opacity).toBeGreaterThanOrEqual(0.25);
    expect(opacity).toBeLessThanOrEqual(0.35);
    // The shader mounts inside the contained wrapper.
    expect(bg.firstElementChild).toHaveAttribute("data-testid", "lightfall-mock");
  });

  it("runs the light show at low cost: mouse interaction off, single streak", () => {
    HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue({});

    render(<GuardBackground />);

    // Inspect the props object directly: React passes a trailing (undefined)
    // second arg to function components, which breaks toHaveBeenCalledWith.
    expect(LightfallMock).toHaveBeenCalledTimes(1);
    expect(LightfallMock.mock.calls[0][0]).toMatchObject({
      mouseInteraction: false,
      streakCount: 1,
    });
  });

  it("mounts first (behind) the interactive content and never intercepts clicks", () => {
    HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue({});

    const { container } = render(
      <div>
        <GuardBackground />
        <button type="button">Evaluate</button>
      </div>,
    );

    const bg = screen.getByTestId("guard-background");
    const button = screen.getByRole("button", { name: "Evaluate" });

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
