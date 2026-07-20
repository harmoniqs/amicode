// packages/amico-run/test/pasqal_launch.test.ts — the amico-pasqal launcher (issue #168, 159/S8).
// SECURITY CONTRACT under test: the Pasqal token travels to the connector in ENV ONLY
// (PASQAL_TOKEN + PASQAL_PROJECT_ID) — never in any argv at any layer (ps-visible,
// transcript-persisted), and never in an error message. The fake-interpreter shim
// records its argv + env to a file so the assertions are adversarial, not trusting.
import { describe, it, expect } from "vitest";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpRoot } from "./helpers.js";
import {
  pasqalCredentialFile,
  pasqalLaunch,
  readPasqalCredentials,
  resolvePasqalInterpreter,
} from "../src/pasqal_launch.js";
import { ConfigError } from "../src/types.js";

const TOKEN = "tok-sekret-do-not-print";
const PROJECT = "proj-11111111-2222-3333-4444-555555555555";

/** Write a valid credential file (2-space JSON + trailing newline, the at-rest shape). */
function credFile(dir: string, overrides: Record<string, unknown> = {}): string {
  const p = join(dir, "pasqal.json");
  const body = { project_id: PROJECT, token: TOKEN, expires_at: "2099-01-01T00:00:00Z", ...overrides };
  writeFileSync(p, JSON.stringify(body, null, 2) + "\n");
  return p;
}

/** Fake-interpreter shim: an executable that records {argv, env} to outFile, then runs body.
 *  The record path is BAKED INTO the script — the minimal child env carries no test plumbing. */
function fakeInterpreter(dir: string, name: string, outFile: string, body = ""): string {
  const p = join(dir, name);
  writeFileSync(
    p,
    `#!/usr/bin/env node\n` +
      `require("node:fs").writeFileSync(${JSON.stringify(outFile)}, ` +
      `JSON.stringify({ argv: process.argv, env: process.env }));\n` +
      `${body}\n`,
  );
  chmodSync(p, 0o755);
  return p;
}

/** A do-nothing connector script for the shim to "run". */
function connectorScript(dir: string): string {
  const p = join(dir, "connector.py");
  writeFileSync(p, "# fake pasqal connector\n");
  return p;
}

/** Hermetic launch env: only what the test explicitly grants. PATH is passed through so
 *  the node-shebang shim resolves; a canary proves nothing else may leak into the child. */
function launchEnv(cred: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    AMICO_PASQAL_FILE: cred,
    AMICO_TEST_CANARY: "must-never-reach-the-child",
    ...extra,
  } as NodeJS.ProcessEnv;
}

