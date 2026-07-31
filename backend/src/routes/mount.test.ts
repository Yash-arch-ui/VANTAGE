// Route-mount audit guard.
//
// Catches the exact bug that bit this session: a routes/*.ts file existing on
// disk but never mounted in server.ts (the watchlist router sat unmounted for
// a while — all five of its endpoints 404'd silently). Every non-stub router
// must be BOTH imported and app.use()'d in src/server.ts.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROUTES_DIR = resolve(__dirname, ".");
const SERVER_PATH = resolve(__dirname, "../server.ts");

const serverSrc = readFileSync(SERVER_PATH, "utf-8");
const routeFiles = readdirSync(ROUTES_DIR)
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
  .sort();

describe("route mount audit — every route file is mounted in server.ts", () => {
  for (const file of routeFiles) {
    const name = file.replace(/\.ts$/, "");
    const src = readFileSync(resolve(ROUTES_DIR, file), "utf-8");
    const isStub = src.trim() === "export {};";

    it(`${file} ${isStub ? "is an empty stub (exempt from mounting)" : "is imported + mounted in server.ts"}`, () => {
      if (isStub) return; // `export {}` only — no endpoints to mount
      const routerVar = `${name}Router`;
      assert.ok(
        serverSrc.includes(`import ${routerVar} from "./routes/${name}.js"`),
        `${file} exists but is not imported in server.ts`,
      );
      assert.ok(
        serverSrc.includes(`app.use("/api", ${routerVar})`),
        `${file} is imported but not mounted via app.use in server.ts`,
      );
    });
  }
});
