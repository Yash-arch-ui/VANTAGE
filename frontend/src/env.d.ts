/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the Vantage backend, e.g. http://localhost:4000 */
  readonly VITE_API_URL: string;
  /** Monad testnet RPC the browser uses for reads and for broadcasting. */
  readonly VITE_RPC_URL: string;
  readonly VITE_CHAIN_ID: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
