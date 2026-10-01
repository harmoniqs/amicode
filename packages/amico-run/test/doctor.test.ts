// amico doctor (#402 slice 1d): validate the studio binding — the world, not
// just the schema. Paths exist, mounts readable, exactly one rw personal
// mount, and the KNOWN legacy drift flagged (the relocation slices' to-do
// list). Pure core (fs injected); the CLI verb prints the table.
import { describe, test, expect } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diagnoseStudio, parseDoctorArgs, diagnosePinnedCli, type PinnedCliProbes } from "../src/doctor.js";
import type { StudioPaths } from "@amicode/schema";
import { legacyStudioPaths } from "@amicode/schema";

// cleanup is explicit per-test (cleanup()) — no shared afterEach state

let dirs: string[] = [];

async function tmp(): Promise<string> {
  const d = await mkdtemp(`${tmpdir()}/doctor-`);
  dirs.push(d);
  return d;
}

async function cleanup(): Promise<void> {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
  dirs = [];
}

const exists = async (p: string) => {
  try {
    await (await import("node:fs/promises")).stat(p);
    return true;
  } catch {
    return false;
  }
};

function paths(over: Partial<StudioPaths>): StudioPaths {
  return { ...legacyStudioPaths(), ...over };
}

describe("diagnoseStudio", () => {
  test("healthy manifest binding: all green", async () => {
    const root = await tmp();
    await mkdir(join(root, "problems"), { recursive: true });
    await mkdir(join(root, "runs"), { recursive: true });
    await mkdir(join(root, "ledger"), { recursive: true });
    await mkdir(join(root, "vaults", "mine"), { recursive: true });
    const p = paths({
      source: "manifest",
      studioRoot: root,
      problems: join(root, "problems"),
      runs: join(root, "runs"),
      ledger: join(root, "ledger"),
      harness: join(root, "ledger", "harness"),
      catalog: join(root, "catalog"),
      vaultsRoot: join(root, "vaults"),
      mounts: [{ name: "mine", kind: "personal", mode: "rw", path: join(root, "vaults", "mine") }],
    });
    const r = await diagnoseStudio(p, exists);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    await cleanup();
  });

  test("missing roots are errors with reason codes", async () => {
    const p = paths({ source: "manifest", problems: "/no/such/problems", runs: "/no/such/runs" });
    const r = await diagnoseStudio(p, exists);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => /problems.*missing/.test(e))).toBe(true);
    expect(r.errors.some((e) => /runs.*missing/.test(e))).toBe(true);
  });

  test("zero rw personal mounts is an error; two is an error (exactly one wins writes)", async () => {
    const none = paths({ source: "manifest", mounts: [] });
    expect((await diagnoseStudio(none, exists)).errors.some((e) => /rw personal mount/.test(e))).toBe(true);
    const two = paths({
      source: "manifest",
      mounts: [
        { name: "a", kind: "personal", mode: "rw", path: "/a" },
        { name: "b", kind: "personal", mode: "rw", path: "/b" },
      ],
    });
    expect((await diagnoseStudio(two, exists)).errors.some((e) => /exactly one.*personal/.test(e))).toBe(true);
  });

  test("unreadable mounts are errors", async () => {
    const p = paths({
      source: "manifest",
      mounts: [{ name: "gone", kind: "team", mode: "ro", path: "/no/such/vault" }],
    });
    expect((await diagnoseStudio(p, exists)).errors.some((e) => /mount gone/.test(e))).toBe(true);
  });

  test("the KNOWN legacy drift is flagged as warnings, not errors — the relocation to-do list", async () => {
    // always-true probe: this tests DRIFT LOGIC, not existence — a CI runner
    // has no ~/.amico at all, and missing roots are a different (error) path.
    const r = await diagnoseStudio(legacyStudioPaths(), () => Promise.resolve(true));
    expect(r.ok).toBe(true); // drift ≠ broken
    expect(r.warnings.some((w) => /ledger.*dotdir|dotdir.*ledger/.test(w))).toBe(true);
    expect(r.warnings.some((w) => /no studio catalog/.test(w))).toBe(true);
    expect(r.warnings.some((w) => /legacy/.test(w))).toBe(true);
  });

  test("manifest ledger outside the studio root is a drift warning", async () => {
    const p = paths({ source: "manifest", ledger: "/elsewhere/ledger", studioRoot: "/studio" });
    const r = await diagnoseStudio(p, () => Promise.resolve(true));
    expect(r.warnings.some((w) => /ledger.*outside/.test(w))).toBe(true);
  });
});

