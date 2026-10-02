// fleet_enroll_command.test.ts (#1319) — the `amicode.fleet.enroll` command:
// contributed, registered, and never-fork. A source-guard + manifest test in
// the fleet_never_fork.test.ts idiom (readFileSync + assert): the command must
// exist as a first-class VS Code command and its handler must NOT spawn a local
// engine — it delegates to `amico fleet enroll` (the verb installs the guard).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(__dirname, "..", "src", "extension.ts");
const PKG = join(__dirname, "..", "package.json");

/** Slice out a named handler's body (`const NAME = async …` up to the next
 *  top-level `const NAME2 =` / `ctx.subscriptions`), the fleet_never_fork idiom. */
function handlerBody(src: string, name: string): string {
  const start = src.indexOf(`const ${name}`);
  if (start < 0) return "";
  const rest = src.slice(start);
  const end = rest.indexOf("\n  ctx.subscriptions.push(vscode.commands.registerCommand");
  return rest.slice(0, end === -1 ? 4000 : end);
}

describe("amicode.fleet.enroll command (#1319)", () => {
  it("is contributed in package.json with a title", () => {
    const pkg = JSON.parse(readFileSync(PKG, "utf8")) as {
      contributes?: { commands?: { command: string; title?: string }[] };
    };
    const cmd = (pkg.contributes?.commands ?? []).find((c) => c.command === "amicode.fleet.enroll");
    expect(cmd, "amicode.fleet.enroll must be contributed").toBeTruthy();
    expect(typeof cmd?.title).toBe("string");
    expect(cmd?.title?.length).toBeGreaterThan(0);
  });

  it("is registered via registerCommand in extension.ts", () => {
    const s = readFileSync(SRC, "utf8");
    expect(s).toMatch(/registerCommand\(\s*["']amicode\.fleet\.enroll["']/);
  });

  it("the enroll handler delegates to `amico fleet enroll` — the verb path, not a local engine", () => {
    const body = handlerBody(readFileSync(SRC, "utf8"), "runFleetEnroll");
    expect(body).not.toBe("");
    expect(body).toMatch(/fleet enroll/); // it drives the enroll verb
  });

  it("never-fork: the enroll handler spawns NO local engine (no ServerManager / .start())", () => {
    const body = handlerBody(readFileSync(SRC, "utf8"), "runFleetEnroll");
    expect(body).not.toBe("");
    // a client enrolls by installing the guard (via the verb), never by
    // cold-spawning an engine — the ADR-0005 never-fork invariant.
    expect(body).not.toMatch(/new ServerManager/);
    expect(body).not.toMatch(/\.start\(\)/);
  });

  it("the join token is a secret — the handler never logs its value", () => {
    const body = handlerBody(readFileSync(SRC, "utf8"), "runFleetEnroll");
    expect(body).not.toBe("");
    // no channel/console line interpolates the raw token variable
    expect(body).not.toMatch(/appendLine\([^)]*\$\{\s*token\s*\}/);
    expect(body).not.toMatch(/console\.\w+\([^)]*\btoken\b/);
  });
});
