// amico doctor (#402 slice 1d): validate the studio binding — the world, not
// just the schema. Paths exist, mounts readable, exactly one rw personal
// mount, and the KNOWN legacy drift flagged (the relocation slices' to-do
// list). Pure core (fs injected); the CLI verb prints the table.
import { describe, test, expect } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diagnoseStudio } from "../src/doctor.js";
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
    const r = await diagnoseStudio(legacyStudioPaths(), exists);
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

