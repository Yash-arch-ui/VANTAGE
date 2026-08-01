import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { monadTestnet } from "wagmi/chains";

/**
 * Single chain by design: the whole product is a Monad-specific safety layer,
 * and the backend's simulation and mempool logic assume this chain.
 *
 * Module-level (not inside a component) so the config identity is stable
 * across renders — recreating it resets every connection.
 */
export const wagmiConfig = createConfig({
  chains: [monadTestnet],
  connectors: [injected()],
  transports: {
    [monadTestnet.id]: http(import.meta.env.VITE_RPC_URL),
  },
  ssr: true,
});

export { monadTestnet };

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
