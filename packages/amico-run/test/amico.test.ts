// Router-dispatch tests for the `amico` verb router (issue #108). The launch/resolve/
// sandbox BODIES are already covered by cli.test.ts + subcommands.test.ts against the
// amico-run bundle; these tests assert the ROUTER seam: verb routing, --help surface,
// unknown-verb → 64, verbatim delegation of run/resolve/sandbox, and the stub verbs +
// mcp-serve facade. Run: `pnpm --filter @amicode/amico-run test`.
import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tmpRoot, fakeJulia, readToml } from "./helpers.js";

const BUNDLE = join(__dirname, "..", "dist", "amico.js");
beforeAll(() => {
  execFileSync("node", [join(__dirname, "..", "esbuild.config.mjs")], { cwd: join(__dirname, "..") });
});

function run(args: string[], env: Record<string, string> = {}): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("node", [BUNDLE, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
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
    for (const v of ["run", "resolve", "sandbox", "catalog", "vault", "device", "note", "mcp-serve"]) {
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

describe("amico router — spine verbs are B1 stubs (print intent, exit 0)", () => {
  for (const name of ["catalog", "vault", "device", "note"]) {
    it(`${name} routes, prints stub intent JSON, exits 0`, () => {
      const r = run([name, "some", "args"]);
      expect(r.code).toBe(0);
      const out = JSON.parse(r.stdout);
      expect(out).toMatchObject({ verb: name, stub: true });
      expect(out.args).toEqual(["some", "args"]);
      expect(typeof out.intent).toBe("string");
    });
  }
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
  it("no flag → stands up the real stdio server, exits 0 on stdin EOF (empty stdin)", () => {
    // The real facade (B5) blocks on stdin serving the MCP protocol; feeding an immediate
    // EOF (empty input) is a disconnected client → the server shuts down and exits cleanly.
    // stdout is the MCP JSON-RPC channel, so with no client messages it stays silent. The
    // full protocol round-trip (tools/list + tools/call over real stdio) lives in
    // mcp_serve.test.ts. A timeout guards against a regression that would hang the server.
    const out = execFileSync("node", [BUNDLE, "mcp-serve"], { encoding: "utf8", input: "", timeout: 20000 });
    expect(out).toBe("");
  });
});
