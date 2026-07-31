// Side-effect env loader for proof scripts.
//
// Must be imported FIRST (before ../src/config.js), because ESM evaluates
// imports in source order — config.ts reads process.env at module load time,
// so the parent .env has to be on process.env before config.ts evaluates.
// Proof scripts that run standalone (not via `set -a && . ../.env`) rely on
// this; it's a no-op when the env is already sourced.
import dotenv from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (!process.env.RPC_URL || !process.env.PRIVATE_KEY) {
  dotenv.config({
    path: resolve(dirname(fileURLToPath(import.meta.url)), "../../.env"),
  });
}

export {};
