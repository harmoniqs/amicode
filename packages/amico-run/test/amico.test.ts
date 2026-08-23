// Router-dispatch tests for the `amico` verb router (issue #108). The launch/resolve/
// sandbox BODIES are already covered by cli.test.ts + subcommands.test.ts against the
// amico-run bundle; these tests assert the ROUTER seam: verb routing, --help surface,
// unknown-verb → 64, verbatim delegation of run/resolve/sandbox, and the stub verbs +
// mcp-serve facade. Run: `pnpm --filter @amicode/amico-run test`.
import { describe, it, expect, beforeAll } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeJulia, hermeticOpsEnv, readToml, tmpRoot, buildDoctorWorld, cleanupTracked } from "./helpers.js";
import { validateDoctorReport } from "../src/doctor_schema.js";
import { FakeCloud } from "./fake_cloud.js";

const BUNDLE = join(__dirname, "..", "dist", "amico.js");
beforeAll(() => {
  execFileSync("node", [join(__dirname, "..", "esbuild.config.mjs")], { cwd: join(__dirname, "..") });
});

function run(args: string[], env: Record<string, string> = {}): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("node", [BUNDLE, ...args], {
      encoding: "utf8",
      env: { ...process.env, ...hermeticOpsEnv(), ...env },
    });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

// Authoring fixture — mirrors subcommands.test.ts so the delegated resolve/sandbox verbs
// exercise the SAME code path with the SAME registry.
const REGISTRY = `
verify_tolerance = 0.01
[[template]]
id = "transmon-gate-1q"
platform = "transmon"
kind = "gate_synthesis"
size = 1
path = "solve_template.jl"
status = "vetted"
packages = ["Piccolo", "CairoMakie", "JLD2", "TOML", "Printf"]
[support]
packages = ["JLD2", "CairoMakie", "TOML", "Printf"]
[uuids]
Piccolo = "c4671d76-df94-11ed-2057-43d4fd632fad"
JLD2 = "033835bb-8acc-5ee8-8aae-3f567f8a3819"
`;

function authoringDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "amico-router-"));
  writeFileSync(join(dir, "registry.toml"), REGISTRY);
  writeFileSync(join(dir, "index.json"), JSON.stringify({ schema_version: 1, exemplars: [] }));
  writeFileSync(
    join(dir, "authoring.json"),
    JSON.stringify({
      schema_version: 1,
      allowlist: ["Piccolo", "Legato", "Intonato", "NamedTrajectories", "DirectTrajOpt"],
      support_set: ["JLD2", "CairoMakie", "TOML", "Printf"],
      registry: join(dir, "registry.toml"),
      exemplars: join(dir, "index.json"),
      verify_tolerance: 0.01,
    }),
  );
  return dir;
}

describe("amico router — help + unknown verb", () => {
  it("--help lists the full verb surface, exit 0", () => {
    const r = run(["--help"]);
    expect(r.code).toBe(0);
    for (const v of ["run", "resolve", "sandbox", "catalog", "vault", "device", "note", "cloud", "mcp-serve"]) {
      expect(r.stdout).toContain(`amico ${v}`);
    }
  });
  it("bare `amico` (no verb) → usage, exit 64", () => {
    const r = run([]);
    expect(r.code).toBe(64);
    expect(r.stdout).toContain("usage:");
  });
  it("unknown verb → exit 64, names the verb on stderr", () => {
    const r = run(["frobnicate"]);
    expect(r.code).toBe(64);
    expect(r.stderr).toMatch(/unknown verb "frobnicate"/);
  });
});

