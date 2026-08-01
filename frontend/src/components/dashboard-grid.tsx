import React from "react";

export type PanelProps = {
  label?: string;
  children: React.ReactNode;
  className?: string;
};

export function Panel({ label, children, className = "" }: PanelProps) {
  return (
    <div
      className={`flex flex-col bg-[#0E0E11] border border-white/5 rounded-2xl shadow-[inset_0_1px_0_0_rgba(255,255,255,0.02)] overflow-hidden relative ${className}`}
    >
      {label && (
        <div className="px-6 py-4 border-b border-white/5 text-[10px] text-[#8B8D98] tracking-widest uppercase">
          {label}
        </div>
      )}
      {children}
    </div>
  );
}

export type DashboardGridProps = {
  chart: React.ReactNode;
  activity: React.ReactNode;
};

export function DashboardGrid({ chart, activity }: DashboardGridProps) {
  return (
    <section className="grid grid-cols-1 lg:grid-cols-[1fr_400px] gap-6 w-full h-[560px]">
      {chart}
      {activity}
    </section>
  );
}
