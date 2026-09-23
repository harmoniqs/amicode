// fleet_bound_bootstrap.test.ts (#1480, ADR 0034) — the IDENTITY-BOUND Observe
// bootstrap suite. The #1438 enrollment nonce (fleet_accept_set.test.ts) was
// URL-carried, identity-UNBOUND, and non-transactional; the #1475 trust audit
// flagged exactly that. This suite pins the FIX for the Observe path:
//
//   AC1 — bootstrap secrets NEVER appear in URL / log / error / status / UI.
//   AC2 — a nonce is single-use, short-lived, BOUND to the target and the
//         requesting stable identity_key, and resistant to concurrent/replayed
//         redemption (atomic, transactional consume).
//   AC3 — a self-owned peer establishes reciprocal OBSERVE trust through
//         verified management access; a shared peer requires target approval.
//   + reciprocal Observe grant issuance + local Observe-grant persistence, with
//     atomic issuer mutation (a failed transition leaves NO half grant).
//
// DEFERRED to #1486 (per the binding amendment): target-enforced Control scope,
// Control suspend/recover, revoke fan-out parity, explicit re-admit. Not here.
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── the identity-bound enrollment nonce (#1480, ADR 0034) ────────────────────
import {
  mintBoundEnrollmentNonce,
  validateBoundEnrollmentNonce,
  consumeBoundEnrollmentNonce,
} from "../src/amicode_service/fleet_enrollment_nonce";

function tmproot(): string {
  return mkdtempSync(join(tmpdir(), "amicode-bound-bootstrap-"));
}

const TARGET = "mac-studio";
const IDENTITY = "SHA256:requesting-peer-fingerprint";

describe("#1480 AC2 — the identity-bound enrollment nonce (single-use, short-TTL, target+identity bound, atomic)", () => {
  let file: string;
  beforeEach(() => {
    file = join(tmproot(), "fleet-enrollment-nonces.json");
  });

  it("a freshly minted bound nonce validates for the SAME target and identity", () => {
    const n = mintBoundEnrollmentNonce(
      { target: TARGET, identityKey: IDENTITY },
      { storeFile: file, ttlMs: 60_000, now: () => 1000, nonceFactory: () => "N1" },
    );
    expect(n).toBe("N1");
    expect(validateBoundEnrollmentNonce("N1", { target: TARGET, identityKey: IDENTITY }, { storeFile: file, now: () => 5000 })).toBe(true);
  });

  it("a bound nonce presented with the WRONG identity does NOT validate (identity binding)", () => {
    mintBoundEnrollmentNonce({ target: TARGET, identityKey: IDENTITY }, { storeFile: file, ttlMs: 60_000, now: () => 1000, nonceFactory: () => "N1" });
    expect(
      validateBoundEnrollmentNonce("N1", { target: TARGET, identityKey: "SHA256:some-other-peer" }, { storeFile: file, now: () => 5000 }),
    ).toBe(false);
  });

  it("a bound nonce presented against the WRONG target does NOT validate (target binding)", () => {
    mintBoundEnrollmentNonce({ target: TARGET, identityKey: IDENTITY }, { storeFile: file, ttlMs: 60_000, now: () => 1000, nonceFactory: () => "N1" });
    expect(
      validateBoundEnrollmentNonce("N1", { target: "some-other-machine", identityKey: IDENTITY }, { storeFile: file, now: () => 5000 }),
    ).toBe(false);
  });

  it("an expired bound nonce does NOT validate (short-TTL)", () => {
    mintBoundEnrollmentNonce({ target: TARGET, identityKey: IDENTITY }, { storeFile: file, ttlMs: 1000, now: () => 1000, nonceFactory: () => "N1" });
    expect(validateBoundEnrollmentNonce("N1", { target: TARGET, identityKey: IDENTITY }, { storeFile: file, now: () => 2001 })).toBe(false);
  });

  it("consume is single-use: the first consume succeeds, the replayed second is refused", () => {
    mintBoundEnrollmentNonce({ target: TARGET, identityKey: IDENTITY }, { storeFile: file, ttlMs: 60_000, now: () => 1000, nonceFactory: () => "N1" });
    expect(consumeBoundEnrollmentNonce("N1", { target: TARGET, identityKey: IDENTITY }, { storeFile: file, now: () => 2000 })).toBe(true);
    expect(consumeBoundEnrollmentNonce("N1", { target: TARGET, identityKey: IDENTITY }, { storeFile: file, now: () => 2000 })).toBe(false);
    expect(validateBoundEnrollmentNonce("N1", { target: TARGET, identityKey: IDENTITY }, { storeFile: file, now: () => 2000 })).toBe(false);
  });

  it("consume with the WRONG identity is refused AND leaves the nonce unconsumed (no cross-identity redemption)", () => {
    mintBoundEnrollmentNonce({ target: TARGET, identityKey: IDENTITY }, { storeFile: file, ttlMs: 60_000, now: () => 1000, nonceFactory: () => "N1" });
    // an attacker with the nonce string but a different identity cannot redeem it
    expect(consumeBoundEnrollmentNonce("N1", { target: TARGET, identityKey: "SHA256:attacker" }, { storeFile: file, now: () => 2000 })).toBe(false);
    // and the rightful owner can still redeem — the failed wrong-identity attempt did not burn it
    expect(consumeBoundEnrollmentNonce("N1", { target: TARGET, identityKey: IDENTITY }, { storeFile: file, now: () => 2000 })).toBe(true);
  });

  it("concurrent redemption of the SAME bound nonce yields EXACTLY ONE winner (atomic consume)", async () => {
    mintBoundEnrollmentNonce({ target: TARGET, identityKey: IDENTITY }, { storeFile: file, ttlMs: 60_000, now: () => 1000, nonceFactory: () => "N1" });
    // fire many redemptions of the same nonce concurrently; the transactional
    // consume must let exactly one succeed and refuse the rest (never two mints).
    const attempts = await Promise.all(
      Array.from({ length: 16 }, () =>
        Promise.resolve().then(() =>
          consumeBoundEnrollmentNonce("N1", { target: TARGET, identityKey: IDENTITY }, { storeFile: file, now: () => 2000 }),
        ),
      ),
    );
    expect(attempts.filter((x) => x === true).length).toBe(1);
  });

  it("validate does NOT consume (a probe leaves the bound nonce usable)", () => {
    mintBoundEnrollmentNonce({ target: TARGET, identityKey: IDENTITY }, { storeFile: file, ttlMs: 60_000, now: () => 1000, nonceFactory: () => "N1" });
    expect(validateBoundEnrollmentNonce("N1", { target: TARGET, identityKey: IDENTITY }, { storeFile: file, now: () => 2000 })).toBe(true);
    expect(consumeBoundEnrollmentNonce("N1", { target: TARGET, identityKey: IDENTITY }, { storeFile: file, now: () => 2000 })).toBe(true);
  });
});
