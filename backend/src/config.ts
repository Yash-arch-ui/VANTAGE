import dotenv from "dotenv";
dotenv.config();
export const config = {
  port: parseInt(process.env.PORT ?? "4000"),
  rpcUrl: process.env.RPC_URL || "https://testnet-rpc.monad.xyz",
  chainId: parseInt(process.env.MONAD_CHAIN_ID ?? "10143"),
  privateKey: process.env.PRIVATE_KEY ?? "",
  databasePath: process.env.DATABASE_PATH ?? "./vantage.db",
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
} as const;

export {};