import { createFileRoute } from "@tanstack/react-router";
import { WalletButton } from "../components/wallet-button";

export const Route = createFileRoute("/")({
  component: Home,
});

// Placeholder shell. The real landing page lands in a later pass — this exists
// so the scaffold is verifiably running end to end (theme, providers, wallet).
function Home() {
  return (
    <main className="grid-blueprint flex min-h-screen flex-col items-center justify-center gap-8 px-6">
      <div className="noise-overlay" />
      <div className="text-center">
        <p className="tabular text-[10px] uppercase tracking-[0.3em] text-text-secondary">
          Monad testnet
        </p>
        <h1 className="mt-4 font-serif text-6xl tracking-tight">Vantage</h1>
        <p className="mt-4 max-w-md text-sm text-text-secondary">
          See what your transaction will actually do — before you sign it.
        </p>
      </div>
      <WalletButton />
    </main>
  );
}
