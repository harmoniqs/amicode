// curation_verb.ts — `amico claims promote / prune / synthesize` (amicode
// #1685, brain flywheel slice 6 — the three weekly curation jobs, the dream
// cycle employed): the promote proposal bundle, the prune schema-check +
// hygiene apply, and the synthesize hopper proposals, each on the notturno
// receipt chassis (the distill precedent).
//
// THE RECEIPT: with `--jobs <registry>` (+ `--dashboards`), every apply run
// files (or honestly skips) a scheduled-passes.md record through the
// notturno_passes writer — job ids `promote` / `prune` / `synthesize`, counts
// in the outcome, duration, artifacts. The chassis gates apply verbatim on
// every path: the instance deny-list first (org config never runs through
// this public verb — it fires BEFORE any body work), then the registry
// membership check (an unknown job id is exit 2), then the record mode
// (`acted` jobs self-filter when the pass did nothing). Without `--jobs` the
// body still runs and the receipt is honestly not filed (a private instance
// composes its own receipt through its own runner).
//
// MODES (the claims doctrine): dry-run by default (report-only: no writes, no
// receipt); `--apply` writes. Dry/apply are explicit in the JSON.
//
// TRUST BOUNDARIES (the issue's Key Decisions):
//   - promote PROPOSES: the bundle (PR body + verbatim claim copies) is an
//     artifact a HUMAN merges; this verb has no git, no gh, no network —
//     auto-merge is structurally impossible, and a bundle that already
//     exists is never clobbered (it is the audit artifact).
//   - prune applies only the unambiguous fixes (frontmatter swapped, prose
//     verbatim — the machinery-never-edits-prose doctrine); every lint
//     finding is drift a human owns and exits 1.
//   - synthesize writes ONLY hopper notes; it has no code path that touches
//     a strategy file (human-fed sections are human-fed by design).
//
// ONE SUBSTRATE: the registry is read; the vault (evidence resolution) and
// chat DB are opened READ-ONLY via the lint; this verb writes only the
// bundle, the state stamp, the registry's fixed frontmatter, hopper notes,
// and the receipt journal — never the substrate.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { loadRegistryClaims, lintClaimsRegistry, checkPublicSafety, type RegistryClaim } from "./claims.js";
import { rewriteClaimNote } from "./lifecycle.js";
import {
  PROMOTE_JOB,
  PRUNE_JOB,
  SYNTHESIZE_JOB,
  planPromotion,
  readPromoteState,
  writePromoteState,
  stampPromoted,
  promoteBundleId,
  renderPrBody,
  renderPromotionCopy,
  renderPublicIndex,
  planPrune,
  renderPruneDiff,
  detectPatterns,
  hopperSlug,
  renderHopperNote,
} from "./curation.js";
import { personalMount, resolveMountStack, readVaultMarker, type Mount } from "./mounts.js";
import { deniedBy, discoverDenyList, loadDenyList, loadRegistry } from "./notturno_registry.js";
import { appendSection, renderPass } from "./notturno_passes.js";
import { amicodeOpsDir } from "./session_retention.js";
import type { VerbResult } from "./verbs.js";

const USAGE = [
  "amico claims promote [--registry <dir>] [--state <p>] [--out <bundles dir>] [--from <vault>]",
  "                     [--tier <team|public>] [--to <mount>] [--vault <root>]",
  "                     [--apply] [--jobs <notturno.toml>] [--dashboards <dir|file>] [--deny-list <p>]",
  "amico claims prune [--registry <dir>] [--vault <root>] [--db <chat.db>]",
  "                   [--apply] [--jobs <notturno.toml>] [--dashboards <dir|file>] [--deny-list <p>]",
  "amico claims synthesize [--registry <dir>] [--hopper <dir>]",
  "                        [--apply] [--jobs <notturno.toml>] [--dashboards <dir|file>] [--deny-list <p>]",
  "",
  "  promote — the weekly proposal bundle: scope-team live claims → ONE PR body +",
  "  copies per vault, capped at 10 (overflow carries). PROPOSES ONLY — a human",
  "  merges; the verb never opens a PR. Dry-run by default; --apply writes the",
  "  bundle + the promote state stamp + the pass receipt. --tier public (#1688)",
  "  targets the kind: public mount with the SAME machinery: the pool is",
  "  scope-public claims, the two-note visibility split is checked at promotion",
  "  time (private-mechanism evidence / mechanism links refuse BY NAME), and the",
  "  bundle adds INDEX.md, the public vault's generated claims index.",
  "  prune — the weekly schema-check + hygiene pass (the retired /dream prune:",
  "  the dream-prune semantics on the claim layer). The claims lint's findings are",
  "  DRIFT (flagged, exit 1); only unambiguous frontmatter fixes are applied.",
  "  synthesize — the weekly pattern pass: cross-claim tag clusters (3+ data",
  "  points) → hopper proposals. Proposes to the hopper only, never to",
  "  strategy. The retired /dream synthesize's destination, on cadence.",
  "",
  "  --jobs names the Notturno job registry (receipt filing; the env fallback is",
  "  AMICO_NOTTURNO_REGISTRY). A deny-listed registry is refused loudly (64) —",
  "  org config runs through the private instance's runner, never this verb.",
].join("\n");

