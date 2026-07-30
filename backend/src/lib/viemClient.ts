import { createWalletClient, http } from "viem";

export const viemClient = createWalletClient({
  transport: http(),
}) as unknown as import("viem").WalletClient;

export {};