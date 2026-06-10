#!/usr/bin/env node
// Download-at-build vendoring of the opencode chat-server binary, pinned by
// opencode.lock.json (spec §2/§3). Importable module + CLI in one file.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  renameSync, rmSync, writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

export function loadManifest(root = PKG_ROOT) {
  const m = JSON.parse(readFileSync(join(root, 'opencode.lock.json'), 'utf8'))
  if (typeof m.version !== 'string' || m.version === '') throw new Error('manifest: version must be a non-empty string')
  const platforms = m.platforms ?? {}
  if (Object.keys(platforms).length === 0) throw new Error('manifest: platforms missing')
  for (const [key, p] of Object.entries(platforms)) {
    if (typeof p.asset !== 'string' || p.asset === '') throw new Error(`manifest: ${key}.asset missing`)
    if (!/^[0-9a-f]{64}$/.test(p.sha256 ?? '')) throw new Error(`manifest: ${key}.sha256 must be 64 hex chars`)
  }
  return m
}

export function resolvePlatform(manifest, flag) {
  const key = flag ?? `${process.platform}-${process.arch}`
  if (!(key in manifest.platforms)) {
    throw new Error(`platform ${key} not supported (supported: ${Object.keys(manifest.platforms).join(', ')})`)
  }
  return key
}

export function assetUrl(manifest, platform) {
  return `https://github.com/sst/opencode/releases/download/v${manifest.version}/${manifest.platforms[platform].asset}`
}

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
