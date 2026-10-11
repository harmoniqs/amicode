// `amico claims lifecycle` (amicode #1684, brain flywheel slice 5): the nightly
// pass's CLI surface — dedupe-merge + status transitions + the decay review
// queue, dry-run by default (the claims verb's doctrine), --apply writes.
// Hermetic: the committed lifecycle-registry fixture copied into temp dirs and
// a fake personal mount — never the live vault.
//
// Run: `pnpm --filter @amicode/amico-run test lifecycle_verb`
import { describe, it, expect } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { claimsVerb } from "../src/claims_verb.js";
import { SPINE_VERBS } from "../src/verbs.js";
import { parseClaimNote } from "../src/claims.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures", "claims");
const LIFECYCLE_REGISTRY = join(FIXTURES, "lifecycle-registry");
const NOON = () => new Date("2026-10-02T12:00:00.000Z");

/** A temp copy of the committed lifecycle registry — apply-path tests never
 *  touch the fixture of record. The registry gets its OWN parent dir so the
 *  queue file's default home (dirname of the registry) is per-test, never a
 *  shared /tmp artifact. */
function tempRegistry(): string {
  const parent = mkdtempSync(join(tmpdir(), "claims-lc-"));
  const dir = join(parent, "claims");
  cpSync(LIFECYCLE_REGISTRY, dir, { recursive: true });
  return dir;
}

/** A signals JSONL file in a temp dir. */
function signalsFile(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "claims-signals-"));
  const file = join(dir, "contradictions.jsonl");
  writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

const REFUTE_SMOOTH = JSON.stringify({
  claim: "insight_smooth_pulses.md",
  run: "r20260930-050350Z-51c7",
  note: "re-solve reproduced the same fidelity with control-only warm-start",
});

describe("amico claims lifecycle — usage + the never-a-guess refusals", () => {
  it("usage: no/unknown subcommand handled by the verb; unknown flag → 64", async () => {
    expect((await claimsVerb([], {})).code).toBe(64);
    expect((await claimsVerb(["lifecycle", "--bogus"], {})).code).toBe(64);
  });

  it("missing registry / no mount → 64, never a guess; bad numeric flags → 64", async () => {
    const missing = await claimsVerb(["lifecycle", "--registry", join(tmpdir(), "definitely-absent-registry")], {});
    expect(missing.code).toBe(64);
    expect((missing.json as { error: string }).error).toContain("claims registry not found");

    const bare = mkdtempSync(join(tmpdir(), "claims-bare-")); // no mount resolves
    const noMount = await claimsVerb(["lifecycle"], { AMICO_VAULTS_ROOT: bare });
    expect(noMount.code).toBe(64);
    expect((noMount.json as { error: string }).error).toContain("--registry");

    const reg = tempRegistry();
    for (const bad of [["--corroborate-threshold", "0"], ["--corroborate-threshold", "x"], ["--decay-days", "0"], ["--merge-threshold", "1.5"], ["--merge-threshold", "0"]]) {
      const r = await claimsVerb(["lifecycle", "--registry", reg, ...bad], {});
      expect(r.code, String(bad)).toBe(64);
    }

    const noSignalsFile = await claimsVerb(["lifecycle", "--registry", reg, "--signals", join(reg, "no-such-signals.jsonl")], {});
    expect(noSignalsFile.code).toBe(64);
    expect((noSignalsFile.json as { error: string }).error).toContain("--signals");
  });

  it("is registered as a spine verb with lifecycle in its summary", () => {
    const claims = SPINE_VERBS.find((v) => v.name === "claims");
    expect(claims, "the claims verb is registered").toBeDefined();
    expect(claims!.summary).toContain("lifecycle");
  });
});

describe("amico claims lifecycle — the dry-run pass (writes NOTHING)", () => {
  it("reports the fixture registry's full night: 1 merge, 1 corroboration, 1 decay proposal", async () => {
    const reg = tempRegistry();
    const r = await claimsVerb(["lifecycle", "--registry", reg], {}, { now: NOON });
    expect(r.code).toBe(0);
    const j = r.json as Record<string, unknown>;
    expect(j.dry_run).toBe(true);
    expect(j.ok).toBe(true);
    expect(j.scanned).toBe(6);
    expect((j.merges as { survivor: string; duplicate: string }[]).map((m) => `${m.survivor} <- ${m.duplicate}`)).toEqual([
      "insight_two_qubit_challenge.md <- insight_two_qubit_harder.md",
    ]);
    expect((j.transitions as { file: string; kind: string }[]).map((t) => `${t.file}:${t.kind}`)).toEqual([
      "insight_warm_starts.md:corroborate",
    ]);
    expect((j.queue as { file: string }[]).map((q) => q.file)).toEqual(["best_practice_pin_globals.md"]);
    expect((j.findings as unknown[])).toEqual([]);
    // wrote NOTHING: no archive, no queue file, registry bytes untouched
    expect(existsSync(join(reg, "archive"))).toBe(false);
    expect(existsSync(join(reg, "..", "review-queue.md"))).toBe(false);
    expect(readFileSync(join(reg, "insight_two_qubit_harder.md"), "utf8")).toBe(readFileSync(join(LIFECYCLE_REGISTRY, "insight_two_qubit_harder.md"), "utf8"));
  });

  it("carries the refutation from a --signals file and names malformed lines as findings (exit 1, never silent)", async () => {
    const reg = tempRegistry();
    const signals = signalsFile([REFUTE_SMOOTH, "definitely not json"]);
    const r = await claimsVerb(["lifecycle", "--registry", reg, "--signals", signals], {}, { now: NOON });
    expect(r.code).toBe(1); // the malformed line screams
    const j = r.json as Record<string, unknown>;
    expect(j.dry_run).toBe(true);
    expect((j.findings as string[]).some((f) => f.includes("not json"))).toBe(true);
    expect((j.transitions as { file: string; kind: string }[]).some((t) => t.file === "insight_smooth_pulses.md" && t.kind === "refute")).toBe(true);
    expect(existsSync(join(reg, "insight_smooth_pulses.md"))).toBe(true); // dry-run wrote nothing
  });
});

