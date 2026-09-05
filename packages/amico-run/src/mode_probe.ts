// mode_probe.ts — the doctor's mode-registry component probe (#804, spec
// 20260905-063000 D1, H5): EXTENDS the existing agent-cards records with
// component-level verdicts — the doctor does not mint new surface records.
// Every probe outcome is a digest/schema/command verdict; anything that
// cannot run records a NAMED unknown/failed outcome, never a silent pass
// and never a wrong verdict:
//
//   - the BYTE authority is the machine's RELEASE TAG (git show <tag>),
//     never origin HEAD and never the working checkout — the compare's
//     revision authority is the RELEASE INDEX fetched from the remote
//     (vsix-tag → registry-revision); `current to vX` means the release the
//     machine staged from, and a machine a release behind renders
//     `current to vX, stale to release vY`, never plain current.
//   - a bundle component (card, pack, manifest, roles, handoff-seed schema)
//     that diverges is STALE with the offending component NAMED; a
//     half-staged bundle reads stale, not current (AC4).
//   - a LIVE staging lock reads `staging-in-progress → unknown`; a lock past
//     its TTL heartbeat reads `stale-lock → failed` (AC2/AC3).
//   - a version gap between the bundle's doctor floor and this doctor fails
//     LOUDLY (AC5).
//   - an untagged/dev build and an unreachable remote render NAMED unknowns,
//     never verdicts (AC6).
//
// The declared-set enumeration runs through the SHARED validator
// (@amicode/schema's parseModeManifest + declaredComponents) — the same code
// the vitest suite and the stager use; no second parser exists to drift.
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  parseModeManifest,
  declaredComponents,
  compareReleaseToIndex,
  checkConsumerFloor,
  readStagingLock,
  stagingLockVerdict,
  versionBaseOf,
  SUPPORTED_MODE_BUNDLE_VERSION,
  type ModeManifest,
  type ReleaseIndex,
  type ReleaseCompare,
} from "@amicode/schema";
import type { Exec, ExecResult } from "./surfaces.js";

export type ModeComponentVerdict = "current" | "stale" | "failed" | "unknown" | "integrity-failure";

/** ONE component-level verdict riding the existing agent-cards records. */
export interface ModeComponentRecord {
  /** The bundle's mode slug, or "registry" for registry-level rows. */
  mode: string;
  /** The component: a bundle-relative file path, or a named probe
   *  (release-compare, staging-lock, deploy-receipt, version-floor). */
  component: string;
  verdict: ModeComponentVerdict;
  evidence: string[];
}

/** What the inventory resolved once and shares across the two agent-cards
 *  records: the machine's release tag, the fetched release index, and a
 *  byte cache over the tag's tree (identical for both records). */
export interface ModeProbeState {
  /** The machine's release tag (v-prefixed) from its newest installed
   *  extension dir; null when no extension is installed. */
  machineTag: string | null;
  /** The installed extension's version string (evidence rendering). */
  installedVersion: string | null;
  /** The fetched release index + its compare outcome, or the named reason
   *  it could not be read. */
  release: ReleaseCompare | { status: "unknown"; render: string };
  run: Exec;
  rootRepoAmicode: string;
  /** tag:path → bytes | null (cached git-show; tags are immutable). */
  tagBytes: Map<string, string | null>;
}

const sha256hex = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

async function readFileSafe(p: string): Promise<string | null> {
  try {
    return await readFile(p, "utf8");
  } catch {
    return null;
  }
}

/** The bytes of a path at a release tag (cached; tags are immutable, and
 *  both agent-cards records share the cache). Null when the path is absent
 *  at the tag. */
async function bytesAtTag(
  state: ModeProbeState,
  tag: string,
  repoRelPath: string,
): Promise<string | null> {
  const key = `${tag}:${repoRelPath}`;
  if (state.tagBytes.has(key)) return state.tagBytes.get(key) ?? null;
  const r = await state.run("git", ["-C", state.rootRepoAmicode, "show", `${tag}:${repoRelPath}`]);
  const bytes = r.code === 0 ? r.stdout : null;
  state.tagBytes.set(key, bytes);
  return bytes;
}