// ── v2 (#525): flag parsing + the composed report ────────────────────────────
describe("parseDoctorArgs", () => {
  test("no args = v1 behavior (no roots, human output)", () => {
    const r = parseDoctorArgs([]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.json).toBe(false);
    expect(r.args.roots).toEqual({});
    expect(r.args.runningBinary).toBe(null);
  });

  test("every injectable root flag maps to its SurfaceContext key", () => {
    const r = parseDoctorArgs([
      "--json",
      "--root-vscext", "/v",
      "--root-config", "/c",
      "--root-server", "/s",
      "--root-repo-amicode", "/a",
      "--root-repo-fork", "/f",
      "--root-staging", "/st",
      "--running-binary", "/r/opencode",
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.json).toBe(true);
    expect(r.args.roots).toEqual({
      rootVscext: "/v",
      rootConfig: "/c",
      rootServer: "/s",
      rootRepoAmicode: "/a",
      rootRepoFork: "/f",
      rootStaging: "/st",
      runningBinary: "/r/opencode",
    });
  });

  test("unknown flag / missing value is a usage error", () => {
    // The message rides toMatch, NOT a regex nested inside toMatchObject:
    // vitest substring-matches nested regexes, bun's runner compares them
    // literally — the portable form carries the same assertion.
    const usageError = (r: ReturnType<typeof parseDoctorArgs>): string => {
      expect(r.ok).toBe(false);
      return r.ok ? "" : r.message;
    };
    expect(usageError(parseDoctorArgs(["--nope"]))).toMatch(/unknown doctor flag/);
    expect(usageError(parseDoctorArgs(["--root-server"]))).toMatch(/requires a path/);
    expect(usageError(parseDoctorArgs(["--running-binary"]))).toMatch(/requires a path/);
  });
});

// ── #1666: the pinned CLI root record — the shims' frozen-bundle pin ─────────
describe("diagnosePinnedCli (#1666)", () => {
  const hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

  // a hermetic probe set over an in-memory fs map: entries + file bytes.
  function probes(fs: Record<string, string>): PinnedCliProbes {
    const names = Object.keys(fs);
    return {
      list: async (p) => names.filter((n) => n.startsWith(`${p}/`)).map((n) => n.slice(p.length + 1)),
      read: async (p) => (p in fs ? fs[p] : null),
      sha: async (p) => (p in fs ? hex(fs[p]) : null),
    };
  }

  test("a fresh pin (every bundle's sidecar matches its sha) is ok and reports root + amico.js sha", async () => {
    const fs: Record<string, string> = {
      "/pin/amico.js": "router bundle",
      "/pin/amico-pasqal.js": "runner bundle",
    };
    fs["/pin/amico.js.sha256"] = `${hex("router bundle")}  amico.js\n`;
    fs["/pin/amico-pasqal.js.sha256"] = `${hex("runner bundle")}  amico-pasqal.js\n`;
    const r = await diagnosePinnedCli("/pin", probes(fs));
    expect(r.name).toBe("pinned_cli");
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("/pin");
    expect(r.detail).toContain(hex("router bundle").slice(0, 12));
    expect(r.detail).toContain("2");
  });

  test("an ABSENT pin is a warning (the pre-pin state: resolving through the moving checkout), never an error", async () => {
    const r = await diagnosePinnedCli("/no-pin", probes({}));
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("/no-pin");
    expect(r.detail).toMatch(/moving checkout|install-cli-pin/);
  });

  test("a sidecar MISMATCH is an error naming the file and both digests (tampered dist or stale sidecar)", async () => {
    const fs: Record<string, string> = { "/pin/amico.js": "router bundle" };
    fs["/pin/amico.js.sha256"] = `${hex("a DIFFERENT bundle")}  amico.js\n`;
    const r = await diagnosePinnedCli("/pin", probes(fs));
    expect(r.status).toBe("error");
    expect(r.detail).toContain("amico.js");
    expect(r.detail).toContain(hex("router bundle"));
    expect(r.detail).toContain(hex("a DIFFERENT bundle"));
  });

  test("a MISSING sidecar is an integrity error (the freeze contract is bundle + sidecar pair)", async () => {
    const fs: Record<string, string> = { "/pin/amico.js": "router bundle" };
    const r = await diagnosePinnedCli("/pin", probes(fs));
    expect(r.status).toBe("error");
    expect(r.detail).toMatch(/sidecar missing.*amico\.js\.sha256/);
  });

  test("a sidecar with no sha digest in it is an error, not a silent pass", async () => {
    const fs: Record<string, string> = {
      "/pin/amico.js": "router bundle",
      "/pin/amico.js.sha256": "\n",
    };
    const r = await diagnosePinnedCli("/pin", probes(fs));
    expect(r.status).toBe("error");
    expect(r.detail).toMatch(/no sha256 digest/);
  });

  test("a pin that holds bundles but NOT amico.js is a warning — the amico shim still resolves through the checkout", async () => {
    const fs: Record<string, string> = { "/pin/amico-pasqal.js": "runner bundle" };
    fs["/pin/amico-pasqal.js.sha256"] = `${hex("runner bundle")}  amico-pasqal.js\n`;
    const r = await diagnosePinnedCli("/pin", probes(fs));
    expect(r.status).toBe("warn");
    expect(r.detail).toMatch(/no amico\.js/);
  });
});