function fail(error: string, extra: Record<string, unknown> = {}): VerbResult {
  return { json: { verb: "claims", error, usage: USAGE, ...extra }, code: 64 };
}

// ── the shared chassis ─────────────────────────────────────────────────────────

/** The personal mount for this invocation (env seam, hermetic tests). */
function mount(env: NodeJS.ProcessEnv): Mount | undefined {
  return personalMount(resolveMountStack(env.AMICO_VAULTS_ROOT, env.AMICO_MOUNTS_TOML));
}

/** Parse flags: valued flags take a value; --apply is the lone boolean. */
function parseArgs(
  rest: string[],
  valued: string[],
): { flags: Map<string, string>; apply: boolean; error?: string } {
  const flags = new Map<string, string>();
  let apply = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--apply") {
      apply = true;
      continue;
    }
    if (!valued.includes(a)) return { flags, apply, error: `unknown flag "${a}"` };
    if (rest[i + 1] === undefined) return { flags, apply, error: `flag "${a}" needs a value` };
    flags.set(a, rest[i + 1]!);
    i++;
  }
  return { flags, apply };
}

/** The claims registry: --registry, else the personal mount's amicode/claims.
 *  Never a guess — no mount and no flag is a usage error. */
function claimsRegistry(flags: Map<string, string>, env: NodeJS.ProcessEnv, sub: string): { dir: string } | { error: VerbResult } {
  const m = mount(env);
  const dir = flags.get("--registry") ?? (m !== undefined ? join(m.path, "amicode", "claims") : undefined);
  if (dir === undefined)
    return {
      error: fail(
        `claims ${sub}: no personal vault mount resolved — pass --registry <dir> explicitly (the claims registry is never a guess)`,
      ),
    };
  if (!existsSync(dir))
    return { error: fail(`claims ${sub}: claims registry not found: ${dir} (missing is a typo or nothing projected yet)`) };
  return { dir };
}

/** The notturno job registry: --jobs, else AMICO_NOTTURNO_REGISTRY, else none
 *  (the receipt is honestly not filed). */
function jobsRegistryPath(flags: Map<string, string>, env: NodeJS.ProcessEnv): string | undefined {
  const flag = flags.get("--jobs");
  if (flag !== undefined && flag !== "") return flag;
  const e = env.AMICO_NOTTURNO_REGISTRY;
  return e && e !== "" ? e : undefined;
}

/** The chassis gate shared by the receipt path: the deny gate (org config is
 *  never read, never run) + the dashboards-pairing check. Fires BEFORE any
 *  body work — the distill ordering. */
function jobsGate(
  flags: Map<string, string>,
  env: NodeJS.ProcessEnv,
  sub: string,
): { jobs?: string; dashboards?: string } | { error: VerbResult } {
  const jobs = jobsRegistryPath(flags, env);
  if (jobs === undefined) return {};
  const dashboards = flags.get("--dashboards");
  if (dashboards === undefined)
    return { error: fail(`claims ${sub}: the pass receipt needs its journal: --jobs requires --dashboards <dir|file>`) };
  const manifest = flags.get("--deny-list") ?? discoverDenyList(jobs);
  if (manifest !== undefined) {
    const loaded = loadDenyList(manifest);
    if (!loaded.ok) return { error: { json: { verb: "claims", subcommand: sub, ok: false, error: loaded.error }, code: 2 } };
    const row = deniedBy(jobs, loaded.deny);
    if (row !== undefined)
      return {
        error: {
          json: {
            verb: "claims",
            subcommand: sub,
            ok: false,
            error: "registry is instance config — denied by the instance deny list",
            jobs,
            deny: row,
            hint: "this registry is deny-listed instance data — run the curation jobs through the private instance's runner (automation/notturno) in the amicissimo checkout; the public amico CLI never runs org config",
          },
          code: 64,
        },
      };
  }
  return { jobs, dashboards };
}

