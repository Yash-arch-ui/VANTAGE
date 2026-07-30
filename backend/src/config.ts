export const config = {
  port: parseInt(process.env.PORT ?? "4000"),
  rpcUrl: process.env.MONAD_TESTNET_RPC_URL ?? "",
  chainId: parseInt(process.env.MONAD_CHAIN_ID ?? "10143"),
  privateKey: process.env.PRIVATE_KEY ?? "",
  databasePath: process.env.DATABASE_PATH ?? "./vantage.db",
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
} as const;

export {};