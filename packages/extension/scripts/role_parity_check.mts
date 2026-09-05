#!/usr/bin/env node
// Role-card parity pin check CLI (amicode#806, obligation O8 — the
// pin-behind-HEAD check that rides the doctor's fleet cadence on the
// vault-visible machine). Deterministic, no LLM: verdicts derive from git
// revisions and content digests, never prose.
//
//   node scripts/role_parity_check.mts --pin <pin.json> --vault <repo-path>
//                                       [--ref <gitish, default origin/main]
//
// What it checks (the pin record is test/fixtures/vault-agents/pin.json —
// the engine-neutral role definitions the parity suite pinned, at the
// amicissimo vault revision it pinned):
//
//   1. FIXTURE INTEGRITY — every fixture the pin names is present and
//      byte-matches its recorded digest (the committed pin is self-contained).
//   2. PIN GENUINENESS — the pinned revision exists in the vault repo, and
//      the bytes of each pinned definition AT that revision match the
//      recorded digest (the pin points at real history, never an invented
//      revision).
//   3. PIN FRESHNESS — no pinned definition changed between the pinned
//      revision and the vault's current ref (default origin/main, falling
//      back to HEAD). Revision churn elsewhere in the vault is NOT drift of
//      this pin: only the pinned files moving past the pin is (low-noise
//      by design — the nightly cadence must not file a chore issue for
//      every vault commit).
//
// Exit codes (the contract, one table):
//   0  current — or an honest named non-verdict: vault absent/unprobeable
//      (recorded in the report; a pin is only loud if something can run)
//   1  drift or integrity failure — a pinned file changed past the pin
//      (behind-head), a fixture no longer matches its record, or the pinned
//      revision is orphaned from the vault history (the cadence files its
//      chore issue on exactly this exit line)
//   2  usage / pre-flight — bad arguments or an unreadable pin record (a
//      broken pin record is a pre-flight error, never a skippable surface)
//
// Report: one JSON object on stdout — {status, pinned_revision,
// vault_revision, drifted_files, evidence[]}.

import { readFileSync, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, resolve } from "node:path";

type Status =
  | "current"
  | "behind-head"
  | "fixture-mismatch"
  | "pin-orphaned"
  | "vault-absent"
  | "vault-unprobeable";

interface PinRecord {
  record_version: number;
  vault_repo: string;
  vault_revision: string;
  pinned: Array<{ role_card: string; vault_path: string; fixture: string; sha256: string }>;
  no_counterpart?: Array<{ role_card: string }>;
}

interface Report {
  status: Status;
  pinned_revision: string | null;
  vault_revision: string | null;
  drifted_files: string[];
  evidence: string[];
}

const EXIT = { ok: 0, drift: 1, usage: 2 } as const;

function usage(msg: string): never {
  process.stderr.write(`role-parity-check: ${msg}\n`);
  process.stderr.write(
    "usage: node scripts/role_parity_check.mts --pin <pin.json> --vault <repo> [--ref <gitish>]\n",
  );
  process.exit(EXIT.usage);
}

// ── args ─────────────────────────────────────────────────────────────────────
let pinPath: string | null = null;
let vaultPath: string | null = null;
let ref = "origin/main";
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]!;
  if (a === "--pin") pinPath = process.argv[++i] ?? usage("--pin requires a path");
  else if (a === "--vault") vaultPath = process.argv[++i] ?? usage("--vault requires a path");
  else if (a === "--ref") ref = process.argv[++i] ?? usage("--ref requires a gitish");
  else usage(`unknown argument: ${a}`);
}
if (pinPath === null) usage("--pin is required");
if (vaultPath === null) usage("--vault is required (pass the vault repo path; the cadence owns its default)");

const sha256 = (buf: Buffer | string): string => "sha256:" + createHash("sha256").update(buf).digest("hex");

function git(repo: string, args: string[]): { code: number; stdout: string; stderr: string } {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", timeout: 30_000 });
  return { code: r.status ?? -1, stdout: String(r.stdout ?? ""), stderr: String(r.stderr ?? "") };
}

const report = (status: Status, evidence: string[], extra: Partial<Report> = {}): never => {
  const out: Report = {
    status,
    pinned_revision: pin.vault_revision,
    vault_revision: null,
    drifted_files: [],
    evidence,
    ...extra,
  };
  process.stdout.write(JSON.stringify(out) + "\n");
  // drift OR integrity failure → 1; current and the honest named
  // non-verdicts (absent/unprobeable vault) → 0
  process.exit(
    status === "behind-head" || status === "fixture-mismatch" || status === "pin-orphaned"
      ? EXIT.drift
      : EXIT.ok,
  );
};

// ── 1. the pin record (pre-flight: a broken record is never skippable) ──────
if (!existsSync(pinPath)) usage(`pin record not found: ${pinPath}`);
let pin: PinRecord;
try {
  pin = JSON.parse(readFileSync(pinPath, "utf8")) as PinRecord;
} catch (e) {
  usage(`pin record unparseable: ${(e as Error).message}`);
}
if (pin.record_version !== 1 || typeof pin.vault_revision !== "string" || !Array.isArray(pin.pinned) || pin.pinned.length === 0) {
  usage("pin record malformed: record_version must be 1, with vault_revision and a non-empty pinned set");
}

