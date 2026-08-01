export type DataSource = "live" | "indexed" | "manifest" | "computed" | "simulated" | "unavailable";

const LABELS: Record<DataSource, string> = {
  live: "live",
  indexed: "indexed",
  manifest: "manifest",
  computed: "computed",
  simulated: "simulated",
  unavailable: "unavailable",
};

export function DataSourceBadge({ source }: { source: DataSource }) {
  const active = source === "live" || source === "indexed";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 tabular text-[9px] uppercase tracking-[0.18em] ${
        active
          ? "border-white/25 bg-white/[0.04] text-white"
          : "border-white/10 bg-white/[0.02] text-white/45"
      }`}
    >
      <span className={`h-1 w-1 rounded-full ${active ? "bg-white" : "bg-white/35"}`} />
      {LABELS[source]}
    </span>
  );
}
