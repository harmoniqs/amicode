#!/usr/bin/env node
// deploy-agents.mjs — copy the mode cards from repo sources to the deployed
// agent-card directories (staging bundle + global opencode config) with
// byte-equality verification and a source-digest receipt.
//
// MANUAL OPERATOR ACTION — never CI. This script is run by a human (or an
// agent acting for one) at deploy time; the receipt it writes is the audit
// trail the fixture suite re-checks. It never pushes, never opens PRs, and
// never creates a destination that does not already exist.
//
// Usage:
//   node scripts/deploy-agents.mjs [--dry-run] [--staging <dir>] [--global <dir>]
//
// Defaults:
//   staging: ~/.amico/server/opencode-project-staging/opencode-project/.opencode/agents
//   global:  ~/.config/opencode/agents
//
// Behavior:
//   - copies packages/extension/agents/*.md (the two directors, the four
//     D3-seeded role cards, and the worker) to each EXISTING destination
//     directory (missing destination dirs are skipped, not created);
//   - verifies each written file byte-matches its repo source (sha256);
//   - writes .deploy-receipt.json next to the sources (timestamp, source
//     digests, destinations, verified flags) — unless --dry-run;
//   - exits 0 only when at least one destination was deployed and verified;
//     any verification mismatch or unreadable source exits 1.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const SOURCE_DIR = path.join(REPO_ROOT, "packages", "extension", "agents");
const RECEIPT_PATH = path.join(SOURCE_DIR, ".deploy-receipt.json");

// #761: the deploy surface matches the staging surface — every card shipped
// in the extension's agents dir (two directors, the four D3-seeded role
// cards, and the worker). Explicit on purpose: this is a MANUAL operator
// action, and the list is the human's decision surface; staging itself
// discovers the dir at runtime.
const CARDS = [
  "analyzer.md",
  "autodev.md",
  "autoresearch.md",
  "experimenter.md",
  "hypothesizer.md",
  "implementer.md",
  "librarian.md",
];

const DEFAULT_STAGING = path.join(
  homedir(),
  ".amico",
  "server",
  "opencode-project-staging",
  "opencode-project",
  ".opencode",
  "agents",
);
const DEFAULT_GLOBAL = path.join(homedir(), ".config", "opencode", "agents");

// ── args ────────────────────────────────────────────────────────────────────
let dryRun = false;
let stagingDir = DEFAULT_STAGING;
let globalDir = DEFAULT_GLOBAL;

for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === "--dry-run") {
    dryRun = true;
  } else if (arg === "--staging") {
    stagingDir = process.argv[++i];
    if (!stagingDir) usageFail("--staging requires a path");
  } else if (arg === "--global") {
    globalDir = process.argv[++i];
    if (!globalDir) usageFail("--global requires a path");
  } else {
    usageFail(`unknown argument: ${arg}`);
  }
}

function usageFail(message) {
  process.stderr.write(`deploy-agents: ${message}\n`);
  process.stderr.write(
    "usage: node scripts/deploy-agents.mjs [--dry-run] [--staging <dir>] [--global <dir>]\n",
  );
  process.exit(1);
}

// ── helpers ─────────────────────────────────────────────────────────────────
const sha256 = (buffer) => "sha256:" + createHash("sha256").update(buffer).digest("hex");

function log(message) {
  process.stdout.write(`${message}\n`);
}

// ── sources ─────────────────────────────────────────────────────────────────
const sources = [];
for (const card of CARDS) {
  const sourcePath = path.join(SOURCE_DIR, card);
  if (!existsSync(sourcePath)) {
    process.stderr.write(`deploy-agents: missing source card ${sourcePath}\n`);
    process.exit(1);
  }
  const bytes = readFileSync(sourcePath);
  sources.push({ card, path: sourcePath, sha256: sha256(bytes), bytes });
}

// ── destinations ────────────────────────────────────────────────────────────
const destinations = [
  { label: "staging", dir: stagingDir },
  { label: "global", dir: globalDir },
];

const results = [];
let deployedCount = 0;

for (const dest of destinations) {
  if (!existsSync(dest.dir)) {
    log(`[${dest.label}] SKIP — destination does not exist (never created): ${dest.dir}`);
    results.push({
      label: dest.label,
      path: dest.dir,
      deployed: false,
      verified: false,
      reason: "destination does not exist",
    });
    continue;
  }

  const cards = [];
  let allVerified = true;

  for (const source of sources) {
    const destPath = path.join(dest.dir, source.card);
    try {
      if (!dryRun) {
        copyFileSync(source.path, destPath);
      }
      const deployed = dryRun ? null : readFileSync(destPath);
      const verified = !dryRun && deployed !== null && deployed.equals(source.bytes);
      if (!verified) allVerified = false;
      cards.push({ card: source.card, path: destPath, verified });
      log(
        `[${dest.label}] ${dryRun ? "would copy" : "copied"} ${source.card}` +
          (dryRun ? "" : verified ? " — verified byte-identical" : " — VERIFICATION FAILED"),
      );
    } catch (error) {
      allVerified = false;
      cards.push({
        card: source.card,
        path: destPath,
        verified: false,
        reason: String(error?.message ?? error),
      });
      log(`[${dest.label}] FAILED ${source.card}: ${error?.message ?? error}`);
    }
  }

  const deployed = !dryRun && cards.length > 0 && cards.every((c) => c.verified !== false);
  if (deployed) deployedCount++;
  results.push({ label: dest.label, path: dest.dir, deployed, verified: allVerified, cards });
}

// ── receipt ─────────────────────────────────────────────────────────────────
const receipt = {
  receipt_version: 1,
  deployed_at: new Date().toISOString(),
  dry_run: dryRun,
  sources: sources.map(({ card, path: p, sha256: digest }) => ({
    card,
    path: p,
    sha256: digest,
  })),
  destinations: results.map(({ label, path: p, deployed, verified, reason }) => ({
    label,
    path: p,
    deployed,
    verified,
    ...(reason ? { reason } : {}),
  })),
};

if (dryRun) {
  log(`[receipt] DRY RUN — receipt not written (would write ${RECEIPT_PATH})`);
} else {
  writeFileSync(RECEIPT_PATH, JSON.stringify(receipt, null, 2) + "\n");
  log(`[receipt] wrote ${RECEIPT_PATH}`);
}

// ── exit ────────────────────────────────────────────────────────────────────
if (dryRun) {
  log("dry run complete — nothing written");
  process.exit(0);
}

if (deployedCount === 0) {
  process.stderr.write(
    "deploy-agents: no destination was deployed and verified — nothing to audit\n",
  );
  process.exit(1);
}

const failed = results.some((r) => r.cards?.some((c) => c.verified === false));
if (failed) {
  process.stderr.write("deploy-agents: byte-equality verification FAILED for at least one card\n");
  process.exit(1);
}

log(`deployed ${sources.length} card(s) to ${deployedCount} destination(s), all verified`);
process.exit(0);