// ── 2. fixture integrity (self-contained: the committed fixtures vs the record)
const pinDir = dirname(resolve(pinPath));
const evidence: string[] = [];
for (const p of pin.pinned) {
  const fixturePath = isAbsolute(p.fixture) ? p.fixture : join(pinDir, p.fixture);
  if (!existsSync(fixturePath) || !statSync(fixturePath).isFile()) {
    report("fixture-mismatch", [`pinned fixture missing: ${p.fixture} (for role card ${p.role_card})`], {
      pinned_revision: pin.vault_revision,
    });
  }
  const actual = sha256(readFileSync(fixturePath));
  if (actual !== p.sha256) {
    evidence.push(`fixture ${p.fixture} (role card ${p.role_card}) drifted from its recorded digest (${actual.slice(0, 19)} ≠ ${p.sha256.slice(0, 19)})`);
  } else {
    evidence.push(`fixture ${p.fixture} byte-matches its recorded digest`);
  }
}
if (evidence.some((e) => e.includes("drifted from its recorded digest"))) {
  report("fixture-mismatch", evidence, { pinned_revision: pin.vault_revision });
}

// ── 3. the vault repo (absent/unprobeable are honest named non-verdicts) ─────
if (!existsSync(vaultPath)) {
  report("vault-absent", [
    ...evidence,
    `vault checkout absent at ${vaultPath} — the pin cannot be checked on this machine; the fixtures remain the self-contained pin`,
  ], {
    pinned_revision: pin.vault_revision,
  });
}
const revParse = git(vaultPath, ["rev-parse", "--verify", "HEAD"]);
if (revParse.code !== 0) {
  report("vault-unprobeable", [`vault repo unprobeable at ${vaultPath}: git rev-parse HEAD failed (${revParse.stderr.trim()})`], {
    pinned_revision: pin.vault_revision,
  });
}

// the comparison ref: origin/main, falling back to HEAD when there is no
// origin (a fixture repo) — recorded, never silent.
let vaultRevision: string;
const refParse = git(vaultPath, ["rev-parse", "--verify", `${ref}^{commit}`]);
if (refParse.code === 0) {
  vaultRevision = refParse.stdout.trim();
  evidence.push(`vault ref ${ref} → ${vaultRevision}`);
} else {
  const headParse = git(vaultPath, ["rev-parse", "--verify", "HEAD"]);
  vaultRevision = headParse.stdout.trim();
  evidence.push(`vault ref ${ref} unresolvable (${refParse.stderr.trim()}) — comparing against local HEAD ${vaultRevision}`);
}

// ── 4. pin genuineness — the pinned revision is real history carrying the bytes
const pinExists = git(vaultPath, ["cat-file", "-e", `${pin.vault_revision}^{commit}`]);
if (pinExists.code !== 0) {
  report("pin-orphaned", [`pinned revision ${pin.vault_revision} is absent from the vault repo's history (rewritten or never fetched) — the pin no longer points at real history`], {
    vault_revision: vaultRevision,
  });
}
for (const p of pin.pinned) {
  const show = git(vaultPath, ["show", `${pin.vault_revision}:${p.vault_path}`]);
  if (show.code !== 0) {
    report("pin-orphaned", [`pinned revision ${pin.vault_revision} does not carry ${p.vault_path} — the pin record and the vault history disagree`], {
      vault_revision: vaultRevision,
    });
  }
  const atPin = sha256(show.stdout);
  if (atPin !== p.sha256) {
    report("fixture-mismatch", [
      ...evidence,
      `${p.vault_path} at the pinned revision ${pin.vault_revision.slice(0, 12)} does not match the recorded digest (${atPin.slice(0, 19)} ≠ ${p.sha256.slice(0, 19)}) — the pin was not taken from these bytes`,
    ], { vault_revision: vaultRevision });
  }
  evidence.push(`${p.vault_path} at the pinned revision byte-matches the recorded digest`);
}

// ── 5. pin freshness — did any pinned definition move past the pin? ─────────
const vaultPaths = pin.pinned.map((p) => p.vault_path);
const diff = git(vaultPath, ["diff", "--name-only", `${pin.vault_revision}..${vaultRevision}`, "--", ...vaultPaths]);
if (diff.code !== 0) {
  report("vault-unprobeable", [`git diff ${pin.vault_revision.slice(0, 12)}..${vaultRevision} failed (${diff.stderr.trim()})`], {
    vault_revision: vaultRevision,
  });
}
const drifted = diff.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
if (drifted.length > 0) {
  report("behind-head", [
    ...evidence,
    ...drifted.map((f) => `pinned definition ${f} changed past the pinned revision ${pin.vault_revision.slice(0, 12)} — the parity fixtures are behind the vault`),
  ], { vault_revision: vaultRevision, drifted_files: drifted });
}
report("current", [...evidence, vaultRevision === pin.vault_revision
  ? `the vault ref is exactly the pinned revision ${pin.vault_revision.slice(0, 12)} — the pin is current`
  : `the vault ref moved to ${vaultRevision.slice(0, 12)} but no pinned definition changed — the pinned CONTENT is still current (re-pin at convenience, no drift)`], {
  vault_revision: vaultRevision,
});