/** Everything the deployed modes dir holds, file-by-file. */
async function walkDeployed(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (rel: string) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.name === ".staging-lock.json") continue; // the lock is judged by its own row
      if (/\.tmp-\d+$/.test(e.name)) continue; // crashed-stager debris — swept by the next stage, never a verdict input
      if (e.isDirectory()) await walk(child);
      else if (e.isFile()) out.set(child, await readFileSafe(join(root, child)).then((b) => b ?? "<UNREADABLE>"));
    }
  };
  await walk("");
  return out;
}

export interface ModeProbeResult {
  components: ModeComponentRecord[];
  /** The constraint this probe puts on the RECORD verdict ("unknown" for a
   *  live lock or an untagged build; "stale" when any component or the
   *  release compare failed; null = no constraint). */
  recordVerdict: "stale" | "unknown" | null;
  evidence: string[];
}

/** Probe the deployed mode bundles at one deployed root (the global config
 *  or the opencode-project staging root). ONE shared declared-set
 *  enumeration; the byte authority is the machine's release tag. */
export async function probeModeRegistry(
  state: ModeProbeState,
  deployedModesDir: string,
): Promise<ModeProbeResult> {
  const components: ModeComponentRecord[] = [];
  const evidence: string[] = [];

  // (1) the staging lock — live reads staging-in-progress → unknown for the
  //  WHOLE probe (never judge a transitioning deployment); stale reads
  //  stale-lock → failed. The lock row rides every record.
  const lock = readStagingLock(deployedModesDir);
  if (lock !== null && stagingLockVerdict(lock) === "live") {
    components.push({
      mode: "registry",
      component: "staging-lock",
      verdict: "unknown",
      evidence: [`staging-in-progress: a live staging lock (pid ${lock.owner_pid}) holds ${deployedModesDir}`],
    });
    return {
      components,
      recordVerdict: "unknown",
      evidence: [`staging-in-progress → unknown: bundle staging holds a live lock (pid ${lock.owner_pid}) — the deployed bundle set is transitioning, never judged mid-stage`],
    };
  }
  if (lock !== null) {
    components.push({
      mode: "registry",
      component: "staging-lock",
      verdict: "failed",
      evidence: [`stale-lock → failed: the staging lock's heartbeat is past its TTL or its owner is gone (pid ${lock.owner_pid}, heartbeat ${lock.heartbeat_at}) — the last staging pass crashed; the next pass steals it`],
    });
    evidence.push("stale staging lock — the last bundle staging pass did not complete (the next pass steals it after the liveness check)");
  }

  // (2) the release compare — the revision authority (AC6). The compare row
  //  renders verbatim (`current to vX` / `current to vX, stale to release
  //  vY` / the named unknown, never a verdict).
  const releaseRow: ModeComponentRecord = {
    mode: "registry",
    component: "release-compare",
    verdict: state.release.status === "current" ? "current" : state.release.status === "stale-to-release" ? "stale" : "unknown",
    evidence: [state.release.render],
  };
  components.push(releaseRow);
  evidence.push(`mode registry release compare: ${state.release.render}`);

  // (3) no installed extension at all → the machine's registry revision is a
  //  named unknown; the byte compare cannot run
  if (state.machineTag === null) {
    components.push({
      mode: "registry",
      component: "machine-release",
      verdict: "unknown",
      evidence: [`no installed extension dir — the machine's registry revision is unknown (installed: none)`],
    });
    return { components, recordVerdict: "unknown", evidence };
  }

  // (4) the expected bundle set AT THE MACHINE'S RELEASE TAG — never origin
  //  HEAD, never the checkout. A tag absent locally (untagged/dev build)
  //  renders a named unknown.
  const tag = state.machineTag;
  const ls = await state.run("git", [
    "-C", state.rootRepoAmicode, "ls-tree", "-r", "--name-only", tag, "--", "packages/extension/modes",
  ]);
  if (ls.code !== 0) {
    components.push({
      mode: "registry",
      component: "machine-release",
      verdict: "unknown",
      evidence: [`untagged/dev build — release tag ${tag} not found in the fetched repo; the registry bytes this machine shipped cannot be named, never a verdict`],
    });
    return { components, recordVerdict: "unknown", evidence };
  }
  const tagRelPaths = new Set(
    ls.stdout.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => l.replace(/^packages\/extension\/modes\//, "")),
  );
  const tagModes = [...new Set([...tagRelPaths].map((p) => p.split("/")[0]).filter((m) => m !== "release-index.toml"))].sort();

  const deployed = await walkDeployed(deployedModesDir);
  const deployedModes = [...new Set([...deployed.keys()].map((p) => p.split("/")[0]).filter((m) => m !== ".deploy-receipt.json"))].sort();

  // (5) per-bundle component compare: the tag manifest enumerates the
  //  DECLARED set (the shared validator's parser — one code path); each
  //  component's deployed bytes must match its release-tag bytes.
  let anyStale = lock !== null; // the stale lock row already failed
  for (const mode of tagModes) {
    const manifestRaw = await bytesAtTag(state, tag, `packages/extension/modes/${mode}/mode.toml`);
    if (manifestRaw === null) {
      components.push({
        mode,
        component: "mode.toml",
        verdict: "stale",
        evidence: [`mode.toml absent from the machine's release ${tag}`],
      });
      anyStale = true;
      continue;
    }
    let manifest: ModeManifest;
    try {
      manifest = parseModeManifest(manifestRaw);
    } catch (e) {
      components.push({
        mode,
        component: "mode.toml",
        verdict: "stale",
        evidence: [`mode.toml at release ${tag} does not parse: ${(e as Error).message}`],
      });
      anyStale = true;
      continue;
    }
    for (const c of declaredComponents(manifest)) {
      const expected = await bytesAtTag(state, tag, `packages/extension/${c.sourceRel}`);
      const deployedBytes = deployed.get(`${mode}/${c.inBundle}`);
      const row: ModeComponentRecord = { mode, component: c.inBundle, verdict: "current", evidence: [] };
      if (expected === null) {
        row.verdict = "stale";
        row.evidence.push(`declared component ${c.sourceRel} absent from the machine's release ${tag}`);
      } else if (deployedBytes === undefined) {
        row.verdict = "stale";
        row.evidence.push(`component ${mode}/${c.inBundle} missing from the deployed set — the repairable state (re-stage with the stager or \`amico upgrade agents\`)`);
      } else if (sha256hex(deployedBytes) !== sha256hex(expected)) {
        row.verdict = "stale";
        row.evidence.push(`component ${mode}/${c.inBundle} changed (deployed ${sha256hex(deployedBytes).slice(0, 12)} ≠ release ${tag} ${sha256hex(expected).slice(0, 12)})`);
      } else {
        row.evidence.push(`component ${mode}/${c.inBundle} byte-matches release ${tag}`);
      }
      if (row.verdict !== "current") anyStale = true;
      components.push(row);
    }
    // the version floor: the DEPLOYED manifest's doctor floor vs THIS
    // doctor's supported version — a gap fails LOUDLY (AC5)
    const deployedManifest = deployed.get(`${mode}/mode.toml`);
    if (deployedManifest !== undefined) {
      try {
        const dm = parseModeManifest(deployedManifest);
        const floor = checkConsumerFloor(dm.consumer_floors, "doctor", SUPPORTED_MODE_BUNDLE_VERSION);
        if (!floor.ok) {
          components.push({
            mode,
            component: "version-floor",
            verdict: "failed",
            evidence: [`${floor.render} — a named failed outcome, never a silent degrade`],
          });
          anyStale = true;
        }
      } catch {
        // the deployed manifest not parsing is the component row's staleness
      }
    }
  }

  // (6) reverse-direction drift: deployed bundle content the machine's
  //  release never declared — a leftover an older build dropped
  const declaredInBundle = new Set<string>();
  for (const m of components) {
    if (m.mode !== "registry") declaredInBundle.add(`${m.mode}/${m.component}`);
  }
  for (const path of deployed.keys()) {
    if (path === ".deploy-receipt.json") continue;
    if (tagModes.length === 0) {
      // a PRE-REGISTRY release expects NO bundles — anything deployed is drift
      components.push({
        mode: path.split("/")[0],
        component: path.split("/").slice(1).join("/"),
        verdict: "stale",
        evidence: [`bundle file ${path} extra in the deployed set — the machine's release ${tag} predates the registry, nothing was expected`],
      });
      anyStale = true;
      continue;
    }
    if (!declaredInBundle.has(path)) {
      components.push({
        mode: path.split("/")[0],
        component: path.split("/").slice(1).join("/"),
        verdict: "stale",
        evidence: [`bundle file ${path} extra in the deployed set (absent from the machine's release ${tag} declared set)`],
      });
      anyStale = true;
    }
  }

  // (7) the deploy receipt — auditable deployment (the stager writes it; a
  //  lying or missing receipt is itself staleness, mirroring the card
  //  receipt). Judged only when a registry was expected at this release.
  if (tagModes.length > 0 || deployedModes.length > 0) {
    const receiptRaw = deployed.get(".deploy-receipt.json") ?? null;
    if (receiptRaw === null) {
      components.push({
        mode: "registry",
        component: "deploy-receipt",
        verdict: "stale",
        evidence: ["mode-bundle deploy receipt missing (.deploy-receipt.json) — deployment not auditable"],
      });
      anyStale = true;
    } else {
      try {
        const receipt = JSON.parse(receiptRaw) as { modes?: Array<{ mode?: string; files?: Array<{ path?: string; sha256?: string }> }> };
        const mismatches: string[] = [];
        let rows = 0;
        for (const m of receipt.modes ?? []) {
          if (!m.mode) continue;
          for (const f of m.files ?? []) {
            if (!f.path || !f.sha256) continue;
            rows++;
            const actual = deployed.get(`${m.mode}/${f.path}`);
            if (actual === undefined || `sha256:${sha256hex(actual)}` !== f.sha256) {
              mismatches.push(`${m.mode}/${f.path}`);
            }
          }
        }
        if (rows === 0 || mismatches.length > 0) {
          components.push({
            mode: "registry",
            component: "deploy-receipt",
            verdict: "stale",
            evidence: [
              rows === 0
                ? "mode-bundle deploy receipt carries no file rows — deployment not auditable"
                : `mode-bundle deploy receipt digests disagree with deployed bytes: ${mismatches.join(", ")}`,
            ],
          });
          anyStale = true;
        } else {
          components.push({
            mode: "registry",
            component: "deploy-receipt",
            verdict: "current",
            evidence: [`deploy receipt digests match all ${rows} deployed bundle files`],
          });
        }
      } catch {
        components.push({
          mode: "registry",
          component: "deploy-receipt",
          verdict: "stale",
          evidence: ["mode-bundle deploy receipt unparseable — deployment not auditable"],
        });
        anyStale = true;
      }
    }
  }

  // Release currency is verdict-bearing (a stale compare constrains the
  // record above), so its unknown state is verdict-bearing too: an
  // unreachable remote must read whole-record unknown, never "current" —
  // a verdict that depends on the network is the anti-gaming hole (a
  // pre-registry machine surfaced only by this compare could read current
  // on a network blip). A hard local stale fact always wins over unknown.
  const recordVerdict: "stale" | "unknown" | null =
    releaseRow.verdict === "stale" || anyStale
      ? "stale"
      : releaseRow.verdict === "unknown"
        ? "unknown"
        : null;
  return { components, recordVerdict, evidence };
}

/** Resolve the machine's release tag from its newest installed extension
 *  dir (version-sorted, never mtime — the same selection the extension
 *  probe uses). */
export function machineReleaseTag(
  installedVersion: string | null,
): string | null {
  if (installedVersion === null) return null;
  const base = versionBaseOf(installedVersion);
  return base === "" ? null : `v${base}`;
}
