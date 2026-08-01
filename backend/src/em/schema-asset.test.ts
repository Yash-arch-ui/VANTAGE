// Guards the runtime asset that `tsc` does not copy.
//
// schema.sql sits next to ledger.js at runtime and is read with readFileSync.
// tsc emits only .js, so without an explicit copy step the compiled server
// throws ENOENT on a fresh database and comes up with no tables — answering 200
// on every route while persisting nothing. This asserts the source file is
// where ledger.ts expects it and that the build is wired to carry it across.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = resolve(__dirname, "../..");

describe("schema.sql ships with the build", () => {
  it("sits beside ledger.ts, where readFileSync looks for it", () => {
    assert.ok(existsSync(resolve(__dirname, "schema.sql")), "src/em/schema.sql is missing");
  });

  it("declares every table the ledger queries", () => {
    const schema = readFileSync(resolve(__dirname, "schema.sql"), "utf-8");
    for (const table of ["execution_ledger", "contention_thresholds", "watchlist", "alerts"]) {
      assert.match(
        schema,
        new RegExp(`CREATE TABLE IF NOT EXISTS\\s+${table}`, "i"),
        `schema.sql does not create ${table}`,
      );
    }
  });

  it("the build script copies assets rather than running tsc alone", () => {
    const pkg = JSON.parse(readFileSync(resolve(BACKEND_ROOT, "package.json"), "utf-8")) as {
      scripts: Record<string, string>;
    };
    assert.match(
      pkg.scripts.build,
      /copy-assets/,
      "build must copy runtime assets — bare `tsc` drops schema.sql and the deployed server cannot create its tables",
    );
    assert.ok(
      existsSync(resolve(BACKEND_ROOT, "scripts/copy-assets.mjs")),
      "scripts/copy-assets.mjs is missing",
    );
  });
});
