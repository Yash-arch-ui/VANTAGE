// User-registered contracts — POST /api/contracts/register + GET /api/contracts.
//
// Lets a user register an arbitrary contract address with its ABI so the PSG
// pipeline's rich decode path (function names, typed results, custom revert
// reasons) works for contracts beyond the three demo deployments.
//
// Security model: the ABI is untrusted user input, but it is pure DATA —
// JSON parsed and handed to viem's decode functions, never eval'd or executed
// as code. A hostile ABI can at worst produce a failed or garbage simulation
// READ (everything downstream is eth_call-based; nothing signs or sends).
// All parsing is wrapped so malformed input is a clean 400, never a crash.
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { upsertUserContract, listUserContracts } from "../em/ledger.js";

const router = Router();

// ── Validation ──────────────────────────────────────────────────────────

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

/**
 * Basic sanity check, not full ABI-spec validation: the string must parse as
 * JSON, be an array, and contain at least one plausible ABI entry (an object
 * with a "type" of function/error/event/constructor). This mirrors the
 * accept-side of viem's parseAbi — anything viem cannot parse is later caught
 * defensively in the forecast path, never crashes.
 */
const ABI_ENTRY_TYPES = new Set(["function", "error", "event", "constructor"]);

function isPlausibleAbi(parsed: unknown): boolean {
  if (!Array.isArray(parsed) || parsed.length === 0) return false;
  return parsed.some(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      "type" in entry &&
      typeof (entry as { type: unknown }).type === "string" &&
      ABI_ENTRY_TYPES.has((entry as { type: string }).type),
  );
}

const registerBodySchema = z.object({
  address: z.string().regex(ADDRESS_RE, "address must be a valid hex address"),
  // The ABI arrives as a JSON-stringified array (the wire-friendly form of
  // what etherscan/forge emit). Non-string types fail here with a clean 400.
  abi: z.string().min(1, "abi must be a JSON-stringified ABI array"),
  label: z.string().max(100, "label must be at most 100 characters").optional(),
});

function validationError(res: Response, error: z.ZodError): void {
  res.status(400).json({
    error: "ValidationError",
    message: error.errors[0]?.message ?? "Invalid request",
    details: error.errors.map((e) => ({ path: e.path.join("."), message: e.message })),
  });
}

// ── POST /api/contracts/register ────────────────────────────────────────

router.post("/contracts/register", (req: Request, res: Response) => {
  try {
    // 1. Shape validation (address, abi string presence, optional label).
    const parsed = registerBodySchema.safeParse(req.body);
    if (!parsed.success) {
      validationError(res, parsed.error);
      return;
    }
    const { address, abi, label } = parsed.data;

    // 2. ABI validation — parse the JSON and sanity-check it is a plausible
    //    ABI array. Never trusts the payload to be well-formed JSON.
    let abiEntries: unknown;
    try {
      abiEntries = JSON.parse(abi);
    } catch {
      res.status(400).json({
        error: "ValidationError",
        message: "abi is not valid JSON",
        details: [{ path: "abi", message: "abi is not valid JSON" }],
      });
      return;
    }
    if (!isPlausibleAbi(abiEntries)) {
      res.status(400).json({
        error: "ValidationError",
        message:
          "abi must be a JSON array containing at least one entry with a type of function, error, event, or constructor",
        details: [
          {
            path: "abi",
            message:
              "abi must be a JSON array containing at least one entry with a type of function, error, event, or constructor",
          },
        ],
      });
      return;
    }

    // 3. Store. The stored string is the exact JSON the route just parsed and
    //    validated — re-serialized from the parsed value so a pretty-printed,
    //    whitespace-padded or duplicate-key payload normalizes to one form.
    const abiJson = JSON.stringify(abiEntries);
    const result = upsertUserContract(address, abiJson, label ?? null);
    if (result === "error") {
      // Address validation inside the ledger cannot fail here (zod already
      // enforced the same regex), so an error is a genuine DB refusal.
      res.status(500).json({
        error: "InternalServerError",
        message: "The contract could not be registered.",
      });
      return;
    }

    // 4. Return the stored record. 201 for a fresh registration, 200 when an
    //    existing registration was replaced (re-registering with a corrected
    //    ABI is a legitimate flow — the caller should be able to tell).
    const stored = {
      address: address.toLowerCase(),
      label: label ?? null,
      registered_at: new Date().toISOString(),
    };
    if (result === "replaced") {
      res.status(200).json({ ok: true, replaced: true, contract: stored });
      return;
    }
    res.status(201).json({ ok: true, replaced: false, contract: stored });
  } catch (err) {
    console.error("POST /contracts/register — unexpected error:", err);
    res.status(500).json({
      error: "InternalServerError",
      message: "An unexpected error occurred while processing the request.",
    });
  }
});

// ── GET /api/contracts ──────────────────────────────────────────────────

router.get("/contracts", (_req: Request, res: Response) => {
  try {
    // The ABI blob is deliberately omitted — a picker/dropdown needs the
    // address, label and registration time, not kilobytes of JSON per row.
    res.json({ items: listUserContracts() });
  } catch (err) {
    console.error("GET /contracts — unexpected error:", err);
    res.status(500).json({
      error: "InternalServerError",
      message: "An unexpected error occurred while processing the request.",
    });
  }
});

export default router;
