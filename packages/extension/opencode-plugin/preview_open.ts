// amicode_open_preview (#2130) — let an agent put a file in the side-panel
// Preview, the in-studio replacement for `open -a "Google Chrome" report.html`.
//
// The tool itself only VALIDATES and ANNOUNCES: it resolves the path, checks the
// file exists on this machine (the engine's machine — the same one the app's
// file reads go to), and returns an `AMICODE_PREVIEW {json}` sentinel as its
// LAST line. The app's tool card (ui/src/amicode/preview-open-card.tsx) parses
// that sentinel and, when the call completes live, posts the existing
// session-targeted `preview-file` open (with `refresh: true`, so a file that is
// already open re-reads). Re-opening an old session never re-fires it: the card
// only acts on a running → completed transition it witnessed.
//
// Dependency-free on purpose: imported by BOTH transports (the opencode plugin
// runs in the engine's Bun runtime; the harness-neutral core feeds the MCP
// server), so the description/args/behavior are one definition and the parity
// test can never see them drift.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const PREVIEW_SENTINEL_PREFIX = "AMICODE_PREVIEW ";

/** The Preview's text-file cap (app preview-file-view.tsx MAX_FILE_SIZE). */
export const PREVIEW_TEXT_LIMIT = 1_000_000;
/** The Preview's HTML-page cap (app preview-file-view.tsx MAX_HTML_FILE_SIZE). */
export const PREVIEW_HTML_LIMIT = 16_000_000;

export const PREVIEW_OPEN_DESCRIPTION =
  "Open a file in the user's side-panel Preview, beside this conversation — use this INSTEAD of " +
  "launching an external browser or viewer (`open -a \"Google Chrome\" …`, `open report.pdf`). " +
  "The Preview renders HTML pages (scripts off; local images inlined; the page re-reads itself " +
  "every few seconds while visible, so a dashboard a script keeps rewriting stays live), " +
  "markdown, images (PNG/JPG/SVG/…), PDFs, and shows other files as text. Calling it again on a " +
  "file that is already open brings it to the front and re-reads it. Pass an ABSOLUTE path (or " +
  "~/…) to a file on this machine. For a live HTML dashboard, write plots as files next to the " +
  "page (<img src=\"plots/x.png\">) rather than base64-embedding them, and do not rely on " +
  "<meta http-equiv=refresh> or scripts — the Preview strips both and refreshes on its own.";

export const PREVIEW_OPEN_ARGS = {
  path: {
    type: "string",
    description: "Absolute path (or ~/…) of the file to show in the Preview.",
  },
} as const;

export type PreviewSentinel = { path: string; name: string; bytes: number };

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function limitFor(file: string): { limit: number; kind: string } | undefined {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".html" || ext === ".htm") return { limit: PREVIEW_HTML_LIMIT, kind: "HTML page" };
  // Binary renderers (images, PDFs) have no size cap; everything else is read as text.
  if (/^\.(png|jpe?g|gif|webp|bmp|ico|avif|pdf)$/.test(ext)) return undefined;
  return { limit: PREVIEW_TEXT_LIMIT, kind: "text file" };
}

function mb(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 2 : 1)} MB`;
}

/** Validate + announce. Returns the agent-directed text whose LAST line (on
 *  success) is the sentinel the app's card acts on. Never throws. */
export function executePreviewOpen(a: { path?: unknown }): string {
  const raw = typeof a?.path === "string" ? a.path.trim() : "";
  if (raw === "") return "Not opened: `path` is required (an absolute path or ~/… to a file on this machine).";
  let target = expandHome(raw);
  if (/^file:\/\//i.test(target)) {
    try {
      target = decodeURIComponent(new URL(target).pathname);
    } catch {
      return `Not opened: ${raw} is not a valid file:// URL.`;
    }
  }
  if (!path.isAbsolute(target)) {
    return `Not opened: ${raw} is a relative path — pass an absolute path (or ~/…), e.g. ${path.resolve(target)} if that is the file you mean.`;
  }
  if (target.length > 4096) return "Not opened: the path is longer than 4096 characters.";
  target = path.normalize(target);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch {
    return `Not opened: ${target} does not exist on this machine.`;
  }
  if (stat.isDirectory()) return `Not opened: ${target} is a directory — pass a file inside it.`;
  if (!stat.isFile()) return `Not opened: ${target} is not a regular file.`;

  const cap = limitFor(target);
  const name = path.basename(target);
  const sentinel: PreviewSentinel = { path: target, name, bytes: stat.size };
  let note = "";
  if (cap && stat.size > cap.limit) {
    note =
      ` Warning: it is ${mb(stat.size)}, over the Preview's ${mb(cap.limit)} limit for a ${cap.kind}, ` +
      `so the user will see "File too large to preview" — ` +
      (cap.kind === "HTML page"
        ? "write the plots as separate image files instead of embedding them, then call this again."
        : "write a smaller summary file and open that instead.");
  }
  return (
    `Sent ${name} to the user's Preview (side panel): it opens there now, or comes to the front and ` +
    `re-reads if it was already open.${note}\n` +
    `${PREVIEW_SENTINEL_PREFIX}${JSON.stringify(sentinel)}`
  );
}
