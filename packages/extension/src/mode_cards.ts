/** Mode-card staging (#533).
 *
 *  Opencode discovers agent mode cards by globbing {agent,agents}/ *.md
 *  from each config Directory entry — notably from the global config dir
 *  `~/.config/opencode/`. The extension's per-session `opencode-project/` is
 *  delivered as an `instructions` Document reference, NOT a Directory, so
 *  agent discovery never globs it.
 *
 *  This module stages the shipped mode cards (autodev, autoresearch) into the
 *  global config agents directory on every activation — the same always-copy
 *  semantics as `pasqal_assets.ts`. Failures throw; the activation caller
 *  catches and logs (staging must never kill activation). */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

/** The mode-card markdown files shipped in packages/extension/agents/. */
export const MODE_CARD_FILES = ["autodev.md", "autoresearch.md"] as const;

/** The global opencode agents directory where mode cards land. */
export function globalAgentsDir(): string {
  return path.join(os.homedir(), ".config", "opencode", "agents");
}

/** Copy the shipped mode cards into ~/.config/opencode/agents/. Returns what
 *  landed where (for the activation log line). */
export function stageModCards(
  extensionPath: string,
  destDir: string = globalAgentsDir(),
): { dir: string; staged: string[] } {
  const srcDir = path.join(extensionPath, "agents");
  fs.mkdirSync(destDir, { recursive: true });
  const staged: string[] = [];
  for (const f of MODE_CARD_FILES) {
    const src = path.join(srcDir, f);
    if (!fs.existsSync(src))
      throw new Error(
        `mode card missing from the extension: ${src} — packaging dropped it (.vscodeignore)`,
      );
    fs.copyFileSync(src, path.join(destDir, f));
    staged.push(f);
  }
  return { dir: destDir, staged };
}
