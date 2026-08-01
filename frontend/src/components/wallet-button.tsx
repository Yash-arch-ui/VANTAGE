import { useAccount, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { toast } from "sonner";
import { monadTestnet } from "../config/wagmi";

const BUTTON_CLASS =
  "bg-white/[0.04] border border-white/10 hover:bg-white/[0.08] hover:border-white/20 text-xs font-medium tracking-widest uppercase px-4 py-2 rounded-full transition-all flex items-center gap-2 outline-none focus-visible:border-white/30 text-white disabled:opacity-60";

export function WalletButton() {
  const { address, isConnected, chainId } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: isSwitching } = useSwitchChain();

  const handleConnect = () => {
    // Use the connector registered in the WagmiProvider config — not a freshly
    // created injected() instance, which is not wired to the config's emitter and
    // can make connect() silently no-op (the MetaMask popup never fires).
    const injectedConnector =
      connectors.find((c) => c.id === "injected" || c.type === "injected") ?? connectors[0];

    if (
      !injectedConnector ||
      typeof window === "undefined" ||
      !(window as unknown as { ethereum?: unknown }).ethereum
    ) {
      toast.error(
        "No browser wallet detected. Install MetaMask and open this page in that browser.",
      );
      return;
    }

    connect(
      { connector: injectedConnector },
      {
        onError: (error) => {
          toast.error(error.message || "Failed to connect wallet");
        },
      },
    );
  };

  if (!isConnected || !address) {
    return (
      <button onClick={handleConnect} disabled={isPending} className={BUTTON_CLASS}>
        <span>{isPending ? "Connecting…" : "Connect"}</span>
      </button>
    );
  }

  // Everything downstream — simulation, nonce, contention — is Monad-specific.
  // A wallet on another chain would produce transactions the backend cannot
  // meaningfully evaluate, so surface it here rather than failing later.
  if (chainId !== monadTestnet.id) {
    return (
      <button
        onClick={() => switchChain({ chainId: monadTestnet.id })}
        disabled={isSwitching}
        className={`${BUTTON_CLASS} !border-[color:var(--caution)]/40 !text-[color:var(--caution)]`}
      >
        <span className="w-1.5 h-1.5 rounded-full bg-[color:var(--caution)]" />
        <span>{isSwitching ? "Switching…" : "Wrong network"}</span>
      </button>
    );
  }

  return (
    <button onClick={() => disconnect()} className={BUTTON_CLASS}>
      <span className="w-1.5 h-1.5 rounded-full bg-[color:var(--safe)] shadow-[0_0_6px_var(--safe)]" />
      <span className="font-mono normal-case tracking-tight">
        {`${address.slice(0, 6)}...${address.slice(-4)}`}
      </span>
    </button>
  );
}
