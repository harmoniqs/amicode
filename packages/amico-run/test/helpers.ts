import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";

export function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "amico-run-test-"));
}

/** Env every CLI-spawning test should start from, so the suite never inherits
 *  the DEVELOPER's amicode state. Without this, a machine whose solver-mode.json
 *  says `hp` fails every local-solve test — Piccolissimo + Altissimo refuses a
 *  local launch — which is correct behaviour reported as a bogus test failure
 *  (found exactly that way, 2026-07-28). Points at an empty temp dir: absent
 *  files are the fresh-install state every reader already fails safe to.
 *  Spread it BEFORE per-test overrides so a test can still opt into an ops dir. */
export function hermeticOpsEnv(): { AMICODE_OPS_DIR: string } {
  return { AMICODE_OPS_DIR: mkdtempSync(join(tmpdir(), "amico-run-ops-")) };
}

export function readToml(path: string): Record<string, unknown> {
  return parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

/** Create an executable fake-julia "binary" (node script via shebang). It receives
 *  the julia argv (flags + script path) and ignores it unless the body uses it. */
export function fakeJulia(dir: string, name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}