describe("amico router — run delegates verbatim to the launch path", () => {
  it("clean solve: relays iter lines, prints AMICODE_FINISHED, exits 0", () => {
    const root = tmpRoot();
    const julia = fakeJulia(root, "j", `console.log('AMICODE_ITER iter=1 f=0.5'); console.log('DONE f=0.99')`);
    const script = fakeJulia(root, "s.jl", "");
    const r = run(["run", script, "--runs-root", join(root, "runs"), "--julia", julia]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("AMICODE_ITER iter=1 f=0.5");
    expect(r.stdout).toMatch(/AMICODE_FINISHED status=completed exitCode=0 runDir=.+/);
  });
  it("run with no script → 64 with the amico-run launch-path error (delegation is verbatim)", () => {
    const r = run(["run"]);
    expect(r.code).toBe(64);
    expect(r.stderr).toMatch(/amico-run: no script given/);
  });
  it("run with an unknown flag → 64 (launch-path flag handling, not swallowed)", () => {
    const root = tmpRoot();
    const r = run(["run", fakeJulia(root, "s.jl", ""), "--gates", "X"]);
    expect(r.code).toBe(64);
    expect(r.stderr).toMatch(/unknown flag/);
  });
});

describe("amico router — resolve/sandbox delegate verbatim to the subcommands", () => {
  it("resolve: exact vetted shape → tier vetted JSON with template_path + packages", () => {
    const dir = authoringDir();
    const r = run(["resolve", "--platform", "transmon", "--kind", "gate_synthesis", "--size", "1"], {
      AMICO_AUTHORING_FILE: join(dir, "authoring.json"),
    });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.tier).toBe("vetted");
    expect(out.template_path).toMatch(/solve_template\.jl$/);
    expect(out.packages).toContain("Piccolo");
    rmSync(dir, { recursive: true, force: true });
  });
  it("sandbox: writes env/Project.toml with [deps] uuids", () => {
    const dir = authoringDir();
    const target = mkdtempSync(join(tmpdir(), "amico-router-ws-"));
    const r = run(["sandbox", target, "--packages", "Piccolo,JLD2"], {
      AMICO_AUTHORING_FILE: join(dir, "authoring.json"),
    });
    expect(r.code).toBe(0);
    expect(existsSync(join(target, "env", "Project.toml"))).toBe(true);
    const deps = readToml(join(target, "env", "Project.toml")).deps as Record<string, string>;
    expect(deps.Piccolo).toBe("c4671d76-df94-11ed-2057-43d4fd632fad");
    rmSync(dir, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  });
});

describe("amico router — the cloud verb (#460): the thin client, routed", () => {
  // Async spawn, NOT the sync run() helper: the child calls BACK into this
  // worker's FakeCloud over HTTP, and execFileSync would block the worker's
  // event loop — the fake could never answer, and parent+child would deadlock.
  const runAsync = (args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> =>
    new Promise((resolveP, rejectP) => {
      execFile(
        "node",
        [BUNDLE, ...args],
        { encoding: "utf8", timeout: 30_000, env: { ...process.env, ...hermeticOpsEnv(), ...env } },
        (err, stdout, stderr) => {
          if (err && err.code === undefined && (err as Error & { killed?: boolean }).killed) rejectP(err);
          else resolveP({ code: err ? (err.code as number) : 0, stdout: stdout ?? "", stderr: stderr ?? "" });
        },
      );
    });

  it("submit + status through the built bundle against FakeCloud (env-pair config)", async () => {
    const fake = new FakeCloud();
    await fake.start();
    try {
      const root = tmpRoot();
      const env = { AMICO_CLOUD_URL: fake.base, AMICO_CLOUD_TOKEN: fake.token };
      const s = await runAsync(["cloud", "submit", fakeJulia(root, "s.jl", "// body")], env);
      expect(s.code).toBe(0);
      const submitted = JSON.parse(s.stdout);
      expect(submitted).toMatchObject({ verb: "cloud", subcommand: "submit", ok: true, task_id: fake.taskId });

      fake.state.task_status = "Running";
      const st = await runAsync(["cloud", "status", "--task", fake.taskId], env);
      expect(st.code).toBe(0);
      expect(JSON.parse(st.stdout)).toMatchObject({ ok: true, task_status: "Running", terminal: false });

      expect((await runAsync(["cloud", "nope"], env)).code).toBe(64); // unknown subcommand → usage
    } finally {
      await fake.stop();
    }
  });
  it("no cloud config → one honest JSON failure line, exit 64 (the #423-era reality)", () => {
    const r = run(["cloud", "status", "--task", "t-1"], {
      AMICO_CLOUD_FILE: "/nonexistent/amico-test/cloud.json",
      AMICO_CLOUD_URL: "",
      AMICO_CLOUD_TOKEN: "",
    });
    expect(r.code).toBe(64);
    const j = JSON.parse(r.stdout);
    expect(j.ok).toBe(false);
    expect(j.errors[0]).toContain("cloud config not found");
  });
});

describe("amico router — spine verbs vault/device/note are REAL (B3), no longer stubs", () => {
  // The ROUTER seam only: an unknown subcommand routes into the real body (→ usage
  // error, exit 64, no `stub` marker). The per-verb bodies are covered end-to-end in
  // vault_verb / device_verb / note_verb test files.
  for (const name of ["vault", "device", "note"]) {
    it(`${name} routes to its real body: unknown subcommand → usage error, exit 64, no stub`, () => {
      const r = run([name, "frobnicate"]);
      expect(r.code).toBe(64);
      const out = JSON.parse(r.stdout);
      expect(out.verb).toBe(name);
      expect(out.stub).toBeUndefined();
      expect(out.error).toMatch(/unknown subcommand/);
    });
  }
  it("device status routes to the real body (no graph → uncharacterized + 64)", () => {
    const root = mkdtempSync(join(tmpdir(), "amico-router-dev-"));
    const r = run(["device", "status", "--device", "ghost"], { AMICO_DEVICE_DIR: root });
    expect(r.code).toBe(64);
    expect(JSON.parse(r.stdout)).toMatchObject({ verb: "device", subcommand: "status", overall: "uncharacterized" });
    rmSync(root, { recursive: true, force: true });
  });
  it("vault query routes to the real body (empty vault → count 0, exit 0)", () => {
    const dir = mkdtempSync(join(tmpdir(), "amico-router-vault-"));
    const r = run(["vault", "query", "--q", "anything"], { AMICO_VAULT_DIR: dir });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ verb: "vault", subcommand: "query", count: 0 });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("amico router — catalog is REAL (B2), no longer a stub", () => {
  it("catalog with no subcommand → usage error, exit 64", () => {
    const r = run(["catalog"]);
    expect(r.code).toBe(64);
    const out = JSON.parse(r.stdout);
    expect(out.verb).toBe("catalog");
    expect(out.stub).toBeUndefined();
    expect(out.error).toMatch(/unknown subcommand/);
  });
  it("catalog query routes to the repertoire body (empty catalog → count 0, exit 0)", () => {
    const empty = mkdtempSync(join(tmpdir(), "amico-cat-empty-"));
    const r = run(["catalog", "query", "--platform", "transmon", "--kind", "X"], { AMICO_CATALOG_DIR: empty });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out).toMatchObject({ verb: "catalog", subcommand: "query", platform: "transmon", gate: "X", count: 0 });
    expect(out.incumbent).toBeNull();
    rmSync(empty, { recursive: true, force: true });
  });
  it("catalog ingest blocks when verification did not agree, exit 64", () => {
    const empty = mkdtempSync(join(tmpdir(), "amico-cat-ingest-"));
    const pulse = join(empty, "pulse.jld2");
    writeFileSync(pulse, "binary");
    const r = run(
      ["catalog", "ingest", "--platform", "transmon", "--kind", "X", "--artifact", pulse, "--fidelity", "0.99", "--agree", "false"],
      { AMICO_CATALOG_DIR: join(empty, "pulses") },
    );
    expect(r.code).toBe(64);
    const out = JSON.parse(r.stdout);
    expect(out).toMatchObject({ verb: "catalog", subcommand: "ingest", promoted: false, blocked: true });
    rmSync(empty, { recursive: true, force: true });
  });
});

describe("amico router — mcp-serve facade", () => {
  it("--list renders each spine verb as an MCP tool, exit 0", () => {
    const r = run(["mcp-serve", "--list"]);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    const names = out.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(["amico_catalog", "amico_vault", "amico_device", "amico_note"]),
    );
  });
  it("no flag → stub note + tool list, exit 0 (cleanly)", () => {
    const r = run(["mcp-serve"]);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.stub).toBe(true);
    expect(out.tools).toEqual(expect.arrayContaining(["amico_catalog"]));
  });
});

describe("amico router — doctor v2 (surface inventory, #525)", () => {
  it("doctor --json with injected roots emits the canonical machine contract", () => {
    const w = buildDoctorWorld();
    const r = run([
      "doctor",
      "--json",
      "--root-server", w.server,
      "--root-vscext", w.vscext,
      "--root-config", w.config,
      "--root-repo-amicode", w.repoAmicode,
      "--root-repo-fork", w.repoFork,
      "--root-staging", w.staging,
      "--running-binary", w.running,
    ]);
    // exit reflects the v1 studio binding only (machine-dependent); the
    // surfaces contract is asserted on stdout, which must be JSON-only
    const report = JSON.parse(r.stdout);
    expect(report.surfaces).toHaveLength(6);
    expect(report.surfaces.every((s: { verdict: string }) => s.verdict === "current")).toBe(true);
    expect(validateDoctorReport(report).ok).toBe(true);
    // canonical form: 2-space indent + trailing newline
    expect(r.stdout.endsWith("\n")).toBe(true);
    expect(r.stdout.split("\n")[1]).toBe('  "surfaces": [');
    cleanupTracked();
  });

  it("doctor (human) prints the v1 binding table plus the surfaces section", () => {
    const w = buildDoctorWorld();
    const r = run([
      "doctor",
      "--root-server", w.server,
      "--root-vscext", w.vscext,
      "--root-config", w.config,
      "--root-repo-amicode", w.repoAmicode,
      "--root-repo-fork", w.repoFork,
      "--root-staging", w.staging,
      "--running-binary", w.running,
    ]);
    expect(r.stdout).toMatch(/studio binding/); // v1 section intact
    expect(r.stdout).toMatch(/^surfaces:$/m); // v2 section gained
    expect(r.stdout).toMatch(/server-binary/);
    cleanupTracked();
  });
});
