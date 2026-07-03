import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Dir to prepend to opencode's PATH so `amico-run` resolves.
 *  Packaged: <ext>/bin/launcher (staged by esbuild). Dev: workspace sibling. */
export function resolveAmicoRunBinDir(extensionRoot: string): string | undefined {
  const staged = join(extensionRoot, "bin", "launcher");
  if (existsSync(join(staged, "amico-run"))) return staged;
  const sibling = join(extensionRoot, "..", "amico-run", "launcher");
  if (existsSync(join(sibling, "amico-run"))) return sibling;
  return undefined;
}

/** Runs root the inspector watches; must match where amico-run writes.
 *  Empty config → ~/.amico/runs/default (amico-run's β.1 default lab). */
export function resolveRunsRoot(configValue: string): string {
  const v = (configValue ?? "").trim();
  if (v === "") return join(homedir(), ".amico", "runs", "default");
  if (v === "~") return homedir();
  if (v.startsWith("~/")) return join(homedir(), v.slice(2));
  return v;
}

/** Local resource roots the inspector webview may load. Extension assets only
 *  (script bundle + stylesheets) — the view renders the pulse natively from
 *  message data (#66), so no run-dir file access is granted. */
export function inspectorResourceRootDirs(extensionRoot: string): string[] {
  return [join(extensionRoot, "dist"), join(extensionRoot, "media")];
}
