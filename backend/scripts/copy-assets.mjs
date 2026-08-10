// Copy non-TypeScript runtime assets into dist/.
//
// `tsc` emits .ts -> .js and copies nothing else, so src/em/schema.sql never
// reached the build output. initDatabase then threw ENOENT against a fresh
// database and the server came up with no tables at all — every endpoint
// answering 200 while recording nothing. Local dev never saw it because tsx
// runs from src/, where the file exists.
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Source path (relative to backend/) -> destination path.
 *
 * A source may be an array of candidates — the first one that exists wins.
 * deployments.json needs this because it lives at ../contracts/deployments.json
 * in the full monorepo (local dev) but must also work in a backend-only deploy
 * (rootDir: backend), where contracts/ is never present. In that layout the
 * file ships as backend/deployments.json, which must therefore be committed to
 * the repo and kept in sync with contracts/deployments.json.
 */
const ASSETS = [
  ["src/em/schema.sql", "dist/em/schema.sql"],
  // KNOWN_CONTRACTS (AMM/ClaimContract) is keyed from deployments.json. If it
  // never reaches dist/, the guard loses every known contract and degrades to
  // the generic (historically buggy) call path.
  [["../contracts/deployments.json", "deployments.json"], "dist/deployments.json"],
];

for (const [from, to] of ASSETS) {
  const candidates = Array.isArray(from) ? from : [from];
  const srcs = candidates.map((c) => resolve(root, c));
  const src = srcs.find((p) => existsSync(p));
  const dest = resolve(root, to);

  if (!src) {
    console.error(`[copy-assets] missing source asset: ${candidates.join(" or ")}`);
    process.exit(1);
  }

  // When more than one candidate exists, the first wins. If the committed
  // backend/deployments.json has drifted from contracts/deployments.json,
  // surface it so a later backend-only deploy doesn't ship stale addresses.
  const others = srcs.filter((p) => p !== src && existsSync(p));
  for (const other of others) {
    if (readFileSync(src).toString() !== readFileSync(other).toString()) {
      console.warn(
        `[copy-assets] warning: ${other} differs from ${src} — keep deployments.json copies in sync`
      );
    }
  }

  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  console.log(`[copy-assets] ${candidates.join(" | ")} -> ${to}`);
}