/** The receipt step every apply path shares (the distillReceipt shape): no
 *  registry → honestly not filed; else membership (unknown job = 2), the
 *  record-mode self-filter, then the append. */
function jobReceipt(opts: {
  sub: string;
  jobId: string;
  jobs: string | undefined;
  dashboards: string | undefined;
  actions: number;
  outcome: string;
  artifacts: string[];
  durationMs: number;
  now: Date;
}): { receipt: Record<string, unknown> } | { error: VerbResult } {
  if (opts.jobs === undefined)
    return {
      receipt: {
        filed: false,
        reason:
          "no --jobs registry (pass --jobs <p> or set AMICO_NOTTURNO_REGISTRY; a private instance composes its own receipt through its own runner)",
      },
    };
  const loaded = loadRegistry(opts.jobs);
  if (!loaded.ok)
    return { error: { json: { verb: "claims", subcommand: opts.sub, ok: false, error: loaded.error }, code: 2 } };
  const job = loaded.registry.jobs.find((j) => j.id === opts.jobId);
  if (job === undefined)
    return {
      error: {
        json: {
          verb: "claims",
          subcommand: opts.sub,
          ok: false,
          error: `passes: unknown job '${opts.jobId}' — not in the Notturno registry`,
          jobs: opts.jobs,
        },
        code: 2,
      },
    };
  if (job.record === "acted" && opts.actions === 0)
    return { receipt: { filed: false, skipped: true, reason: `passes: ${job.id} records on action only; no action this run — skipped` } };
  const target = appendSection(
    opts.dashboards!,
    renderPass({
      job: job.id,
      status: "ok",
      outcome: opts.outcome,
      duration_s: Math.round(opts.durationMs / 1000),
      artifacts: opts.artifacts,
      when: opts.now,
    }),
  );
  return { receipt: { filed: true, job: job.id, target } };
}

// ── claims promote — AC 1 (one PR per vault, the 10-cap, never auto-merged) ────
// The public tier (#1688, slice 9) rides this SAME machinery — no second
// promotion path: `--tier public` swaps the pool to scope-public claims and
// the destination to the kind: public mount (resolved by the mount-stack
// conventions, marker-verified, never guessed — `--to` overrides and is
// itself marker-verified), CHECKS the two-note visibility split at promotion
// time (checkPublicSafety — every ELIGIBLE claim before the cap, so a
// refusal never burns a bundle slot; refusals are named, unstamped, in the
// pool until a human fixes the split), and adds the bundle's third artifact:
// INDEX.md, the public vault's index generated from the bundle's claims.