describe("amico-pasqal launcher — AC1: exact env contract via fake-interpreter shim", () => {
  it("spawns <python> <connector-script> [passthrough] with EXACTLY the minimal child env", async () => {
    const root = tmpRoot();
    const out = join(root, "record.json");
    const shim = fakeInterpreter(root, "fake-python", out);
    const cred = credFile(root);
    const script = connectorScript(root);

    const code = await pasqalLaunch([script, "--devices", "FRESNEL"], launchEnv(cred, { AMICO_PYTHON: shim }));
    expect(code).toBe(0);

    const rec = JSON.parse(readFileSync(out, "utf8")) as { argv: string[]; env: Record<string, string> };
    // env carries the credential pair (the declared contract, slice #164)
    expect(rec.env.PASQAL_TOKEN).toBe(TOKEN);
    expect(rec.env.PASQAL_PROJECT_ID).toBe(PROJECT);
    // MINIMAL env: PATH + the two PASQAL vars and NOTHING else (never a process.env spread).
    // Keys starting with "_" are platform noise (e.g. macOS __CF_*), not launcher carriage.
    const keys = Object.keys(rec.env).filter((k) => !k.startsWith("_"));
    expect(keys.sort()).toEqual(["PASQAL_PROJECT_ID", "PASQAL_TOKEN", "PATH"]);
    expect(rec.env.AMICO_TEST_CANARY).toBeUndefined();
    expect(rec.env.AMICO_PASQAL_FILE).toBeUndefined();
    // argv: exactly the connector script + passthrough args, nothing injected
    expect(rec.argv.slice(2)).toEqual([script, "--devices", "FRESNEL"]);
  });

  it("resolves python3 from PATH when AMICO_PYTHON is unset (first hit wins)", async () => {
    const root = tmpRoot();
    const bin = join(root, "bin");
    mkdirSync(bin);
    const out = join(root, "record.json");
    fakeInterpreter(bin, "python3", out);
    const cred = credFile(root);
    const script = connectorScript(root);

    const env = launchEnv(cred);
    env.PATH = `${bin}${delimiter}${process.env.PATH}`;
    const code = await pasqalLaunch([script], env);
    expect(code).toBe(0);
    const rec = JSON.parse(readFileSync(out, "utf8")) as { argv: string[] };
    // the launcher spawned OUR python3 (resolved to its absolute path), not some other one
    expect(rec.argv[1]).toBe(join(bin, "python3"));
  });

  it("child exit code passes through verbatim (connector exit-3 'unreachable' stays 3)", async () => {
    const root = tmpRoot();
    const out = join(root, "record.json");
    const shim = fakeInterpreter(root, "fake-python", out, "process.exit(3);");
    const code = await pasqalLaunch([connectorScript(root)], launchEnv(credFile(root), { AMICO_PYTHON: shim }));
    expect(code).toBe(3);
  });

  it("expires_at is optional — a credential file without it launches", async () => {
    const root = tmpRoot();
    const out = join(root, "record.json");
    const shim = fakeInterpreter(root, "fake-python", out);
    const p = join(root, "pasqal.json");
    writeFileSync(p, JSON.stringify({ project_id: PROJECT, token: TOKEN }, null, 2) + "\n");
    const code = await pasqalLaunch([connectorScript(root)], launchEnv(p, { AMICO_PYTHON: shim }));
    expect(code).toBe(0);
    expect(existsSync(out)).toBe(true);
  });

  it("default credential path is ~/.amico/pasqal.json; $AMICO_PASQAL_FILE overrides", () => {
    expect(pasqalCredentialFile({} as NodeJS.ProcessEnv)).toMatch(/\.amico\/pasqal\.json$/);
    expect(pasqalCredentialFile({ AMICO_PASQAL_FILE: "/x/y.json" } as NodeJS.ProcessEnv)).toBe("/x/y.json");
  });
});

describe("amico-pasqal launcher — AC2: no secret in any argv at any layer (adversarial)", () => {
  it("no recorded argv element contains the token (or any part of it)", async () => {
    const root = tmpRoot();
    const out = join(root, "record.json");
    const shim = fakeInterpreter(root, "fake-python", out);
    const code = await pasqalLaunch(
      [connectorScript(root), "--devices", "FRESNEL"],
      launchEnv(credFile(root), { AMICO_PYTHON: shim }),
    );
    expect(code).toBe(0);
    const rec = JSON.parse(readFileSync(out, "utf8")) as { argv: string[] };
    for (const a of rec.argv) {
      expect(a).not.toContain(TOKEN);
      expect(a).not.toContain("sekret"); // no substring smuggling either
    }
  });

  it("the launcher accepts NO secret-bearing flags — a leading flag is a usage error, nothing spawns", async () => {
    const root = tmpRoot();
    const out = join(root, "record.json");
    const shim = fakeInterpreter(root, "fake-python", out);
    const code = await pasqalLaunch(
      ["--token", TOKEN, connectorScript(root)],
      launchEnv(credFile(root), { AMICO_PYTHON: shim }),
    );
    expect(code).toBe(64);
    expect(existsSync(out)).toBe(false); // the shim never ran
  });
});
