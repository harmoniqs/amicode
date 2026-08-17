// Studio-manifest adoption in amico-run (#402 slice 1c): the ladder for
// every root this package resolves — explicit option/env → MANIFEST → legacy
// ~/.amico path. Absent manifest = today's behavior exactly (parity); the
// hermetic env overrides still win (tests stay hermetic).
import { describe, test, expect, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homedir } from "node:os";
import { defaultRunsRoot } from "../src/run_dir.js";
import { ledgerPath } from "../src/ledger.js";

let cleanups: (() => Promise<void>)[] = [];
// setup.ts pins $AMICO_LEDGER only-if-unset — restore exactly what we found
const prevLedger = process.env.AMICO_LEDGER;
afterEach(async () => {
  delete process.env.AMICODE_STUDIO_CONFIG;
  if (prevLedger === undefined) delete process.env.AMICO_LEDGER;
  else process.env.AMICO_LEDGER = prevLedger;
  for (const c of cleanups) await c();
  cleanups = [];
});

describe("root ladder adoption (#402)", () => {
  test("no manifest → legacy paths exactly (parity)", () => {
    const dir = `${tmpdir()}/studio-absent-${process.pid}`;
    process.env.AMICODE_STUDIO_CONFIG = join(dir, "config.toml"); // nonexistent
    // the suite's global guard pins $AMICO_LEDGER — save/clear so the LADDER
    // (not the hermetic escape) is what's under test; restored in afterEach
    delete process.env.AMICO_LEDGER;
    expect(defaultRunsRoot("default")).toBe(join(homedir(), ".amico", "runs", "default"));
    expect(ledgerPath()).toBe(join(homedir(), ".amico", "ledger", "runs.jsonl"));
  });

  test("a manifest redirects runs + ledger under the studio root", async () => {
    const root = await mkdtemp(`${tmpdir()}/amico-studio-`);
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const cfg = join(root, "config.toml");
    await writeFile(cfg, `schema_version = "1"\nstudio_root = "${join(root, "studio")}"\n`);
    process.env.AMICODE_STUDIO_CONFIG = cfg;
    delete process.env.AMICO_LEDGER; // the guard env outranks the manifest — testing the manifest rung

    expect(defaultRunsRoot("lab9")).toBe(join(root, "studio", "runs", "lab9"));
    expect(ledgerPath()).toBe(join(root, "studio", "ledger", "runs.jsonl"));
  });

  test("explicit root overrides in the manifest win over derived defaults", async () => {
    const root = await mkdtemp(`${tmpdir()}/amico-studio-`);
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const cfg = join(root, "config.toml");
    await writeFile(
      cfg,
      `schema_version = "1"\nstudio_root = "${join(root, "studio")}"\n` +
        `runs = "${join(root, "elsewhere", "runs")}"\n` +
        `ledger = "${join(root, "elsewhere", "ledger")}"\n`,
    );
    process.env.AMICODE_STUDIO_CONFIG = cfg;
    delete process.env.AMICO_LEDGER; // testing the manifest rung

    expect(defaultRunsRoot("default")).toBe(join(root, "elsewhere", "runs", "default"));
    expect(ledgerPath()).toBe(join(root, "elsewhere", "ledger", "runs.jsonl"));
  });

  test("$AMICO_LEDGER still outranks the manifest (hermetic escape documented)", async () => {
    const root = await mkdtemp(`${tmpdir()}/amico-studio-`);
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const cfg = join(root, "config.toml");
    await writeFile(cfg, `schema_version = "1"\nstudio_root = "${join(root, "studio")}"\n`);
    process.env.AMICODE_STUDIO_CONFIG = cfg;
    process.env.AMICO_LEDGER = "/tmp/hermetic-runs.jsonl";
    expect(ledgerPath()).toBe("/tmp/hermetic-runs.jsonl");
  });

  test("a malformed manifest falls back to legacy, loudly not fatally", async () => {
    const root = await mkdtemp(`${tmpdir()}/amico-studio-`);
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const cfg = join(root, "config.toml");
    await writeFile(cfg, "schema_version = \"1\"\n"); // no studio_root
    process.env.AMICODE_STUDIO_CONFIG = cfg;
    expect(defaultRunsRoot("default")).toBe(join(homedir(), ".amico", "runs", "default"));
  });
});