export function promoteSub(rest: string[], env: NodeJS.ProcessEnv, now: () => Date): VerbResult {
  const startedAt = Date.now();
  const { flags, apply, error } = parseArgs(rest, [
    "--registry",
    "--state",
    "--out",
    "--from",
    "--jobs",
    "--dashboards",
    "--deny-list",
    "--tier",
    "--to",
    "--vault",
  ]);
  if (error !== undefined) return fail(error);
  const tier = flags.get("--tier") ?? "team";
  if (tier !== "team" && tier !== "public")
    return fail(`--tier must be "team" or "public" (the promotion ladder's two bundle destinations), got "${tier}"`);
  const gated = jobsGate(flags, env, "promote");
  if ("error" in gated) return gated.error;
  const reg = claimsRegistry(flags, env, "promote");
  if ("error" in reg) return reg.error;
  const m = mount(env);
  const sourceVault = flags.get("--from") ?? (m !== undefined ? basename(m.path) : "personal-vault");
  const statePath = flags.get("--state") ?? join(amicodeOpsDir(env), "promote-state.json");
  const bundlesDir = flags.get("--out") ?? join(reg.dir, "promotions");
  const vaultRoot = flags.get("--vault") ?? m?.path;

  // the public tier's destination mount — resolved by the mount-stack
  // conventions (the .amico-vault.toml marker, kind = "public"), never a
  // guess: --to is marker-verified; absent --to, the stack's kind: public
  // mount; neither exists → refuse.
  let target: { name: string; path: string } | undefined;
  if (tier === "public") {
    const explicit = flags.get("--to");
    if (explicit !== undefined) {
      const marker = readVaultMarker(explicit);
      if (marker.kind !== "public")
        return fail(
          `--to must be a public-kind mount (.amico-vault.toml kind = "public") — ${explicit} carries kind ${JSON.stringify(marker.kind) ?? "no marker"}; the target mount is verified by the marker convention, never guessed`,
        );
      target = { name: marker.name ?? basename(explicit), path: explicit };
    } else {
      const pub = resolveMountStack(env.AMICO_VAULTS_ROOT, env.AMICO_MOUNTS_TOML).mounts.find((mm) => mm.kind === "public");
      if (pub === undefined)
        return fail(
          "claims promote --tier public: no public-kind mount resolved in the stack — pass --to <mount> explicitly (the public tier's destination is never a guess)",
        );
      target = { name: pub.name, path: pub.path };
    }
  }

  const { claims, skipped } = loadRegistryClaims(reg.dir);
  const byFile = new Map(claims.map((c) => [c.file, c]));
  const raws = new Map(claims.map((c) => [c.file, readFileSync(join(reg.dir, c.file), "utf8")]));
  let plan = planPromotion(claims, readPromoteState(statePath), { tier });
  // AC 2 (#1688) — the two-note visibility split, CHECKED at promotion time:
  // every ELIGIBLE claim is adjudicated BEFORE the cap (a refusal never burns
  // a bundle slot); a refused claim is named, NOT stamped, and stays in the
  // pool until a human fixes the split.
  const refused: { file: string; refusals: string[] }[] = [];
  if (tier === "public") {
    const safe: RegistryClaim[] = [];
    for (const file of plan.eligible) {
      const entry = byFile.get(file)!;
      const check = checkPublicSafety(raws.get(file)!, entry.claim, { vaultRoot });
      if (check.ok) safe.push(entry);
      else refused.push({ file, refusals: check.refusals });
    }
    plan = planPromotion(safe, readPromoteState(statePath), { tier });
  }
  const bundleId = promoteBundleId(now());
  const bundleDir = join(bundlesDir, bundleId);
  const prBody = renderPrBody(plan, claims, {
    sourceVault,
    bundleId,
    now: now(),
    tier,
    destination: target?.name,
    targetPath: target?.path,
    refusals: refused.map((r) => `${r.file}: ${r.refusals.join("; ")}`),
  });
  const index =
    tier === "public"
      ? renderPublicIndex(
          plan.selected.flatMap((f) => {
            const entry = byFile.get(f);
            return entry === undefined ? [] : [entry];
          }),
          { sourceVault, bundleId, now: now() },
        )
      : undefined;

  const base = {
    verb: "claims",
    ok: true,
    subcommand: "promote",
    dry_run: !apply,
    tier,
    registry: reg.dir,
    state_path: statePath,
    from: sourceVault,
    target,
    bundle: bundleDir,
    selected: plan.selected,
    overflow_carried: plan.overflow,
    excluded: plan.excluded,
    refused,
    skipped_claims: skipped,
    // the trust boundary, stated in every result: this verb proposes only
    proposes_only: true,
    auto_merge: false,
  };

  if (!apply) {
    return {
      json: { ...base, would_write: bundleDir, pr_body: prBody, ...(index !== undefined ? { index } : {}) },
      code: 0,
    };
  }

  if (plan.selected.length === 0) {
    // nothing eligible: an honest no-op run (all proposed, none at the tier's
    // scope — the public tier names its refused claims too: they stay in the pool)
    const receipt = jobReceipt({
      sub: "promote",
      jobId: PROMOTE_JOB,
      jobs: gated.jobs,
      dashboards: gated.dashboards,
      actions: 0,
      outcome:
        tier === "public"
          ? `promote: 0 claims proposed to the public tier (every public-safe scope-public live claim is already proposed, or none exist), ${refused.length} refused by the two-note check (named, in the pool), overflow ${plan.overflow.length} carried`
          : `promote: 0 claims proposed (every scope-team live claim is already proposed, or none exist), overflow ${plan.overflow.length} carried`,
      artifacts: [],
      durationMs: Date.now() - startedAt,
      now: now(),
    });
    if ("error" in receipt) return receipt.error;
    return {
      json: {
        ...base,
        note:
          tier === "public"
            ? `nothing eligible to propose — every public-safe scope-public live claim is already proposed (or none exist); ${refused.length} refused by the two-note check stay in the pool`
            : "nothing eligible — every scope-team live claim is already proposed (or none exist)",
        receipt: receipt.receipt,
      },
      code: 0,
    };
  }

  if (existsSync(bundleDir))
    return fail(`promotion bundle ${bundleDir} already exists — never clobbered (it is the audit artifact a human reviews)`);
  mkdirSync(bundleDir, { recursive: true });
  writeFileSync(join(bundleDir, "PR-BODY.md"), prBody);
  if (index !== undefined) writeFileSync(join(bundleDir, "INDEX.md"), index);
  const copies: string[] = [];
  for (const file of plan.selected) {
    const path = join(bundleDir, file);
    writeFileSync(
      path,
      renderPromotionCopy(raws.get(file)!, { file, sourceVault, bundleId, now: now(), targetVault: target?.name }),
    );
    copies.push(path);
  }
  writePromoteState(statePath, stampPromoted(readPromoteState(statePath), plan.selected, { bundle: bundleId, proposed_at: now().toISOString() }));

  const receipt = jobReceipt({
    sub: "promote",
    jobId: PROMOTE_JOB,
    jobs: gated.jobs,
    dashboards: gated.dashboards,
    actions: plan.selected.length,
    outcome:
      tier === "public"
        ? `promote: ${plan.selected.length} claims proposed to the public tier (bundle ${bundleId}), ${refused.length} refused by the two-note check (named, in the pool), overflow ${plan.overflow.length} carried, excluded ${plan.excluded.length} — PROPOSES only, a human merges`
        : `promote: ${plan.selected.length} claims proposed (bundle ${bundleId}), overflow ${plan.overflow.length} carried, excluded ${plan.excluded.length} — PROPOSES only, a human merges`,
    artifacts: index !== undefined ? [join(bundleDir, "PR-BODY.md"), join(bundleDir, "INDEX.md")] : [join(bundleDir, "PR-BODY.md")],
    durationMs: Date.now() - startedAt,
    now: now(),
  });
  if ("error" in receipt) return receipt.error;
  return {
    json: {
      ...base,
      wrote: {
        bundle: bundleDir,
        pr_body: join(bundleDir, "PR-BODY.md"),
        ...(index !== undefined ? { index: join(bundleDir, "INDEX.md") } : {}),
        copies,
        state: statePath,
      },
      receipt: receipt.receipt,
    },
    code: 0,
  };
}

