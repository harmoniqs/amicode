import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveMountStack, personalMount } from "../../src/substrate/mount_store";

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
/** Write a vault dir with an optional `.amico-vault.toml` marker. `kind`/`name`
 *  are only emitted when given (so we can exercise the missing-kind path); pass
 *  `noMarker` to omit the marker entirely. Returns the dir path. */
function mkMount(
  root: string,
  dirName: string,
  opts: { kind?: string; name?: string; noMarker?: boolean } = {},
): string {
  const dir = path.join(root, dirName);
  fs.mkdirSync(dir, { recursive: true });
  if (!opts.noMarker) {
    let toml = "";
    if (opts.kind !== undefined) toml += `kind = "${opts.kind}"\n`;
    if (opts.name !== undefined) toml += `name = "${opts.name}"\n`;
    fs.writeFileSync(path.join(dir, ".amico-vault.toml"), toml);
  }
  return dir;
}
const kinds = (s: { mounts: { kind: string }[] }) => s.mounts.map((m) => m.kind);
const names = (s: { mounts: { name: string }[] }) => s.mounts.map((m) => m.name);

describe("resolveMountStack — discovery + kind-rank ordering (no manifest)", () => {
  it("(a) orders by canonical kind rank, restricted(3) BEFORE team(4)", () => {
    const root = mkTmp("vaults-");
    mkMount(root, "a-public", { kind: "public" });
    mkMount(root, "m-team", { kind: "team" });
    mkMount(root, "b-restricted", { kind: "restricted" });
    mkMount(root, "c-project", { kind: "project" });
    mkMount(root, "d-engagement", { kind: "engagement" });
    mkMount(root, "z-personal", { kind: "personal" });
    const stack = resolveMountStack(root, path.join(root, "no-manifest.toml"));
    expect(kinds(stack)).toEqual(["personal", "engagement", "project", "restricted", "team", "public"]);
  });

  it("(a′) breaks kind ties by name (ascending)", () => {
    const root = mkTmp("vaults-");
    mkMount(root, "c-proj", { kind: "project", name: "c-proj" });
    mkMount(root, "a-proj", { kind: "project", name: "a-proj" });
    const stack = resolveMountStack(root, path.join(root, "no-manifest.toml"));
    expect(names(stack)).toEqual(["a-proj", "c-proj"]);
  });

  it("(g) writability defaults by kind (personal/engagement/project rw; rest ro)", () => {
    const root = mkTmp("vaults-");
    mkMount(root, "p", { kind: "personal" });
    mkMount(root, "e", { kind: "engagement" });
    mkMount(root, "j", { kind: "project" });
    mkMount(root, "r", { kind: "restricted" });
    mkMount(root, "t", { kind: "team" });
    mkMount(root, "u", { kind: "public" });
    mkMount(root, "x", { kind: "weirdkind" });
    const stack = resolveMountStack(root, path.join(root, "no-manifest.toml"));
    const byKind = Object.fromEntries(stack.mounts.map((m) => [m.kind, m.writable]));
    expect(byKind.personal).toBe(true);
    expect(byKind.engagement).toBe(true);
    expect(byKind.project).toBe(true);
    expect(byKind.restricted).toBe(false);
    expect(byKind.team).toBe(false);
    expect(byKind.public).toBe(false);
    expect(byKind.weirdkind).toBe(false); // unknown → ro
  });
});

