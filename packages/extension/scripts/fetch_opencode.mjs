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

async function defaultDownload(url) {
  let r
  try { r = await fetch(url) } catch (e) {
    throw new Error(`download failed: ${e.message} for ${url}`)   // spec §6: URL on connection failures too
  }
  if (!r.ok) throw new Error(`download failed: HTTP ${r.status} for ${url}`)
  return Buffer.from(await r.arrayBuffer())
}

export async function fetchOpencode({ root = PKG_ROOT, platform, download = defaultDownload } = {}) {
  const manifest = loadManifest(root)
  const key = resolvePlatform(manifest, platform)
  const { asset, sha256: want } = manifest.platforms[key]
  const destDir = join(root, 'vendor', 'opencode', key)
  const bin = join(destDir, 'opencode')
  const stamp = join(destDir, '.sha256')

  if (existsSync(bin) && existsSync(stamp) && readFileSync(stamp, 'utf8').trim() === want) {
    return { skipped: true, path: bin }                       // offline repeat builds
  }

  const bytes = await download(assetUrl(manifest, key))
  const got = sha256(bytes)
  if (got !== want) {
    // Possible supply-chain signal: no retry, no override (spec §3 step 4).
    throw new Error(`SHA256 mismatch for ${asset}: expected ${want}, actual ${got}`)
  }

  mkdirSync(destDir, { recursive: true })
  const work = mkdtempSync(join(destDir, '.unpack-'))         // same fs → rename is atomic
  try {
    const archive = join(work, asset)
    writeFileSync(archive, bytes)
    if (asset.endsWith('.zip')) execFileSync('unzip', ['-oq', archive, '-d', work])
    else execFileSync('tar', ['-xzf', archive, '-C', work])
    if (!existsSync(join(work, 'opencode'))) throw new Error(`archive ${asset} did not contain a flat 'opencode' binary`)
    renameSync(join(work, 'opencode'), bin)
    chmodSync(bin, 0o755)
    writeFileSync(stamp, got + '\n')                          // stamp last (spec §3 step 5)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
  return { skipped: false, path: bin }
}

async function main(argv) {
  const flagIdx = argv.indexOf('--platform')
  const platform = flagIdx >= 0 ? argv[flagIdx + 1] : undefined
  if (argv.includes('--record')) {                            // pin-time only (spec §3 step 6)
    const manifest = loadManifest()
    for (const key of Object.keys(manifest.platforms)) {
      const bytes = await defaultDownload(assetUrl(manifest, key))
      console.log(`${key} ${sha256(bytes)}`)
    }
    return 0
  }
  const r = await fetchOpencode({ platform })
  console.log(r.skipped ? `[fetch-opencode] up to date: ${r.path}` : `[fetch-opencode] installed: ${r.path}`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(c => { process.exitCode = c }, e => { console.error(`[fetch-opencode] ${e.message}`); process.exitCode = 1 })
}