// ── claims prune — AC 2 (hygiene diffs + flagged drift, unambiguous fixes only) ─

export function pruneSub(rest: string[], env: NodeJS.ProcessEnv, now: () => Date): VerbResult {
  const startedAt = Date.now();
  const { flags, apply, error } = parseArgs(rest, ["--registry", "--vault", "--db", "--jobs", "--dashboards", "--deny-list"]);
  if (error !== undefined) return fail(error);
  const gated = jobsGate(flags, env, "prune");
  if ("error" in gated) return gated.error;
  const reg = claimsRegistry(flags, env, "prune");
  if ("error" in reg) return reg.error;

  // the schema-check IS the claims lint, reused verbatim (AC 2): every finding
  // is DRIFT a human owns — this pass never re-types a field, never deletes a
  // pointer (a "fix" like that would be a guess).
  const m = mount(env);
  const lint = lintClaimsRegistry(reg.dir, { vaultRoot: flags.get("--vault") ?? m?.path, db: flags.get("--db") });
  const drift = [...lint.findings];
  const { claims, skipped } = loadRegistryClaims(reg.dir);
  const plan = planPrune(claims);
  const diff = renderPruneDiff(plan.fixes);

  const base = {
    verb: "claims",
    ok: drift.length === 0,
    subcommand: "prune",
    dry_run: !apply,
    registry: reg.dir,
    files: lint.files.length,
    fixes: plan.fixes,
    drift,
    diff,
    skipped_claims: [...skipped],
  };

  if (!apply)
    return {
      json: { ...base, would_fix: plan.fixes.length, would_flag: drift.length },
      code: drift.length === 0 ? 0 : 1,
    };

  // the write path: ONLY the fixed claims' frontmatter (prose untouched —
  // rewriteClaimNote swaps the frontmatter block byte-exactly around it)
  const after = new Map(plan.claims.map((c) => [c.file, c.claim]));
  const changed: string[] = [];
  for (const fix of plan.fixes) {
    const path = join(reg.dir, fix.file);
    writeFileSync(path, rewriteClaimNote(readFileSync(path, "utf8"), after.get(fix.file)!));
    changed.push(fix.file);
  }

  const receipt = jobReceipt({
    sub: "prune",
    jobId: PRUNE_JOB,
    jobs: gated.jobs,
    dashboards: gated.dashboards,
    actions: changed.length,
    outcome: `prune: ${changed.length} fixes applied (${plan.fixes.length} unambiguous findings), ${drift.length} drift findings flagged for a human`,
    artifacts: changed.map((f) => join(reg.dir, f)),
    durationMs: Date.now() - startedAt,
    now: now(),
  });
  if ("error" in receipt) return receipt.error;
  // drift present still exits 1 even after the fixes: the pass acted, and the
  // registry still needs a human (the lint's convention — a gate that cannot
  // fail gates nothing)
  return {
    json: { ...base, fixed: changed.length, changed: [...new Set(changed)].sort(), receipt: receipt.receipt },
    code: drift.length === 0 ? 0 : 1,
  };
}

