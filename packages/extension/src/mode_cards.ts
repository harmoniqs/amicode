/** Mode-card staging (#533, generalized #761).
 *
 *  Opencode discovers agent mode cards by globbing {agent,agents}/ *.md
 *  from each config Directory entry — notably from the global config dir
 *  `~/.config/opencode/`. The extension's per-session `opencode-project/` is
 *  delivered as an `instructions` Document reference, NOT a Directory, so
 *  agent discovery never globs it.
 *
 *  This module stages EVERY card in the package's agents directory (the two
 *  directors + the five workers) into the global config agents directory on
 *  every activation — the same always-copy semantics as `pasqal_assets.ts`.
 *  When the premium entitlement is present and an overlay source resolves,
 *  method-class overlay fields are merged into the base cards before staging
 *  (precedence: public base < entitled overlay); provenance lands in a
 *  staging receipt, never in the staged card. Failures throw; the activation
 *  caller catches and logs (staging must never kill activation). */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";

/** Staging options (#761). Injectable for hermetic tests; production calls
 *  use the defaults (the machine's real entitlements + overlay ladder). */
export interface StageOptions {
  /** Resolved entitlement codes; null resolves the machine's real set. */
  entitlements?: string[] | null;
  /** Directory holding entitlements.toml (default ~/.amico/amicode). */
  entitlementConfigDir?: string;
  /** Explicit overlay source root (config); null walks the resolution
   *  ladder, undefined = same as null. */
  overlaySource?: string | null;
  /** Clock injection (receipt timestamps); default real time. */
  now?: () => string;
}

/** The global opencode agents directory where mode cards land. */
export function globalAgentsDir(): string {
  return path.join(os.homedir(), ".config", "opencode", "agents");
}

/** Every mode-card markdown file shipped in <extensionPath>/agents/, sorted.
 *  #761: staging covers every card in the package's agents directory — the
 *  fixed two-file list is gone; a new shipped card stages automatically. */
export function listModeCardFiles(extensionPath: string): string[] {
  const srcDir = path.join(extensionPath, "agents");
  let entries: string[];
  try {
    entries = fs.readdirSync(srcDir);
  } catch {
    throw new Error(
      `no mode cards found in ${srcDir} — the extension bundle must ship ` +
        `autodev.md, autoresearch.md, and the worker cards ` +
        `(packaging dropped the agents dir: .vscodeignore?)`,
    );
  }
  const cards = entries.filter((f) => f.endsWith(".md")).sort();
  if (cards.length === 0) {
    throw new Error(
      `no mode cards found in ${srcDir} — the extension bundle must ship ` +
        `autodev.md, autoresearch.md, and the worker cards ` +
        `(packaging dropped the agents dir: .vscodeignore?)`,
    );
  }
  return cards;
}

/** Copy the shipped mode cards into ~/.config/opencode/agents/, writing a
 *  staging receipt (provenance) next to the staged cards. Returns what landed
 *  where (for the activation log line). */
export function stageModCards(
  extensionPath: string,
  destDir: string = globalAgentsDir(),
  opts: StageOptions = {},
): { dir: string; staged: string[]; receiptPath: string } {
  const srcDir = path.join(extensionPath, "agents");
  fs.mkdirSync(destDir, { recursive: true });
  const staged: string[] = [];
  const cardRecords: Array<Record<string, unknown>> = [];
  const nowIso = opts.now ?? (() => new Date().toISOString());
  for (const f of listModeCardFiles(extensionPath)) {
    const src = path.join(srcDir, f);
    if (!fs.existsSync(src))
      throw new Error(
        `mode card missing from the extension: ${src} — packaging dropped it (.vscodeignore)`,
      );
    const bytes = fs.readFileSync(src);
    fs.writeFileSync(path.join(destDir, f), bytes);
    staged.push(f);
    cardRecords.push({
      card: f,
      base_sha256: "sha256:" + createHash("sha256").update(bytes).digest("hex"),
      overlay_id: null,
      merged_fields: [] as string[],
    });
  }
  const receiptPath = path.join(destDir, ".staging-receipt.json");
  fs.writeFileSync(
    receiptPath,
    JSON.stringify(
      {
        receipt_version: 1,
        staged_at: nowIso(),
        dir: destDir,
        cards: cardRecords,
      },
      null,
      2,
    ) + "\n",
  );
  return { dir: destDir, staged, receiptPath };
}
