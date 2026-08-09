import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { AMM_ADDRESS, ammAbi } from "../config/contracts";

export type PoolReserves = {
  tokenReserve: bigint;
  monReserve: bigint;
};

/**
 * Live AMM reserves, read straight off the chain (getReserves) rather than
 * through the backend. This matches the two patterns already in the codebase:
 * useTxBuilder does the same direct readContract via usePublicClient for its
 * quote, and the query layer polls at a fixed cadence for anything live.
 * Reserves shift mid-session (a swap, or a Watchdog manipulateReserves call),
 * so the panel refreshes every 10s to stay current.
 */
const RESERVES_POLL_MS = 10_000;

export function usePoolReserves() {
  const publicClient = usePublicClient();
  return useQuery<PoolReserves>({
    queryKey: ["pool-reserves", AMM_ADDRESS],
    queryFn: async () => {
      if (!publicClient) throw new Error("No RPC client available.");
      const [tokenReserve, monReserve] = (await publicClient.readContract({
        address: AMM_ADDRESS,
        abi: ammAbi,
        functionName: "getReserves",
      })) as [bigint, bigint];
      return { tokenReserve, monReserve };
    },
    // Don't fire until the wagmi provider has mounted a public client.
    enabled: Boolean(publicClient),
    refetchInterval: RESERVES_POLL_MS,
  });
}
