import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { WalletButton } from "./wallet-button";
import { useAlertSummary } from "../hooks/api";

const NAV = [
  { to: "/app", label: "Guard" },
  { to: "/monitor", label: "Monitor" },
  { to: "/score", label: "Score" },
  { to: "/ledger", label: "Ledger" },
] as const;

/** Chrome shared by every authenticated page: nav, alert badge, wallet. */
export function AppShell({ children }: { children: ReactNode }) {
  // Open critical alerts are the one thing worth interrupting any page for —
  // they also bias the guard's verdicts, so the count belongs in the chrome.
  const { data: summary } = useAlertSummary();
  const criticalCount = summary?.critical ?? 0;

  return (
    <div className="min-h-screen">
      <div className="noise-overlay" />
      <header className="sticky top-0 z-50 border-b border-white/[0.06] vantage-glass-heavy">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-6 px-6">
          <Link to="/" className="text-[13px] tracking-tight text-white/90">
            vantage
          </Link>

          <nav className="flex items-center gap-1">
            {NAV.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                className="tabular rounded-full px-3 py-1.5 text-[10px] uppercase tracking-[0.2em] text-text-secondary transition-colors hover:text-white/90"
                activeProps={{ className: "!text-white bg-white/[0.06]" }}
              >
                {item.label}
                {item.to === "/monitor" && criticalCount > 0 && (
                  <span className="ml-1.5 text-[color:var(--danger)]">{criticalCount}</span>
                )}
              </Link>
            ))}
          </nav>

          <div className="ml-auto">
            <WalletButton />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-10">{children}</main>
    </div>
  );
}
