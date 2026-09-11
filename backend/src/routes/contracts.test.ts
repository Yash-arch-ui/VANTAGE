// HTTP-level tests for POST /api/contracts/register and GET /api/contracts.
//
// The real app is imported and bound to an ephemeral port (no mocks, no
// supertest) — the registered contracts land in a real throwaway SQLite DB,
// so the store/read round-trip is what production sees. Malformed ABI inputs
// (invalid JSON, empty array, garbage data) must be clean 400s, never a crash
// and never a 500.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { Express } from "express";

const tmpDir = mkdtempSync(join(tmpdir(), "vantage-contracts-"));
process.env.DATABASE_PATH = join(tmpDir, "contracts.db");
process.env.VANTAGE_NO_LISTEN = "1";

let server: Server;
let base: string;

before(async () => {
  const { app } = (await import("../server.js")) as { app: Express };
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port bound");
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ── Fixtures ────────────────────────────────────────────────────────────

/** A plausible, minimal ERC-20-ish ABI with a custom error. */
const GOOD_ABI = JSON.stringify([
  { type: "error", name: "TransferFailed", inputs: [] },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ type: "address", name: "who" }],
    outputs: [{ type: "uint256", name: "" }],
  },
]);

const ADDRESS_A = "0x1111111111111111111111111111111111111111";
const ADDRESS_B = "0x2222222222222222222222222222222222222222";

async function postRegister(body: unknown) {
  const res = await fetch(`${base}/api/contracts/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

// ── POST /api/contracts/register ────────────────────────────────────────

describe("POST /api/contracts/register — validation", () => {
  it("201s and stores a well-formed registration", async () => {
    const { status, body } = await postRegister({
      address: ADDRESS_A,
      abi: GOOD_ABI,
      label: "My Token",
    });
    assert.equal(status, 201);
    assert.equal(body.ok, true);
    assert.equal(body.replaced, false);
    const contract = body.contract as { address: string; label: string | null; registered_at: string };
    assert.equal(contract.address, ADDRESS_A); // stored lowercased
    assert.equal(contract.label, "My Token");
    assert.ok(typeof contract.registered_at === "string");
  });

  it("200s (replaced) when re-registering the same address", async () => {
    const { status, body } = await postRegister({
      address: ADDRESS_A,
      abi: GOOD_ABI,
      label: "My Token v2",
    });
    assert.equal(status, 200);
    assert.equal(body.replaced, true);
  });

  it("rejects an invalid address with 400", async () => {
    const { status, body } = await postRegister({ address: "0xnope", abi: GOOD_ABI });
    assert.equal(status, 400);
    assert.equal(body.error, "ValidationError");
  });

  it("rejects a missing abi with 400", async () => {
    const { status } = await postRegister({ address: ADDRESS_B });
    assert.equal(status, 400);
  });

  it("rejects invalid JSON as the abi with 400", async () => {
    const { status, body } = await postRegister({
      address: ADDRESS_B,
      abi: "{not json at all",
    });
    assert.equal(status, 400);
    assert.equal(body.error, "ValidationError");
    assert.match(String(body.message), /not valid JSON/);
  });

  it("rejects an empty ABI array with 400", async () => {
    const { status } = await postRegister({ address: ADDRESS_B, abi: "[]" });
    assert.equal(status, 400);
  });

  it("rejects garbage data (non-array JSON) with 400", async () => {
    const { status } = await postRegister({ address: ADDRESS_B, abi: '"hello"' });
    assert.equal(status, 400);
  });

  it("rejects an array with no plausible ABI entry with 400", async () => {
    // Valid JSON array, but no entry with a recognized "type".
    const { status } = await postRegister({
      address: ADDRESS_B,
      abi: JSON.stringify([{ foo: "bar" }, { type: 42 }]),
    });
    assert.equal(status, 400);
  });

  it("rejects a non-string abi (array passed directly) with 400", async () => {
    // The wire format is a JSON-stringified ABI; a raw array fails zod shape
    // validation before any parsing happens.
    const { status } = await postRegister({
      address: ADDRESS_B,
      abi: [{ type: "function", name: "x" }],
    });
    assert.equal(status, 400);
  });

  it("accepts an ABI with only an event entry (plausible) — registration is not decoding", async () => {
    const { status } = await postRegister({
      address: ADDRESS_B,
      abi: JSON.stringify([{ type: "event", name: "Transfer", inputs: [] }]),
      label: "events-only",
    });
    assert.equal(status, 201);
  });
});

// ── GET /api/contracts ──────────────────────────────────────────────────

describe("GET /api/contracts", () => {
  it("lists registered contracts without the ABI blob", async () => {
    const res = await fetch(`${base}/api/contracts`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      items: { address: string; label: string | null; registered_at: string }[];
    };
    assert.ok(Array.isArray(body.items));
    assert.ok(body.items.length >= 2, "both registrations from above are present");
    const a = body.items.find((c) => c.address === ADDRESS_A);
    assert.ok(a, "ADDRESS_A is listed");
    assert.equal(a?.label, "My Token v2");
    // The list view never ships the ABI blob.
    const raw = body.items[0] as Record<string, unknown>;
    assert.ok(!("abi_json" in raw) && !("abi" in raw));
  });
});
