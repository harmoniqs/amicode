#!/usr/bin/env node
// Build the tier-2 exemplars index (spec C). Aggregates the in-repo
// exemplars/EXEMPLARS.toml ∪ every $AMICODE_DEMOS_ROOT/*/EXEMPLARS.toml
// (absent → in-repo only, CI-safe). External scripts are COPIED into
// exemplars/<id>/ and their `path` rewritten extension-relative, so tier 2
// works for users without local demo clones (spec: "bundles the index AND the
// referenced exemplar scripts as extension assets"). Each entry gets a masked
// baseline_hash — the SAME mask+sha the amico-run gate recomputes at launch
// (deliberately reimplemented here to keep the build dep-free of amico-run;
// test/exemplars_build.test.ts cross-checks the two via a shared fixture).
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, copyFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseToml } from 'smol-toml'

const here = dirname(fileURLToPath(import.meta.url))
const exemplarsDir = join(here, '..', 'exemplars')

// Masked baseline: interior lines between the fill markers → "#MASKED"; marker
// lines kept; unterminated block masks to EOF. MUST match amico-run/src/baseline.ts.
const DEFAULT_BEGIN = /^# ── FILL IN/
const DEFAULT_END = /^# ─────/
function maskFillPoints(text, beginSrc, endSrc) {
  const begin = beginSrc ? new RegExp(beginSrc) : DEFAULT_BEGIN
  const end = endSrc ? new RegExp(endSrc) : DEFAULT_END
  const out = []
  let inside = false
  for (const line of text.split('\n')) {
    if (!inside && begin.test(line)) { inside = true; out.push(line); continue }
    if (inside && end.test(line)) { inside = false; out.push(line); continue }
    out.push(inside ? '#MASKED' : line)
  }
  return out.join('\n')
}
function maskedHash(text, beginSrc, endSrc) {
  return 'sha256:' + createHash('sha256').update(maskFillPoints(text, beginSrc, endSrc)).digest('hex')
}

function readEntries(tomlFile) {
  if (!existsSync(tomlFile)) return []
  const parsed = parseToml(readFileSync(tomlFile, 'utf8'))
  return Array.isArray(parsed.exemplar) ? parsed.exemplar : []
}

const exemplars = []

// 1. in-repo entries — scripts already live under exemplars/, paths are as-authored
for (const entry of readEntries(join(exemplarsDir, 'EXEMPLARS.toml'))) {
  const scriptPath = join(exemplarsDir, entry.path)
  if (!existsSync(scriptPath)) { console.error(`build_exemplars: missing in-repo script ${entry.path}`); process.exit(1) }
  const text = readFileSync(scriptPath, 'utf8')
  exemplars.push({ ...entry, baseline_hash: maskedHash(text, entry.fill_begin, entry.fill_end) })
}

// 2. external demo-repo entries — copy the script in-tree, rewrite path
const demosRoot = process.env.AMICODE_DEMOS_ROOT
if (demosRoot && existsSync(demosRoot)) {
  for (const demo of readdirSync(demosRoot, { withFileTypes: true })) {
    if (!demo.isDirectory()) continue
    const tomlFile = join(demosRoot, demo.name, 'EXEMPLARS.toml')
    for (const entry of readEntries(tomlFile)) {
      const srcScript = join(demosRoot, demo.name, entry.path)
      if (!existsSync(srcScript)) { console.error(`build_exemplars: missing demo script ${demo.name}/${entry.path}`); continue }
      const destRel = join(entry.id, 'script.jl')
      const destAbs = join(exemplarsDir, destRel)
      mkdirSync(dirname(destAbs), { recursive: true })
      copyFileSync(srcScript, destAbs)
      const text = readFileSync(destAbs, 'utf8')
      exemplars.push({ ...entry, path: destRel, baseline_hash: maskedHash(text, entry.fill_begin, entry.fill_end) })
    }
  }
}

writeFileSync(join(exemplarsDir, 'index.json'), JSON.stringify({ schema_version: 1, exemplars }, null, 2) + '\n')
console.log(`build_exemplars: wrote index.json (${exemplars.length} exemplar${exemplars.length === 1 ? '' : 's'})`)
