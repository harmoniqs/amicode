// Masked baseline (spec C tier-2 demotion detection) — sha256 of a script
// with every line strictly BETWEEN the fill-point markers replaced by
// "#MASKED" (the marker lines themselves are kept). Fill-point edits are
// invariant; any edit outside them changes the hash, which the gate treats
// as "no longer the exemplar's physics". Default markers are the template
// convention's `# ── FILL IN` / `# ─────` pair; an index entry may override
// with fill_begin/fill_end regex sources. Unterminated blocks mask to EOF
// (conservative: an attacker deleting the end marker can't unmask anything).
import { createHash } from "node:crypto";

const DEFAULT_BEGIN = "^# ── FILL IN";
const DEFAULT_END = "^# ─────";

export function maskFillPoints(text: string, beginSource?: string, endSource?: string): string {
  const begin = new RegExp(beginSource ?? DEFAULT_BEGIN);
  const end = new RegExp(endSource ?? DEFAULT_END);
  const out: string[] = [];
  let inside = false;
  for (const line of text.split("\n")) {
    if (!inside && begin.test(line)) {
      inside = true;
      out.push(line);
      continue;
    }
    if (inside && end.test(line)) {
      inside = false;
      out.push(line);
      continue;
    }
    out.push(inside ? "#MASKED" : line);
  }
  return out.join("\n");
}

export function maskedHash(text: string, beginSource?: string, endSource?: string): string {
  return (
    "sha256:" +
    createHash("sha256")
      .update(maskFillPoints(text, beginSource, endSource))
      .digest("hex")
  );
}
