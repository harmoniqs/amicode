// packages/amico-run/test/pasqal_cli.test.ts — the `amico-pasqal` BIN end-to-end
// (issue #168): esbuild bundle → node dist/amico-pasqal.js, the cli.test.ts idiom.
// The unit contract lives in pasqal_launch.test.ts; this file proves the wiring —
// entry point, exit-code relay, stderr carriage — through the shipped artifact.
import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpRoot } from "./helpers.js";

const BUNDLE = join(__dirname, "..", "dist", "amico-pasqal.js");
beforeAll(() => {
  execFileSync("node", [join(__dirname, "..", "esbuild.config.mjs")], { cwd: join(__dirname, "..") });
});

const TOKEN = "tok-sekret-bin-layer";
const PROJECT = "proj-bin-layer";

function run(args: string[], env: Record<string, string> = {}): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("node", [BUNDLE, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

describe("amico-pasqal bin (bundle e2e)", () => {
  it("happy lane: env-injects the credential pair into the connector, exit 0, silent stderr", () => {
    const root = tmpRoot();
    const out = join(root, "record.json");
    const shim = join(root, "fake-python");
    writeFileSync(
      shim,
      `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify({ argv: process.argv, env: process.env }));\n`,
    );
    chmodSync(shim, 0o755);
    const cred = join(root, "pasqal.json");
    writeFileSync(cred, JSON.stringify({ project_id: PROJECT, token: TOKEN }, null, 2) + "\n");
    const script = join(root, "connector.py");
    writeFileSync(script, "# fake connector\n");

    const r = run([script, "--devices", "FRESNEL"], { AMICO_PASQAL_FILE: cred, AMICO_PYTHON: shim });
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    const rec = JSON.parse(readFileSync(out, "utf8")) as { argv: string[]; env: Record<string, string> };
    expect(rec.env.PASQAL_TOKEN).toBe(TOKEN);
    expect(rec.env.PASQAL_PROJECT_ID).toBe(PROJECT);
    expect(rec.argv.slice(2)).toEqual([script, "--devices", "FRESNEL"]);
    for (const a of rec.argv) expect(a).not.toContain(TOKEN); // AC2 holds at the bin layer too
  });

  it("missing credential file → 64, 'not connected … Connections panel' on stderr", () => {
    const root = tmpRoot();
    const script = join(root, "connector.py");
    writeFileSync(script, "# fake connector\n");
    const r = run([script], { AMICO_PASQAL_FILE: join(root, "absent.json") });
    expect(r.code).toBe(64);
    expect(r.stderr).toMatch(/not connected/);
    expect(r.stderr).toMatch(/Connections panel/);
  });

  it("--help → 0 and documents the env-only contract; a bare call is a usage error (64)", () => {
    const help = run(["--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toMatch(/PASQAL_TOKEN, PASQAL_PROJECT_ID/);
    expect(help.stdout).toMatch(/ENV ONLY/);
    expect(run([]).code).toBe(64);
  });

  it("the bin is declared and its launcher script exists (package wiring)", () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as {
      bin: Record<string, string>;
    };
    expect(pkg.bin["amico-pasqal"]).toBe("./launcher/amico-pasqal");
    expect(existsSync(join(__dirname, "..", "launcher", "amico-pasqal"))).toBe(true);
  });
});
