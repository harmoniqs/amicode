// `amico profile resolve` (fleet spec §2/§3.1) — the capability-profile resolver the
// extension shells at spool-up, before it injects an agent def.
//
// The rules here are a port of amico-plugin's tests/lint_profiles.sh (the executable
// spec, documented in profiles/SCHEMA.md): a profile that passes CI must resolve here,
// and vice versa. The last block resolves the REAL shipped presets when the
// amico-plugin checkout is present, so the two halves cannot drift silently.
// Run: pnpm --filter @amicode/amico-run test profile_verb
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { profileResolve, profileVerb } from "../src/profile_verb.js";

const HAIKU = "anthropic/claude-haiku-4-5";
const OPUS5 = "anthropic/claude-opus-5";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "profiles-"));
  mkdirSync(join(root, "profiles"), { recursive: true });
  mkdirSync(join(root, "gates"), { recursive: true });
  mkdirSync(join(root, "skills"), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function skill(name: string, surface: "public" | "internal" | "none" = "public"): void {
  mkdirSync(join(root, "skills", name), { recursive: true });
  const fm = surface === "none" ? "" : `surface: ${surface}\n`;
  writeFileSync(join(root, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: x\n${fm}---\n\nbody\n`);
}

function gate(name: string, status: "available" | "pending-impl" | "hil-gated" = "available"): void {
  writeFileSync(
    join(root, "gates", `${name}.toml`),
    `schema = 1\nname = "${name}"\nscope = "solve"\nstatus = "${status}"\nverdict_record = "VerdictRecord"\n`,
  );
}

interface Fields {
  schema?: string;
  name?: string;
  description?: string;
  surface?: string;
  base?: string;
  skills?: string[];
  model?: string;
  variant?: string;
  task_type?: string;
  gates?: string[];
  plan?: string;
  runtimes?: string[];
  justification?: string;
  permissions?: Record<string, string> | null;
}

/** Write a profile TOML. Defaults are a valid frontier `executor`; pass null
 *  permissions to omit the table entirely. */
function profile(name: string, f: Fields = {}): string {
  const list = (xs: string[]) => `[${xs.map((x) => `"${x}"`).join(", ")}]`;
  const perms =
    f.permissions === null
      ? ""
      : `\n[permissions]\n` +
        Object.entries(
          f.permissions ?? { vault: "rw", packages: "ro", ops: "none", work: "rw", device: "none", task: "deny" },
        )
          .map(([k, v]) => `${k} = "${v}"`)
          .join("\n") +
        "\n";
  const body = [
    `schema = ${f.schema ?? "1"}`,
    `name = "${f.name ?? name}"`,
    `description = "${f.description ?? "a test profile"}"`,
    ...(f.surface ? [`surface = "${f.surface}"`] : []),
    `base = "${f.base ?? "executor"}"`,
    `skills = ${list(f.skills ?? [])}`,
    `model = "${f.model ?? OPUS5}"`,
    ...(f.variant === "" ? [] : [`variant = "${f.variant ?? "high"}"`]),
    `task_type = "${f.task_type ?? "author-script"}"`,
    `gates = ${list(f.gates ?? [])}`,
    `plan = "${f.plan ?? ""}"`,
    ...(f.runtimes ? [`runtimes = ${list(f.runtimes)}`] : []),
    ...(f.justification ? [`task_grant_justification = "${f.justification}"`] : []),
  ].join("\n");
  const path = join(root, "profiles", `${name}.toml`);
  writeFileSync(path, body + "\n" + perms);
  return path;
}

/** Always pass the dirs AND the entitlement set explicitly: the defaults read the real
 *  amico-plugin checkout and ~/.amico/amicode/entitlements.toml, which would make these
 *  tests depend on the developer's machine. */
function resolve(args: string[], entitlements = "issimo"): { code: number; json: Record<string, unknown> } {
  const r = profileResolve([
    ...args,
    "--profiles-dir",
    join(root, "profiles"),
    "--skills-dir",
    join(root, "skills"),
    "--gates-dir",
    join(root, "gates"),
    "--entitlements",
    entitlements,
  ]);
  return { code: r.code, json: r.json as Record<string, unknown> };
}
const errorsOf = (json: Record<string, unknown>): string[] => (json.errors as string[]) ?? [];
const has = (xs: string[], needle: string) => xs.some((x) => x.includes(needle));

// ── the happy path ────────────────────────────────────────────────────────────────
describe("profile resolve — a valid profile", () => {
  it("resolves by --name against the profiles dir", () => {
    skill("atoms");
    gate("re-rollout");
    profile("composed", { skills: ["atoms"], gates: ["re-rollout"], model: HAIKU });
    const { code, json } = resolve(["resolve", "--name", "composed"]);
    expect(code).toBe(0);
    expect(json).toMatchObject({
      verb: "profile",
      subcommand: "resolve",
      ok: true,
      mode: "dispatch",
      name: "composed",
      base: "executor",
      model: HAIKU,
      variant: "high",
      task_type: "author-script",
      skills: ["atoms"],
      runnable_gates: 1,
      plan: "",
    });
  });

  it("resolves by --profile against an explicit file", () => {
    const p = profile("composed");
    const { code, json } = resolve(["resolve", "--profile", p]);
    expect(code).toBe(0);
    expect(json.path).toBe(p);
  });

  it("defaults surface to internal and runtimes to both rings", () => {
    profile("composed");
    const { json } = resolve(["resolve", "--name", "composed"]);
    expect(json.surface).toBe("internal");
    expect(json.runtimes).toEqual(["claude-code", "opencode"]);
  });

  it("requires a profile selector, and reports the documented fallback preset", () => {
    const { code, json } = resolve(["resolve"]);
    expect(code).toBe(64);
    expect(has(errorsOf(json), "--name")).toBe(true);
    expect(json.fallback_preset).toBe("default"); // §3.1: fail loudly, land on `default`
  });

  it("an unresolvable path fails loudly PRE-injection", () => {
    const { code, json } = resolve(["resolve", "--name", "ghost"]);
    expect(code).toBe(64);
    expect(has(errorsOf(json), "does not resolve")).toBe(true);
  });

  it("an unknown --mode is a usage error", () => {
    profile("composed");
    const { code, json } = resolve(["resolve", "--name", "composed", "--mode", "sideways"]);
    expect(code).toBe(64);
    expect(has(errorsOf(json), "--mode")).toBe(true);
  });

  it("the verb router rejects an unknown subcommand with usage", () => {
    const r = profileVerb(["compile"]);
    expect(r.code).toBe(64);
    expect((r.json as { usage: string }).usage).toContain("profile resolve");
  });
});

// ── the spool-up composition rule ─────────────────────────────────────────────────
describe("the spool-up composition rule (§3.1) — a chat is always the resident shell", () => {
  it("IGNORES a preset's base in spool-up mode, and says so", () => {
    profile("composed", { base: "executor" });
    const { code, json } = resolve(["resolve", "--name", "composed", "--mode", "spool-up"]);
    expect(code).toBe(0);
    expect(json.base).toBe("resident");
    expect(json.base_declared).toBe("executor");
    expect(json.base_ignored).toBe("executor");
    expect(json.spool_up_shell_rule).toContain("resident");
  });

  it("HONOURS the declared base when the profile is dispatched, not worn", () => {
    profile("composed", { base: "headless" });
    const { json } = resolve(["resolve", "--name", "composed", "--mode", "dispatch"]);
    expect(json.base).toBe("headless");
    expect(json.base_ignored).toBeNull();
  });

  it("a resident profile in spool-up mode has nothing to ignore", () => {
    profile("composed", { base: "resident" });
    const { json } = resolve(["resolve", "--name", "composed", "--mode", "spool-up"]);
    expect(json.base).toBe("resident");
    expect(json.base_ignored).toBeNull();
  });

  it("spool-up still carries skills, model, variant, permissions, gates, task_type", () => {
    skill("atoms");
    gate("re-rollout");
    profile("composed", { base: "executor", skills: ["atoms"], gates: ["re-rollout"], model: HAIKU, variant: "low", task_type: "experiment-sim" });
    const { json } = resolve(["resolve", "--name", "composed", "--mode", "spool-up"]);
    expect(json).toMatchObject({ skills: ["atoms"], model: HAIKU, variant: "low", task_type: "experiment-sim", gates: ["re-rollout"] });
    expect(json.permissions).toMatchObject({ vault: "rw", device: "none", task: "deny" });
  });

  it("a known preset must declare its §2.3 shell", () => {
    profile("dreamer", { base: "executor" }); // §2.3 says headless
    const { code, json } = resolve(["resolve", "--name", "dreamer"]);
    expect(code).toBe(64);
    expect(has(errorsOf(json), 'must declare base = "headless"')).toBe(true);
  });
});

// ── entitlement filtering ─────────────────────────────────────────────────────────
describe("entitlement filtering of skills", () => {
  it("public skills are always staged; internal skills need a held entitlement", () => {
    skill("atoms", "public");
    skill("develop", "internal");
    profile("composed", { skills: ["atoms", "develop"] });
    const withCode = resolve(["resolve", "--name", "composed"], "issimo");
    expect(withCode.json.skills).toEqual(["atoms", "develop"]);
    expect(withCode.json.skills_filtered).toEqual([]);

    const without = resolve(["resolve", "--name", "composed"], "");
    expect(without.code).toBe(0); // filtering never fails the resolve
    expect(without.json.skills).toEqual(["atoms"]);
    expect(without.json.skills_filtered).toEqual([{ name: "develop", reason: "internal skill, no entitlement held" }]);
    expect(without.json.skills_declared).toEqual(["atoms", "develop"]);
  });

  it("reads codes from an entitlements.toml when no flag is given", () => {
    skill("develop", "internal");
    profile("composed", { skills: ["develop"] });
    const entsDir = join(root, "ents");
    mkdirSync(entsDir, { recursive: true });
    writeFileSync(join(entsDir, "entitlements.toml"), 'codes = ["issimo"]\n');
    const r = profileResolve([
      "resolve",
      "--name",
      "composed",
      "--profiles-dir",
      join(root, "profiles"),
      "--skills-dir",
      join(root, "skills"),
      "--gates-dir",
      join(root, "gates"),
      "--entitlements-dir",
      entsDir,
    ]);
    expect(r.code).toBe(0);
    expect((r.json as { skills: string[] }).skills).toEqual(["develop"]);
  });

  it("a malformed entitlements.toml warns and falls back to public-only, never dead-ends", () => {
    skill("atoms", "public");
    profile("composed", { skills: ["atoms"] });
    const entsDir = join(root, "ents");
    mkdirSync(entsDir, { recursive: true });
    writeFileSync(join(entsDir, "entitlements.toml"), "codes = [not toml\n");
    const r = profileResolve([
      "resolve",
      "--name",
      "composed",
      "--profiles-dir",
      join(root, "profiles"),
      "--skills-dir",
      join(root, "skills"),
      "--gates-dir",
      join(root, "gates"),
      "--entitlements-dir",
      entsDir,
    ]);
    expect(r.code).toBe(0);
    expect(has((r.json as { warnings: string[] }).warnings, "could not parse")).toBe(true);
  });

  it("a MISSING skill is an error, not a filter (§3.1 failure path)", () => {
    profile("composed", { skills: ["ghost"] });
    const { code, json } = resolve(["resolve", "--name", "composed"]);
    expect(code).toBe(64);
    expect(has(errorsOf(json), 'skill "ghost" does not exist')).toBe(true);
  });

  it("a skill with no surface: tag is an error", () => {
    skill("untagged", "none");
    profile("composed", { skills: ["untagged"] });
    expect(has(errorsOf(resolve(["resolve", "--name", "composed"]).json), "no surface: tag")).toBe(true);
  });

  it("a public-ring profile may only stage public skills", () => {
    skill("develop", "internal");
    profile("composed", { surface: "public", skills: ["develop"] });
    expect(has(errorsOf(resolve(["resolve", "--name", "composed"]).json), "may only stage public skills")).toBe(true);
  });

  it("a package-dev skill needs at least `ro` on the packages root (the unentitled-package path)", () => {
    skill("piccolo-dev", "internal");
    profile("composed", {
      skills: ["piccolo-dev"],
      permissions: { vault: "rw", packages: "none", ops: "none", work: "rw", device: "none", task: "deny" },
    });
    const { code, json } = resolve(["resolve", "--name", "composed"]);
    expect(code).toBe(64);
    expect(has(errorsOf(json), "needs at least \"ro\" on the packages root")).toBe(true);
  });
});

// ── schema rules ──────────────────────────────────────────────────────────────────
describe("schema validation", () => {
  it("schema must be 1", () => {
    profile("composed", { schema: "2" });
    expect(has(errorsOf(resolve(["resolve", "--name", "composed"]).json), "schema must be 1")).toBe(true);
  });

  it("name must equal the filename stem", () => {
    profile("composed", { name: "other" });
    expect(has(errorsOf(resolve(["resolve", "--name", "composed"]).json), "filename stem")).toBe(true);
  });

  it("base must be one of the three shells", () => {
    profile("composed", { base: "daemon" });
    expect(has(errorsOf(resolve(["resolve", "--name", "composed"]).json), "must be one of (resident, executor, headless)")).toBe(true);
  });

  it("model must be a well-formed provider/model-id", () => {
    profile("composed", { model: "claude-opus-5" });
    expect(has(errorsOf(resolve(["resolve", "--name", "composed"]).json), "well-formed provider/model-id")).toBe(true);
  });

  it("model and variant are ALWAYS co-stamped (a pin without a variant loses effort control)", () => {
    profile("composed", { variant: "" });
    const errs = errorsOf(resolve(["resolve", "--name", "composed"]).json);
    expect(has(errs, "co-stamped")).toBe(true);
  });

  it("an unknown variant only warns (provider catalogs define them)", () => {
    profile("composed", { variant: "turbo" });
    const { code, json } = resolve(["resolve", "--name", "composed"]);
    expect(code).toBe(0);
    expect(has(json.warnings as string[], "outside the known effort ladder")).toBe(true);
  });

  it("task_type must be in the G-F taxonomy", () => {
    profile("composed", { task_type: "experiment" }); // the lane-less value
    expect(has(errorsOf(resolve(["resolve", "--name", "composed"]).json), "task_type \"experiment\"")).toBe(true);
  });

  it("the `default` preset MUST stamp converse", () => {
    profile("default", { base: "resident", task_type: "plan", model: OPUS5 });
    expect(has(errorsOf(resolve(["resolve", "--name", "default"]).json), 'must stamp task_type = "converse"')).toBe(true);
  });

  it("plan must be empty — it is runtime-authored only", () => {
    profile("composed", { plan: "plans/plan-x.md" });
    expect(has(errorsOf(resolve(["resolve", "--name", "composed"]).json), "plan must be empty")).toBe(true);
  });

  it("an unknown runtime is rejected", () => {
    profile("composed", { runtimes: ["claude-code", "emacs"] });
    expect(has(errorsOf(resolve(["resolve", "--name", "composed"]).json), 'unknown runtime "emacs"')).toBe(true);
  });

  it("a missing permissions table is an error", () => {
    profile("composed", { permissions: null });
    expect(has(errorsOf(resolve(["resolve", "--name", "composed"]).json), 'missing required key "permissions"')).toBe(true);
  });

  it("permission keys and values are closed sets", () => {
    profile("composed", { permissions: { vault: "rw", packages: "ro", ops: "none", work: "rw", device: "none", task: "deny", network: "rw" } });
    expect(has(errorsOf(resolve(["resolve", "--name", "composed"]).json), 'unknown permission key "network"')).toBe(true);
    profile("bad-value", { permissions: { vault: "write", packages: "ro", ops: "none", work: "rw", device: "none", task: "deny" } });
    expect(has(errorsOf(resolve(["resolve", "--name", "bad-value"]).json), "permissions.vault must be one of")).toBe(true);
  });

  it("a saved PRESET must stamp every resource explicitly; a composed profile takes the §2.1 defaults", () => {
    profile("dreamer", { base: "headless", permissions: { vault: "rw", task: "deny" } });
    expect(has(errorsOf(resolve(["resolve", "--name", "dreamer"]).json), "must stamp permissions.packages explicitly")).toBe(true);

    profile("composed", { permissions: { vault: "rw" } });
    const { code, json } = resolve(["resolve", "--name", "composed"]);
    expect(code).toBe(0);
    expect(json.permissions).toEqual({ vault: "rw", packages: "ro", ops: "ro", work: "rw", device: "none", task: "deny" });
    expect(json.permissions_defaulted).toEqual(["packages", "ops", "work", "device", "task"]);
  });
});

// ── device + task grants ──────────────────────────────────────────────────────────
describe("device and task permissions", () => {
  it('device = "rw" is rejected — the P4 autonomy gate is not open', () => {
    profile("composed", { permissions: { vault: "rw", packages: "ro", ops: "none", work: "rw", device: "rw", task: "deny" } });
    const { code, json } = resolve(["resolve", "--name", "composed"]);
    expect(code).toBe(64);
    expect(has(errorsOf(json), "P4 autonomy gate")).toBe(true);
  });

  it('device = "ro" resolves with a warning (hardware access is opt-in)', () => {
    profile("composed", { permissions: { vault: "ro", packages: "ro", ops: "none", work: "ro", device: "ro", task: "deny" } });
    const { code, json } = resolve(["resolve", "--name", "composed"]);
    expect(code).toBe(0);
    expect(has(json.warnings as string[], "hardware access is opt-in")).toBe(true);
  });

  it("`device` is NOT a path resource: a device grant never yields Claude Code Write/Edit", () => {
    // The stronger case (device = "rw" with no path rw) is unreachable because the P4
    // gate rejects it above, so `ro` is the reachable proof of the same predicate.
    profile("composed", { permissions: { vault: "ro", packages: "ro", ops: "none", work: "ro", device: "ro", task: "deny" } });
    const { json } = resolve(["resolve", "--name", "composed"]);
    const preview = (json.compiled_preview as { claude_code: { tools: string; path_rw: boolean } }).claude_code;
    expect(preview.path_rw).toBe(false);
    expect(preview.tools).toBe("Read, Glob, Grep, Bash");
  });

  it("any PATH resource at rw yields the lossy Write/Edit downgrade", () => {
    profile("composed", { permissions: { vault: "rw", packages: "ro", ops: "none", work: "ro", device: "none", task: "deny" } });
    const preview = (resolve(["resolve", "--name", "composed"]).json.compiled_preview as { claude_code: { tools: string } }).claude_code;
    expect(preview.tools).toContain("Write, Edit");
  });

  it('task = "allow" requires a justification', () => {
    profile("composed", { permissions: { vault: "rw", packages: "ro", ops: "none", work: "rw", device: "none", task: "allow" }, runtimes: ["opencode"] });
    const { code, json } = resolve(["resolve", "--name", "composed"]);
    expect(code).toBe(64);
    expect(has(errorsOf(json), "task_grant_justification")).toBe(true);
  });

  it('task = "allow" must never compile to a Claude Code variant', () => {
    profile("composed", {
      permissions: { vault: "rw", packages: "ro", ops: "none", work: "rw", device: "none", task: "allow" },
      runtimes: ["claude-code", "opencode"],
      justification: "dynamic decomposition of an unknown-width sweep",
    });
    const { code, json } = resolve(["resolve", "--name", "composed"]);
    expect(code).toBe(64);
    expect(has(errorsOf(json), "never compile to a Claude Code variant")).toBe(true);
  });

  it('a justified, opencode-only task grant resolves — with a warning, and Agent in the tool set', () => {
    profile("composed", {
      permissions: { vault: "rw", packages: "ro", ops: "none", work: "rw", device: "none", task: "allow" },
      runtimes: ["opencode"],
      justification: "dynamic decomposition of an unknown-width sweep",
    });
    const { code, json } = resolve(["resolve", "--name", "composed"]);
    expect(code).toBe(0);
    expect(has(json.warnings as string[], "ZERO grants")).toBe(true);
    expect((json.compiled_preview as { claude_code: { tools: string } }).claude_code.tools).toContain("Agent");
  });
});

// ── the verifiability rule (§6.1 rule 1) ──────────────────────────────────────────
describe("the verifiability rule — ungated failure is silent failure", () => {
  it("rejects a below-frontier stamp with no gate", () => {
    profile("composed", { model: HAIKU, gates: [] });
    const { code, json } = resolve(["resolve", "--name", "composed"]);
    expect(code).toBe(64);
    expect(has(errorsOf(json), "below-frontier model")).toBe(true);
  });

  it("accepts a below-frontier stamp covered by an AVAILABLE gate", () => {
    gate("re-rollout", "available");
    profile("composed", { model: HAIKU, gates: ["re-rollout"] });
    expect(resolve(["resolve", "--name", "composed"]).code).toBe(0);
  });

  it("a pending-impl gate does not satisfy the rule (it cannot run yet)", () => {
    gate("fit-recovery", "pending-impl");
    profile("composed", { model: HAIKU, gates: ["fit-recovery"] });
    const { code, json } = resolve(["resolve", "--name", "composed"]);
    expect(code).toBe(64);
    expect(has(errorsOf(json), "below-frontier model")).toBe(true);
    expect(has(json.warnings as string[], "cannot run yet")).toBe(true);
  });

  it("a frontier stamp needs no gate", () => {
    profile("composed", { model: OPUS5, gates: [] });
    expect(resolve(["resolve", "--name", "composed"]).code).toBe(0);
  });

  it("an unknown model is treated as below frontier", () => {
    profile("composed", { model: "some/experimental-model", gates: [] });
    expect(has(errorsOf(resolve(["resolve", "--name", "composed"]).json), "not in the known tier ladder")).toBe(true);
  });

  it("a gate that does not resolve in the registry is an error", () => {
    profile("composed", { model: OPUS5, gates: ["vibes-check"] });
    expect(has(errorsOf(resolve(["resolve", "--name", "composed"]).json), "does not resolve in the gate registry")).toBe(true);
  });

  it("an unavailable gate is reported on a resolved profile too", () => {
    gate("physics-agreement", "hil-gated");
    profile("composed", { model: OPUS5, gates: ["physics-agreement"] });
    const { code, json } = resolve(["resolve", "--name", "composed"]);
    expect(code).toBe(0);
    expect(json.runnable_gates).toBe(0);
    expect(json.gates_unavailable).toEqual([{ name: "physics-agreement", status: "hil-gated" }]);
  });
});

// ── cross-repo: the REAL shipped presets ──────────────────────────────────────────
// Skipped when the amico-plugin checkout is absent (CI has no sibling repos), exactly
// like the lint's own runner-existence check.
const PLUGIN = join(homedir(), "harmoniqs", "amico-plugin");
const HAVE_PLUGIN = existsSync(join(PLUGIN, "profiles")) && existsSync(join(PLUGIN, "gates"));

describe.skipIf(!HAVE_PLUGIN)("the shipped amico-plugin presets resolve", () => {
  const real = (args: string[]) =>
    profileResolve([
      ...args,
      "--profiles-dir",
      join(PLUGIN, "profiles"),
      "--skills-dir",
      join(PLUGIN, "skills"),
      "--gates-dir",
      join(PLUGIN, "gates"),
      "--entitlements",
      "issimo",
    ]);

  for (const [name, base] of Object.entries({
    researcher: "executor",
    experimenter: "executor",
    engineer: "executor",
    "librarian-insight": "executor",
    dreamer: "headless",
    default: "resident",
  })) {
    it(`${name} resolves when dispatched (base ${base})`, () => {
      const r = real(["resolve", "--name", name]);
      expect((r.json as { errors?: string[] }).errors ?? []).toEqual([]);
      expect(r.code).toBe(0);
      expect(r.json).toMatchObject({ ok: true, name, base });
    });

    it(`${name} wears the resident shell at spool-up`, () => {
      const r = real(["resolve", "--name", name, "--mode", "spool-up"]);
      expect(r.code).toBe(0);
      expect((r.json as { base: string }).base).toBe("resident");
    });
  }
});
