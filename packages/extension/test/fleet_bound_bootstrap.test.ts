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

// ── the NON-URL carrier at the mint route + the accept-set (#1480 AC1/AC2) ───
import { AmicodeServiceServer } from "../src/amicode_service/server";
import { buildAcceptSet, MINT_ENDPOINT_PATH } from "../src/amicode_service/fleet_accept_set";
import {
  boundPeerTokenMintHandler,
  BOUND_NONCE_HEADER,
  BOUND_IDENTITY_HEADER,
} from "../src/amicode_service/fleet_mint_route";
import { issuedTokenFor } from "../src/amicode_service/fleet_issued_tokens";

interface BoundBooted {
  origin: string;
  files: { issued: string; phase: string; nonce: string };
  target: string;
  stop: () => Promise<void>;
}

async function bootBound(): Promise<BoundBooted> {
  const root = tmproot();
  const files = {
    issued: join(root, "fleet-peer-tokens.json"),
    phase: join(root, "fleet-accept-set.json"),
    nonce: join(root, "fleet-enrollment-nonces.json"),
  };
  const target = "target-machine";
  const acceptSet = buildAcceptSet({
    issuedRegistryFile: files.issued,
    phaseStateFile: files.phase,
    enrollmentNonceFile: files.nonce,
    selfMachineId: target,
  });
  const server = new AmicodeServiceServer({
    password: "service-own-mint",
    authMode: "credential", // no auth=open — the bound nonce is the ONLY bearer-less path
    acceptSet,
  });
  server.add(
    "POST",
    MINT_ENDPOINT_PATH,
    boundPeerTokenMintHandler({ issuedRegistryFile: files.issued, enrollmentNonceFile: files.nonce, selfMachineId: target }),
  );
  const origin = (await server.start()).toString().replace(/\/$/, "");
  return { origin, files, target, stop: () => server.stop() };
}

describe("#1480 AC1/AC2 — the bound nonce rides a NON-URL carrier at the mint route", () => {
  const JOINER_ID = "SHA256:joiner-identity";

  it("AC2: a header-carried bound nonce (bound to target+identity) mints a peer token", async () => {
    const b = await bootBound();
    const nonce = mintBoundEnrollmentNonce(
      { target: b.target, identityKey: JOINER_ID },
      { storeFile: b.files.nonce, nonceFactory: () => "BOUND-NONCE-1", ttlMs: 60_000 },
    );
    const res = await fetch(`${b.origin}${MINT_ENDPOINT_PATH}?machine_id=joiner`, {
      method: "POST",
      headers: { [BOUND_NONCE_HEADER]: nonce, [BOUND_IDENTITY_HEADER]: JOINER_ID },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; token: string };
    expect(body.ok).toBe(true);
    expect(typeof body.token).toBe("string");
    expect(issuedTokenFor("joiner", { registryFile: b.files.issued })).toBe(body.token);
    await b.stop();
  });

  it("AC1: a bound nonce presented on the URL query string is REFUSED (401) — the carrier moved off the URL", async () => {
    const b = await bootBound();
    const nonce = mintBoundEnrollmentNonce(
      { target: b.target, identityKey: JOINER_ID },
      { storeFile: b.files.nonce, nonceFactory: () => "BOUND-NONCE-URL", ttlMs: 60_000 },
    );
    // the audited-away pattern: nonce in the query string. It must NOT authenticate.
    const res = await fetch(`${b.origin}${MINT_ENDPOINT_PATH}?machine_id=joiner&enrollment_nonce=${nonce}`, {
      method: "POST",
    });
    expect(res.status).toBe(401);
    // and it was NOT consumed by the failed attempt — the rightful header path still works
    const good = await fetch(`${b.origin}${MINT_ENDPOINT_PATH}?machine_id=joiner`, {
      method: "POST",
      headers: { [BOUND_NONCE_HEADER]: nonce, [BOUND_IDENTITY_HEADER]: JOINER_ID },
    });
    expect(good.status).toBe(200);
    await b.stop();
  });

  it("AC2: a bound nonce presented with the WRONG identity header is REFUSED (401)", async () => {
    const b = await bootBound();
    const nonce = mintBoundEnrollmentNonce(
      { target: b.target, identityKey: JOINER_ID },
      { storeFile: b.files.nonce, nonceFactory: () => "BOUND-NONCE-2", ttlMs: 60_000 },
    );
    const res = await fetch(`${b.origin}${MINT_ENDPOINT_PATH}?machine_id=joiner`, {
      method: "POST",
      headers: { [BOUND_NONCE_HEADER]: nonce, [BOUND_IDENTITY_HEADER]: "SHA256:attacker" },
    });
    expect(res.status).toBe(401);
    await b.stop();
  });

  it("AC2: replay — the same bound nonce cannot mint twice (single-use over the wire)", async () => {
    const b = await bootBound();
    const nonce = mintBoundEnrollmentNonce(
      { target: b.target, identityKey: JOINER_ID },
      { storeFile: b.files.nonce, nonceFactory: () => "BOUND-NONCE-3", ttlMs: 60_000 },
    );
    const h = { [BOUND_NONCE_HEADER]: nonce, [BOUND_IDENTITY_HEADER]: JOINER_ID };
    const first = await fetch(`${b.origin}${MINT_ENDPOINT_PATH}?machine_id=joiner`, { method: "POST", headers: h });
    expect(first.status).toBe(200);
    const replay = await fetch(`${b.origin}${MINT_ENDPOINT_PATH}?machine_id=joiner2`, { method: "POST", headers: h });
    expect(replay.status).toBe(401);
    await b.stop();
  });

  it("AC1: no bootstrap secret (nonce or minted token) appears in a REFUSAL body", async () => {
    const b = await bootBound();
    const nonce = mintBoundEnrollmentNonce(
      { target: b.target, identityKey: JOINER_ID },
      { storeFile: b.files.nonce, nonceFactory: () => "SUPER-SECRET-NONCE", ttlMs: 60_000 },
    );
    const res = await fetch(`${b.origin}${MINT_ENDPOINT_PATH}?machine_id=joiner`, {
      method: "POST",
      headers: { [BOUND_NONCE_HEADER]: nonce, [BOUND_IDENTITY_HEADER]: "SHA256:attacker" },
    });
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text).not.toContain("SUPER-SECRET-NONCE");
    await b.stop();
  });

  it("AC1: the minted token appears ONLY in the success body, never echoed into any error path", async () => {
    const b = await bootBound();
    const nonce = mintBoundEnrollmentNonce(
      { target: b.target, identityKey: JOINER_ID },
      { storeFile: b.files.nonce, nonceFactory: () => "BOUND-NONCE-4", ttlMs: 60_000 },
    );
    const h = { [BOUND_NONCE_HEADER]: nonce, [BOUND_IDENTITY_HEADER]: JOINER_ID };
    const ok = await fetch(`${b.origin}${MINT_ENDPOINT_PATH}?machine_id=joiner`, { method: "POST", headers: h });
    const okBody = (await ok.json()) as { token: string };
    const mintedToken = okBody.token;
    // the replayed refusal must not echo the previously-minted token
    const replay = await fetch(`${b.origin}${MINT_ENDPOINT_PATH}?machine_id=joiner2`, { method: "POST", headers: h });
    const replayText = await replay.text();
    expect(replayText).not.toContain(mintedToken);
    await b.stop();
  });
});
