import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadManifest, resolvePlatform } from '../scripts/fetch_opencode.mjs'

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
