"use client";
import { Link, useLocation } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";

export interface GooeyNavItem {
  label: string;
  /** Route path — constrained to the app's typed routes so Link stays type-safe. */
  to: "/" | "/app" | "/ledger" | "/monitor" | "/score";
}

export interface GooeyNavProps {
  items: GooeyNavItem[];
  animationTime?: number;
  particleCount?: number;
  particleDistances?: [number, number];
  particleR?: number;
  timeVariance?: number;
  colors?: number[];
}

/**
 * Scoped under `.gooey-nav` (the react-bits original used global selectors like
 * `li.active` and `:root`). All particle colour tokens are the Vantage palette.
 */
const gooeyNavCss = `
  .gooey-nav {
    --linear-ease: linear(0, 0.068, 0.19 2.7%, 0.804 8.1%, 1.037, 1.199 13.2%, 1.245, 1.27 15.8%, 1.274, 1.272 17.4%, 1.249 19.1%, 0.996 28%, 0.949, 0.928 33.3%, 0.926, 0.933 36.8%, 1.001 45.6%, 1.013, 1.019 50.8%, 1.018 54.4%, 1 63.1%, 0.995 68%, 1.001 85%, 1);
    --color-1: #d856bf;
    --color-2: #03b3c3;
    --color-3: #6750a2;
    --color-4: #f59e0b;
  }
  .gooey-nav .effect {
    position: absolute;
    opacity: 1;
    pointer-events: none;
    display: grid;
    place-items: center;
    z-index: 1;
  }
  .gooey-nav .effect.text {
    color: white;
    transition: color 0.3s ease;
  }
  .gooey-nav .effect.text.active {
    color: black;
  }
  .gooey-nav .effect.filter {
    filter: blur(7px) contrast(100) blur(0);
    mix-blend-mode: lighten;
  }
  .gooey-nav .effect.filter::before {
    content: "";
    position: absolute;
    inset: -75px;
    z-index: -2;
    background: black;
  }
  .gooey-nav .effect.filter::after {
    content: "";
    position: absolute;
    inset: 0;
    background: white;
    transform: scale(0);
    opacity: 0;
    z-index: -1;
    border-radius: 9999px;
  }
  .gooey-nav .effect.active::after {
    animation: pill 0.3s ease both;
  }
  @keyframes pill {
    to {
      transform: scale(1);
      opacity: 1;
    }
  }
  .gooey-nav .particle,
  .gooey-nav .point {
    display: block;
    opacity: 0;
    width: 20px;
    height: 20px;
    border-radius: 9999px;
    transform-origin: center;
  }
  .gooey-nav .particle {
    --time: 5s;
    position: absolute;
    top: calc(50% - 8px);
    left: calc(50% - 8px);
    animation: particle calc(var(--time)) ease 1 -350ms;
  }
  .gooey-nav .point {
    background: var(--color);
    opacity: 1;
    animation: point calc(var(--time)) ease 1 -350ms;
  }
  @keyframes particle {
    0% {
      transform: rotate(0deg) translate(calc(var(--start-x)), calc(var(--start-y)));
      opacity: 1;
      animation-timing-function: cubic-bezier(0.55, 0, 1, 0.45);
    }
    70% {
      transform: rotate(calc(var(--rotate) * 0.5)) translate(calc(var(--end-x) * 1.2), calc(var(--end-y) * 1.2));
      opacity: 1;
      animation-timing-function: ease;
    }
    85% {
      transform: rotate(calc(var(--rotate) * 0.66)) translate(calc(var(--end-x)), calc(var(--end-y)));
      opacity: 1;
    }
    100% {
      transform: rotate(calc(var(--rotate) * 1.2)) translate(calc(var(--end-x) * 0.5), calc(var(--end-y) * 0.5));
      opacity: 1;
    }
  }
  @keyframes point {
    0% {
      transform: scale(0);
      opacity: 0;
      animation-timing-function: cubic-bezier(0.55, 0, 1, 0.45);
    }
    25% {
      transform: scale(calc(var(--scale) * 0.25));
    }
    38% {
      opacity: 1;
    }
    65% {
      transform: scale(var(--scale));
      opacity: 1;
      animation-timing-function: ease;
    }
    85% {
      transform: scale(var(--scale));
      opacity: 1;
    }
    100% {
      transform: scale(0);
      opacity: 0;
    }
  }
  .gooey-nav li.active {
    color: black;
    text-shadow: none;
  }
  .gooey-nav li.active::after {
    opacity: 1;
    transform: scale(1);
  }
  .gooey-nav li::after {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: 8px;
    background: white;
    opacity: 0;
    transform: scale(0);
    transition: all 0.3s ease;
    z-index: -1;
  }
`;

