import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { ModuleGrid } from "./ModuleGrid";

/**
 * Containment contract for the CursorGrid backdrop in the module section:
 * the grid paints in a positioned layer at z-0 with pointer-events: none and
 * aria-hidden, while the copy and the seven cards live in a `relative z-10`
 * wrapper — so the effect can never sit over, intercept, or announce itself.
 * jsdom cannot run the canvas, so the 2D context probe is stubbed; the effect
 * bails safely on a null context (fail-soft).
 */
describe("ModuleGrid CursorGrid backdrop", () => {
  const originalGetContext = HTMLCanvasElement.prototype.getContext;
  const originalIntersectionObserver = globalThis.IntersectionObserver;

  beforeEach(() => {
    // Fail-soft: no 2D context in jsdom, so the canvas effect returns early.
    HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue(null);
    // motion's whileInView needs an observer in jsdom.
    class IO {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    globalThis.IntersectionObserver = IO as unknown as typeof IntersectionObserver;
  });

  afterEach(() => {
    HTMLCanvasElement.prototype.getContext = originalGetContext;
    globalThis.IntersectionObserver = originalIntersectionObserver;
  });

  it("mounts the grid strictly behind the content: z-0 backdrop, z-10 content", () => {
    const { container } = render(<ModuleGrid />);

    const section = container.querySelector("section");
    expect(section).not.toBeNull();

    const backdrop = section!.querySelector('[aria-hidden="true"]');
    expect(backdrop).not.toBeNull();
    // Positioned at z-0 and inert to the pointer: paints strictly behind the
    // cards/text and can never intercept a click or hover.
    expect(backdrop!.getAttribute("aria-hidden")).toBe("true");
    expect(backdrop!.className).toContain("pointer-events-none");
    expect(backdrop!.className).toContain("absolute");
    expect(backdrop!.className).toContain("inset-0");
    expect(backdrop!.className).toContain("z-0");

    // The canvas mounts inside the contained backdrop.
    expect(backdrop!.querySelector("canvas")).not.toBeNull();

    // Every card (and the section copy) sits in a z-10 positioned wrapper,
    // so the DOM order + z-index both guarantee the grid stays underneath.
    const content = backdrop!.nextElementSibling as HTMLElement | null;
    expect(content).not.toBeNull();
    expect(content!.className).toContain("relative");
    expect(content!.className).toContain("z-10");
    expect(content!.querySelectorAll(".vantage-glass").length).toBe(7);
  });
});
