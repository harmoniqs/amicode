// ============================================================================
// warrant_bounds.ts — the warrant-bounds validator for the PLUGIN transport
// (codesign SEAM 6, amicode#703: the autonomy datum, device {none|ro|rw}).
//
// ONE DEFINITION: the bounds vocabulary — and the device datum's enum + its
// documented semantics — live in @amicode/schema's $defs.bounds of the
// ledger-record schema. The CORE tool table (src/amicode_tools_core.ts)
// validates against it directly via validateBounds(). This module exists ONLY
// because the plugin runtime cannot reach that package: amicode_tools.ts
// executes inside opencode's embedded Bun via a relative import, and ONLY
// relative sibling imports (plus node: builtins) resolve there — bare package
// specifiers do not (same construction constraint as ./ledger_client, which
// is why it re-implements resolveAmicoBinFrom). Unreachable by construction,
// not by choice.
//
// So this is the schema's $defs.bounds re-implemented dependency-free, with
// ERROR STRINGS MIRRORED from the schema's formatError rendering, and PINNED
// to the definition by test/warrant_bounds_parity.test.ts: the parity test
// runs this validator and @amicode/schema's validateBounds over the same
// corpus (every datum case included) and requires agreement on ok AND on the
// error strings — if the schema's bounds vocabulary moves, the pin fails until
// this twin follows.
// ============================================================================

/** The device datum's three states — THE single switch for what a warrant may
 *  do to a device (none = no device access; ro = read-only device access;
 *  rw = device writes permitted, gated by the real-board-session human gate).
 *  Mirrors $defs.bounds.properties.device.enum. */
export const DEVICE_DATUM = ["none", "ro", "rw"] as const;

type BoundsValidation = { ok: boolean; errors: string[] };

/** Validate a bare WarrantBounds object against the mirrored $defs.bounds.
 *  Field-precise like the schema's own validator: every error names the
 *  offending key. Pure, no imports. */
export function validateWarrantBounds(input: unknown): BoundsValidation {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, errors: ["(root): must be object"] };
  }
  const obj = input as Record<string, unknown>;
  const errors: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    switch (key) {
      case "max_solves":
        if (typeof value !== "number" || !Number.isInteger(value)) {
          errors.push("/max_solves: must be integer");
        } else if (value < 1) {
          errors.push("/max_solves: must be >= 1");
        }
        break;
      case "tier":
        if (typeof value !== "string") errors.push("/tier: must be string");
        else if (value.length < 1) errors.push("/tier: must NOT have fewer than 1 characters");
        break;
      case "max_size_class":
        if (value !== "SMALL" && value !== "MEDIUM") {
          errors.push("/max_size_class: must be one of (SMALL, MEDIUM)");
        }
        break;
      case "device":
        if (typeof value !== "string" || !(DEVICE_DATUM as readonly string[]).includes(value)) {
          errors.push("/device: must be one of (none, ro, rw)");
        }
        break;
      default:
        // additionalProperties:false — an unknown key (a second device knob,
        // a removed bound, anything) is refused, naming the impostor key.
        errors.push(`(root): unknown key "${key}"`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/** The bounds vocabulary as the tool surface states it — one string, shared by
 *  the plugin's refusal message and its args description so the two cannot
 *  drift. Mirrors the vocabulary line the core renders. */
export const BOUNDS_VOCABULARY =
  "{max_solves: int>=1, tier: string, max_size_class: 'SMALL'|'MEDIUM', device: 'none'|'ro'|'rw'}";

export function boundsRefusal(errors: string[]): string {
  return (
    `Cannot request approval: bounds are invalid against the ` +
    `@amicode/schema warrant-bounds schema — ${errors.join("; ")}. ` +
    `The bounds vocabulary is ${BOUNDS_VOCABULARY} — ` +
    `device is the autonomy datum (one enum, no second knob); pass ` +
    `null to omit bounds.`
  );
}