describe("resolveMountStack — skips + rescue", () => {
  it("(b) a dir with no marker is skipped and warned, not fatal", () => {
    const root = mkTmp("vaults-");
    mkMount(root, "not-a-vault", { noMarker: true });
    mkMount(root, "real", { kind: "personal" });
    const stack = resolveMountStack(root, path.join(root, "no-manifest.toml"));
    expect(names(stack)).toEqual(["real"]);
    expect(stack.warnings.some((w) => w.includes("not-a-vault") && /marker/i.test(w))).toBe(true);
  });

  it("(c) marker missing kind AND no manifest entry → skipped + warned", () => {
    const root = mkTmp("vaults-");
    mkMount(root, "no-kind", { name: "no-kind" }); // marker present, no kind
    mkMount(root, "ok", { kind: "personal" });
    const stack = resolveMountStack(root, path.join(root, "no-manifest.toml"));
    expect(names(stack)).toEqual(["ok"]);
    expect(stack.warnings.some((w) => w.includes("no-kind") && /kind/i.test(w))).toBe(true);
  });

  it("(c′) marker missing kind but WITH a manifest entry → rescued with manifest kind", () => {
    const root = mkTmp("vaults-");
    mkMount(root, "rescueme", {}); // empty marker: no kind, no name
    const manifest = path.join(root, "mounts.toml");
    fs.writeFileSync(manifest, '[[mount]]\nid = "rescueme"\nkind = "project"\n');
    const stack = resolveMountStack(root, manifest);
    const m = stack.mounts.find((x) => x.name === "rescueme");
    expect(m).toBeDefined();
    expect(m!.kind).toBe("project");
    expect(m!.writable).toBe(true); // project default rw
  });

  it("(d) duplicate resolved name → second discovery skipped + warned", () => {
    const root = mkTmp("vaults-");
    mkMount(root, "aaa", { kind: "personal", name: "dup" });
    mkMount(root, "bbb", { kind: "team", name: "dup" }); // discovered after aaa (sorted)
    const stack = resolveMountStack(root, path.join(root, "no-manifest.toml"));
    expect(stack.mounts.filter((m) => m.name === "dup").length).toBe(1);
    expect(stack.mounts[0].kind).toBe("personal"); // first wins
    expect(stack.warnings.some((w) => /duplicate/i.test(w) && w.includes("dup"))).toBe(true);
  });

  it("(e) name defaults to the dir basename when the marker omits it", () => {
    const root = mkTmp("vaults-");
    mkMount(root, "my-vault-dir", { kind: "personal" });
    const stack = resolveMountStack(root, path.join(root, "no-manifest.toml"));
    expect(names(stack)).toEqual(["my-vault-dir"]);
  });

  it("(h) missing vaults root → empty stack, no throw", () => {
    const stack = resolveMountStack("/nonexistent-vaults-root-xyz", "/nonexistent-manifest.toml");
    expect(stack.mounts).toEqual([]);
    expect(stack.warnings).toEqual([]);
  });
});

describe("resolveMountStack — mounts.toml precedence", () => {
  it("(f) manifest array order governs; kind/writable overridden; unlisted appended in discovery order", () => {
    const root = mkTmp("vaults-");
    mkMount(root, "alpha", { kind: "personal" }); // discovery order: alpha, beta, gamma
    mkMount(root, "beta", { kind: "team" });
    mkMount(root, "gamma", { kind: "project" });
    const manifest = path.join(root, "mounts.toml");
    fs.writeFileSync(
      manifest,
      [
        "[[mount]]",
        'id = "gamma"',
        'kind = "project"',
        "writable = false", // override project's rw default → ro
        "",
        "[[mount]]",
        'id = "alpha"',
        'kind = "engagement"', // override personal → engagement
        "",
      ].join("\n"),
    );
    const stack = resolveMountStack(root, manifest);
    // manifest order (gamma, alpha) then the unlisted beta in discovery order:
    expect(names(stack)).toEqual(["gamma", "alpha", "beta"]);
    const gamma = stack.mounts[0];
    expect(gamma.writable).toBe(false); // writable override honored
    const alpha = stack.mounts[1];
    expect(alpha.kind).toBe("engagement"); // kind override honored
    expect(alpha.writable).toBe(true); // engagement default rw (no writable override)
    expect(stack.mounts[2].name).toBe("beta");
  });

  it("matches a manifest entry by path basename when it has no id", () => {
    const root = mkTmp("vaults-");
    mkMount(root, "solo", { kind: "team" });
    mkMount(root, "aardvark", { kind: "personal" });
    const manifest = path.join(root, "mounts.toml");
    fs.writeFileSync(manifest, `[[mount]]\npath = "${path.join(root, "solo")}"\n`);
    const stack = resolveMountStack(root, manifest);
    // solo listed first via path basename; aardvark unlisted, appended after
    expect(names(stack)).toEqual(["solo", "aardvark"]);
  });
});

describe("personalMount", () => {
  it("returns the first kind=personal mount, or undefined when none exist", () => {
    const root = mkTmp("vaults-");
    mkMount(root, "team-one", { kind: "team" });
    const personalDir = mkMount(root, "me", { kind: "personal" });
    const stack = resolveMountStack(root, path.join(root, "no-manifest.toml"));
    expect(personalMount(stack)?.path).toBe(personalDir);

    const root2 = mkTmp("vaults-");
    mkMount(root2, "team-only", { kind: "team" });
    const stack2 = resolveMountStack(root2, path.join(root2, "no-manifest.toml"));
    expect(personalMount(stack2)).toBeUndefined();
  });
});
