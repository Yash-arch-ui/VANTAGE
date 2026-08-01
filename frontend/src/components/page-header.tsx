export type PageHeaderProps = {
  title: string;
  subtitle: string;
  blockNumber: string;
  live?: boolean;
};

export function PageHeader({ title, subtitle, blockNumber, live = true }: PageHeaderProps) {
  return (
    <header className="flex flex-col md:flex-row md:justify-between md:items-end w-full mb-2 gap-4">
      <div>
        <h1 className="text-3xl font-medium tracking-tight text-[#F3F4F6]">{title}</h1>
        <p className="text-sm text-[#8B8D98] mt-2 max-w-xl">{subtitle}</p>
      </div>
      <div className="flex items-center gap-3 px-4 py-2 bg-white/[0.02] border border-white/5 rounded-full backdrop-blur-sm">
        <SyncDot active={live} />
        <span
          className="text-[10px] font-mono text-[#8B8D98] tracking-widest uppercase"
          style={{ fontVariantNumeric: "tabular-nums" }}
        >
          {live ? "live · " : ""}block #{blockNumber}
        </span>
      </div>
    </header>
  );
}

export type SyncDotProps = {
  active?: boolean;
};

export function SyncDot({ active }: SyncDotProps) {
  return (
    <div
      className={`w-1.5 h-1.5 rounded-full shadow-[0_0_8px_currentColor] ${
        active ? "bg-[#10B981] text-[#10B981] animate-pulse" : "bg-[#EF4444] text-[#EF4444]"
      }`}
    />
  );
}
