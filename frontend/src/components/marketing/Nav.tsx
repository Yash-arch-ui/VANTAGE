"use client";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";

const navLinks = [
  { label: "guard", to: "/app" as const },
  { label: "monitor", to: "/monitor" as const },
  { label: "ledger", to: "/ledger" as const },
] as const;

export function Nav() {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20);
    onScroll();
    window.addEventListener("scroll", onScroll);
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={`fixed inset-x-0 top-0 z-50 transition-all duration-500 ${
        scrolled ? "border-b border-white/5 bg-[#08080A]/70 py-3 backdrop-blur-xl" : "py-4"
      }`}
    >
      <div className="mx-auto flex max-w-[1400px] items-center justify-between px-6">
        <Link to="/" className="flex items-center gap-2.5">
          <span className="grid h-6 w-6 place-items-center rounded-sm border border-white/15 bg-white/[0.02]">
            <span className="h-1.5 w-1.5 rounded-full bg-white" />
          </span>
          <span className="text-[13px] tracking-tight text-white/90">vantage</span>
        </Link>

        <nav className="hidden items-center gap-8 text-[13px] md:flex">
          {navLinks.map((link) => (
            <Link
              key={link.label}
              to={link.to}
              className="text-white/55 transition-colors duration-300 hover:text-white"
              activeProps={{ className: "text-white" }}
            >
              {link.label}
            </Link>
          ))}
        </nav>

        <Link
          to="/app"
          className="rounded-full border border-white/20 bg-white/[0.04] px-5 py-2.5 text-[10px] font-bold uppercase tracking-[0.2em] text-white backdrop-blur-md transition-all hover:bg-white hover:text-black"
        >
          Open Guard
        </Link>
      </div>
    </header>
  );
}
