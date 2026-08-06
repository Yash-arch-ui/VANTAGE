// Copy non-TypeScript runtime assets into dist/.
//
// `tsc` emits .ts -> .js and copies nothing else, so src/em/schema.sql never
// reached the build output. initDatabase then threw ENOENT against a fresh
// database and the server came up with no tables at all — every endpoint
// answering 200 while recording nothing. Local dev never saw it because tsx
// runs from src/, where the file exists.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Source path (relative to backend/) -> destination path. */
const ASSETS = [
  ["src/em/schema.sql", "dist/em/schema.sql"],
  // KNOWN_CONTRACTS (MockAMM/MockClaim) is keyed from deployments.json. A
  // backend-only deploy (rootDir: backend) cannot resolve ../../../contracts/
  // from dist/psg, so a copy must ship inside dist/ or the guard loses every
  // known contract and degrades to the generic (historically buggy) call path.
  ["../contracts/deployments.json", "dist/deployments.json"],
];

for (const [from, to] of ASSETS) {
  const src = resolve(root, from);
  const dest = resolve(root, to);

  if (!existsSync(src)) {
    console.error(`[copy-assets] missing source asset: ${from}`);
    process.exit(1);
  }

  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  console.log(`[copy-assets] ${from} -> ${to}`);
}