// ── claims synthesize — AC 3 (hopper proposals, never strategy) ───────────────

export function synthesizeSub(rest: string[], env: NodeJS.ProcessEnv, now: () => Date): VerbResult {
  const startedAt = Date.now();
  const { flags, apply, error } = parseArgs(rest, ["--registry", "--hopper", "--jobs", "--dashboards", "--deny-list"]);
  if (error !== undefined) return fail(error);
  const gated = jobsGate(flags, env, "synthesize");
  if ("error" in gated) return gated.error;
  const reg = claimsRegistry(flags, env, "synthesize");
  if ("error" in reg) return reg.error;
  const m = mount(env);
  const hopperDir = flags.get("--hopper") ?? (m !== undefined ? join(m.path, "hopper") : undefined);
  if (hopperDir === undefined)
    return fail(
      "claims synthesize: no personal vault mount resolved — pass --hopper <dir> explicitly (the hopper area is never a guess)",
    );

  const { claims, skipped } = loadRegistryClaims(reg.dir);
  const plan = detectPatterns(claims);
  // idempotence: a tag whose hopper note already exists is a named skip
  const existing = new Set(existsSync(hopperDir) ? readdirSync(hopperDir) : []);
  const fresh = plan.patterns.filter((p) => !existing.has(hopperSlug(p.tag)));
  const already = plan.patterns.filter((p) => existing.has(hopperSlug(p.tag)));
  const notes = fresh.map((p) => ({ slug: hopperSlug(p.tag), text: renderHopperNote(p, { now: now() }) }));

  const base = {
    verb: "claims",
    ok: true,
    subcommand: "synthesize",
    dry_run: !apply,
    registry: reg.dir,
    hopper: hopperDir,
    patterns: plan.patterns,
    overflow_carried: plan.overflow,
    skipped_claims: skipped,
    // the trust boundary, stated in every result: hopper only
    strategy: "untouched — this job proposes to the hopper only, never to human-fed strategy",
  };

  if (!apply)
    return { json: { ...base, would_write: notes.map((n) => join(hopperDir, n.slug)), notes }, code: 0 };

  mkdirSync(hopperDir, { recursive: true });
  const wrote: string[] = [];
  for (const n of notes) {
    const path = join(hopperDir, n.slug);
    writeFileSync(path, n.text);
    wrote.push(path);
  }

  const receipt = jobReceipt({
    sub: "synthesize",
    jobId: SYNTHESIZE_JOB,
    jobs: gated.jobs,
    dashboards: gated.dashboards,
    actions: wrote.length,
    outcome: `synthesize: ${wrote.length} hopper proposals, ${already.length} already proposed (skipped), ${plan.overflow.length} patterns carried — strategy untouched`,
    artifacts: wrote,
    durationMs: Date.now() - startedAt,
    now: now(),
  });
  if ("error" in receipt) return receipt.error;
  return {
    json: {
      ...base,
      wrote,
      skipped: already.map((p) => `${hopperSlug(p.tag)} (already proposed — idempotent skip)`),
      receipt: receipt.receipt,
    },
    code: 0,
  };
}
