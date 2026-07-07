import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";

export function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "amico-run-test-"));
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
