import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fetchOpencode, loadManifest, resolvePlatform, sha256 } from '../scripts/fetch_opencode.mjs'

function rootWith(manifest: unknown): string {
  const root = mkdtempSync(join(tmpdir(), 'oc-test-'))
  writeFileSync(join(root, 'opencode.lock.json'), JSON.stringify(manifest))
  return root
}

const GOOD = {
  version: '1.17.3',
  platforms: {
    'darwin-arm64': { asset: 'a.zip', sha256: 'ab'.repeat(32) },
    'linux-x64':    { asset: 'a.tar.gz', sha256: 'cd'.repeat(32) },
  },
}

describe('loadManifest', () => {
  it('accepts a well-formed manifest', () => {
    expect(loadManifest(rootWith(GOOD)).version).toBe('1.17.3')
  })
  it('the COMMITTED manifest parses and pins exactly the two supported platforms', () => {
    const m = loadManifest()   // defaults to the real packages/extension root
    expect(Object.keys(m.platforms).sort()).toEqual(['darwin-arm64', 'linux-x64'])
  })
  it('rejects missing version and short hashes', () => {
    expect(() => loadManifest(rootWith({ ...GOOD, version: '' }))).toThrow(/version/)
    expect(() => loadManifest(rootWith({
      ...GOOD, platforms: { ...GOOD.platforms, 'linux-x64': { asset: 'a', sha256: 'beef' } },
    }))).toThrow(/sha256/)
  })
})

describe('resolvePlatform', () => {
  it('honors an explicit valid key and rejects unknown ones', () => {
    expect(resolvePlatform(GOOD, 'linux-x64')).toBe('linux-x64')
    expect(() => resolvePlatform(GOOD, 'windows-x64')).toThrow(/supported/)
  })
  it('detects the current machine when no flag given', () => {
    const key = `${process.platform}-${process.arch}`
    if (key in GOOD.platforms) expect(resolvePlatform(GOOD)).toBe(key)
    else expect(() => resolvePlatform(GOOD)).toThrow(/supported/)
  })
})

function fixtureArchive(): { bytes: Buffer; hash: string } {
  const dir = mkdtempSync(join(tmpdir(), 'oc-fixture-'))
  writeFileSync(join(dir, 'opencode'), '#!/bin/sh\necho fake-opencode\n')
  chmodSync(join(dir, 'opencode'), 0o755)
  execFileSync('tar', ['-czf', join(dir, 'a.tar.gz'), '-C', dir, 'opencode'])
  const bytes = readFileSync(join(dir, 'a.tar.gz'))
  return { bytes, hash: sha256(bytes) }
}

describe('fetchOpencode', () => {
  it('downloads, verifies, unpacks, stamps — then skips on re-run', async () => {
    const { bytes, hash } = fixtureArchive()
    const root = rootWith({ version: '9.9.9', platforms: { 'linux-x64': { asset: 'a.tar.gz', sha256: hash } } })
    let calls = 0
    const download = async () => { calls++; return bytes }
    const r1 = await fetchOpencode({ root, platform: 'linux-x64', download })
    expect(r1.skipped).toBe(false)
    const bin = join(root, 'vendor', 'opencode', 'linux-x64', 'opencode')
    expect(existsSync(bin)).toBe(true)
    expect(readFileSync(join(root, 'vendor', 'opencode', 'linux-x64', '.sha256'), 'utf8').trim()).toBe(hash)
    const r2 = await fetchOpencode({ root, platform: 'linux-x64', download })
    expect(r2.skipped).toBe(true)
    expect(calls).toBe(1)                       // idempotent: no second download
  })
  it('hard-fails on hash mismatch, printing expected vs actual, installing nothing', async () => {
    const { bytes } = fixtureArchive()
    const root = rootWith({ version: '9.9.9', platforms: { 'linux-x64': { asset: 'a.tar.gz', sha256: 'ee'.repeat(32) } } })
    await expect(fetchOpencode({ root, platform: 'linux-x64', download: async () => bytes }))
      .rejects.toThrow(/expected ee.*actual/s)
    expect(existsSync(join(root, 'vendor', 'opencode', 'linux-x64', 'opencode'))).toBe(false)
  })
})

describe('releaseCoords — fork-mirror pinning', async () => {
  const { releaseCoords, assetUrl } = await import('../scripts/fetch_opencode.mjs')
  const platforms = { 'linux-x64': { asset: 'opencode-linux-x64.tar.gz', sha256: 'a'.repeat(64) } }
  it('defaults to upstream at v<version>, public', () => {
    const m = { version: '1.17.3', platforms }
    expect(releaseCoords(m)).toEqual({ repo: 'sst/opencode', tag: 'v1.17.3', private: false })
    expect(assetUrl(m, 'linux-x64')).toBe(
      'https://github.com/sst/opencode/releases/download/v1.17.3/opencode-linux-x64.tar.gz',
    )
  })
  it('repo+tag repoint to the private mirror', () => {
    const m = { version: '1.17.3', repo: 'harmoniqs/opencode', tag: 'v1.17.3-amicode.1', platforms }
    expect(releaseCoords(m)).toEqual({ repo: 'harmoniqs/opencode', tag: 'v1.17.3-amicode.1', private: true })
    expect(assetUrl(m, 'linux-x64')).toBe(
      'https://github.com/harmoniqs/opencode/releases/download/v1.17.3-amicode.1/opencode-linux-x64.tar.gz',
    )
  })
})