describe("amico claims lifecycle --apply — the nightly write path", () => {
  it("merges (survivor rewritten, duplicate archived), stamps transitions, and writes the queue at its default home", async () => {
    const reg = tempRegistry();
    const signals = signalsFile([REFUTE_SMOOTH]);
    const r = await claimsVerb(["lifecycle", "--registry", reg, "--signals", signals, "--apply"], {}, { now: NOON });
    expect(r.code).toBe(0);
    const j = r.json as Record<string, unknown>;
    expect(j.dry_run).toBe(false);

    // the merge: the survivor note's frontmatter IS the merged claim; its body is preserved verbatim
    const survivorRaw = readFileSync(join(reg, "insight_two_qubit_challenge.md"), "utf8");
    const survivor = parseClaimNote(survivorRaw);
    expect(survivor.ok).toBe(true);
    if (survivor.ok) {
      expect(survivor.claim.evidence).toEqual(["memory-card/project_two_qubit_challenge.md", "memory-card/reference_rho_policy.md"]);
      expect(survivor.claim.applied).toBe(1);
      expect(survivor.claim.status).toBe("unverified");
      expect((survivor.claim.history as { event: string }[]).map((h) => h.event)).toEqual(["created", "created", "merged"]);
    }
    expect(survivorRaw).toContain("the dedupe pass must keep THIS claim's identity"); // body preserved

    // the duplicate: GONE from the registry proper, ARCHIVED beside it (never deleted outright)
    expect(existsSync(join(reg, "insight_two_qubit_harder.md"))).toBe(false);
    expect(existsSync(join(reg, "archive", "insight_two_qubit_harder.md"))).toBe(true);

    // the corroboration: stamped in the note, history appended
    const warm = parseClaimNote(readFileSync(join(reg, "insight_warm_starts.md"), "utf8"));
    expect(warm.ok).toBe(true);
    if (warm.ok) {
      expect(warm.claim.status).toBe("corroborated");
      expect((warm.claim.history as { event: string }[]).at(-1)!.event).toBe("corroborated");
    }

    // the refutation: the contradicted-by-run trail is IN the note
    const smooth = parseClaimNote(readFileSync(join(reg, "insight_smooth_pulses.md"), "utf8"));
    expect(smooth.ok).toBe(true);
    if (smooth.ok) {
      expect(smooth.claim.status).toBe("refuted");
      const last = (smooth.claim.history as { event: string; note: string }[]).at(-1)!;
      expect(last.event).toBe("refuted");
      expect(last.note).toContain("r20260930-050350Z-51c7");
    }

    // the decay queue: the proposal surface lands NEXT TO the registry (out of the lint's scan)
    const queuePath = join(dirname(reg), "review-queue.md");
    expect(j.queue_file).toBe(queuePath);
    expect(existsSync(queuePath)).toBe(true);
    const queueText = readFileSync(queuePath, "utf8");
    expect(queueText).toContain("best_practice_pin_globals.md");
    expect(queueText).toContain("never deletes");
  });

  it("IDEMPOTENT at a fixed clock: the second --apply night merges and stamps nothing; the queue is byte-stable", async () => {
    const reg = tempRegistry();
    const signals = signalsFile([REFUTE_SMOOTH]);
    const first = await claimsVerb(["lifecycle", "--registry", reg, "--signals", signals, "--apply"], {}, { now: NOON });
    expect(first.code).toBe(0);
    const queuePath = join(dirname(reg), "review-queue.md");
    const queueBytes = readFileSync(queuePath, "utf8");
    const survivorBytes = readFileSync(join(reg, "insight_two_qubit_challenge.md"), "utf8");

    const second = await claimsVerb(["lifecycle", "--registry", reg, "--signals", signals, "--apply"], {}, { now: NOON });
    expect(second.code).toBe(1); // the refute signal now names an already-refuted claim — named finding, not silent
    const j2 = second.json as Record<string, unknown>;
    expect(j2.merges).toEqual([]);
    expect(j2.transitions).toEqual([]);
    expect(readFileSync(join(reg, "insight_two_qubit_challenge.md"), "utf8")).toBe(survivorBytes); // untouched
    expect(readFileSync(queuePath, "utf8")).toBe(queueBytes); // deterministic render
    expect((j2.findings as string[]).some((f) => f.includes("insight_smooth_pulses.md") && f.includes("refuted"))).toBe(true);
  });

  it("defaults --registry to the personal mount and writes the queue into the mount's amicode/ subtree", async () => {
    const root = mkdtempSync(join(tmpdir(), "claims-vault-"));
    const mount = join(root, "vault-aaron");
    mkdirSync(join(mount, "amicode", "claims"), { recursive: true });
    cpSync(LIFECYCLE_REGISTRY, join(mount, "amicode", "claims"), { recursive: true });
    writeFileSync(join(mount, ".amico-vault.toml"), 'kind = "personal"\nname = "vault-aaron"\n');

    const r = await claimsVerb(["lifecycle", "--apply"], { AMICO_VAULTS_ROOT: root }, { now: NOON });
    expect(r.code).toBe(0);
    expect(existsSync(join(mount, "amicode", "claims", "archive", "insight_two_qubit_harder.md"))).toBe(true);
    expect(existsSync(join(mount, "amicode", "review-queue.md"))).toBe(true);
  });
});