export function GooeyNav({
  items,
  animationTime = 600,
  particleCount = 15,
  particleDistances = [90, 10],
  particleR = 100,
  timeVariance = 300,
  colors = [1, 2, 3, 1, 2, 3, 1, 4],
}: GooeyNavProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLUListElement>(null);
  const filterRef = useRef<HTMLSpanElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const { pathname } = useLocation();
  // The active item is derived from the actual route, so the gooey pill hugs
  // the page you are on — and stays hidden when none of the items match.
  const activeIndex = items.findIndex((item) => item.to === pathname);

  const noise = (n = 1) => n / 2 - Math.random() * n;
  const getXY = (distance: number, pointIndex: number, totalPoints: number): [number, number] => {
    const angle = ((360 + noise(8)) / totalPoints) * pointIndex * (Math.PI / 180);
    return [distance * Math.cos(angle), distance * Math.sin(angle)];
  };
  const createParticle = (i: number, t: number, d: [number, number], r: number) => {
    const rotate = noise(r / 10);
    return {
      start: getXY(d[0], particleCount - i, particleCount),
      end: getXY(d[1] + noise(7), particleCount - i, particleCount),
      time: t,
      scale: 1 + noise(0.2),
      color: colors[Math.floor(Math.random() * colors.length)],
      rotate: rotate > 0 ? (rotate + r / 20) * 10 : (rotate - r / 20) * 10,
    };
  };
  const makeParticles = (element: HTMLElement) => {
    const d: [number, number] = particleDistances;
    const r = particleR;
    const bubbleTime = animationTime * 2 + timeVariance;
    element.style.setProperty("--time", `${bubbleTime}ms`);
    for (let i = 0; i < particleCount; i++) {
      const t = animationTime * 2 + noise(timeVariance * 2);
      const p = createParticle(i, t, d, r);
      element.classList.remove("active");
      setTimeout(() => {
        const particle = document.createElement("span");
        const point = document.createElement("span");
        particle.classList.add("particle");
        particle.style.setProperty("--start-x", `${p.start[0]}px`);
        particle.style.setProperty("--start-y", `${p.start[1]}px`);
        particle.style.setProperty("--end-x", `${p.end[0]}px`);
        particle.style.setProperty("--end-y", `${p.end[1]}px`);
        particle.style.setProperty("--time", `${p.time}ms`);
        particle.style.setProperty("--scale", `${p.scale}`);
        particle.style.setProperty("--color", `var(--color-${p.color}, white)`);
        particle.style.setProperty("--rotate", `${p.rotate}deg`);
        point.classList.add("point");
        particle.appendChild(point);
        element.appendChild(particle);
        requestAnimationFrame(() => {
          element.classList.add("active");
        });
        setTimeout(() => {
          try {
            element.removeChild(particle);
          } catch {
            /* The particle may already have been cleaned up. */
          }
        }, t);
      }, 30);
    }
  };
  const updateEffectPosition = (element: HTMLElement | undefined | null) => {
    if (!containerRef.current || !filterRef.current || !textRef.current) return;
    if (!element) {
      // No active item — park the pill out of view.
      Object.assign(filterRef.current.style, {
        left: "-9999px",
        top: "0px",
        width: "0px",
        height: "0px",
      });
      Object.assign(textRef.current.style, {
        left: "-9999px",
        top: "0px",
        width: "0px",
        height: "0px",
      });
      textRef.current.innerText = "";
      return;
    }
    const containerRect = containerRef.current.getBoundingClientRect();
    const pos = element.getBoundingClientRect();
    const styles = {
      left: `${pos.x - containerRect.x}px`,
      top: `${pos.y - containerRect.y}px`,
      width: `${pos.width}px`,
      height: `${pos.height}px`,
    };
    Object.assign(filterRef.current.style, styles);
    Object.assign(textRef.current.style, styles);
    textRef.current.innerText = element.innerText;
  };
  const handleClick = (e: ReactMouseEvent<HTMLAnchorElement>, index: number) => {
    if (activeIndex === index) return;
    // Move the pill immediately and fire the particle burst; the Link below
    // handles navigation, and the route change re-syncs the active index.
    const liEl = e.currentTarget;
    updateEffectPosition(liEl);
    if (filterRef.current) {
      const particles = filterRef.current.querySelectorAll(".particle");
      particles.forEach((p) => filterRef.current!.removeChild(p));
    }
    if (textRef.current) {
      textRef.current.classList.remove("active");
      void textRef.current.offsetWidth;
      textRef.current.classList.add("active");
    }
    if (filterRef.current) {
      makeParticles(filterRef.current);
    }
  };
  const handleKeyDown = (e: ReactKeyboardEvent<HTMLAnchorElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      // Prevent the native keydown activation (which TanStack Link intercepts
      // via click to navigate) and fire the click ourselves instead — so
      // keyboard users get the particle burst AND the navigation.
      e.preventDefault();
      e.currentTarget.click();
    }
  };
  useEffect(() => {
    if (!navRef.current || !containerRef.current) return;
    const activeLi = navRef.current.querySelectorAll("li")[activeIndex] as HTMLElement | undefined;
    updateEffectPosition(activeLi);
    if (activeLi) {
      textRef.current?.classList.add("active");
    }
    const resizeObserver = new ResizeObserver(() => {
      const currentActiveLi = navRef.current?.querySelectorAll("li")[activeIndex] as
        HTMLElement | undefined;
      if (currentActiveLi) {
        updateEffectPosition(currentActiveLi);
      }
    });
    resizeObserver.observe(containerRef.current);
    return () => resizeObserver.disconnect();
  }, [activeIndex]);

  return (
    <>
      <style>{gooeyNavCss}</style>
      <div className="gooey-nav relative" ref={containerRef}>
        <nav className="relative flex" style={{ transform: "translate3d(0,0,0.01px)" }}>
          <ul
            ref={navRef}
            className="relative z-[3] m-0 flex list-none gap-8 p-0 px-4"
            style={{
              color: "white",
              textShadow: "0 1px 1px hsl(205deg 30% 10% / 0.2)",
            }}
          >
            {items.map((item, index) => (
              <li
                key={item.to}
                className={`relative cursor-pointer rounded-full text-white shadow-[0_0_0.5px_1.5px_transparent] transition-[background-color_color_box-shadow] duration-300 ease ${
                  activeIndex === index ? "active" : ""
                }`}
              >
                <Link
                  to={item.to}
                  onClick={(e) => handleClick(e, index)}
                  onKeyDown={(e) => handleKeyDown(e)}
                  className="inline-block px-[1em] py-[0.6em] outline-none"
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <span className="effect filter" ref={filterRef} />
        <span className="effect text" ref={textRef} />
      </div>
    </>
  );
}
