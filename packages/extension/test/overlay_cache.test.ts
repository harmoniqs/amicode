import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readCachedOverlayHash,
  writeCachedOverlayHash,
} from "../src/rebuild/overlay_cache";
import { shouldSkipBinaryBuild } from "../src/server_handshake";

// ============================================================================
// #1178 — overlay-hash cache + skip decision.
//
// The rebuild skips the binary build AND the server teardown when the overlay
// tree is unchanged (kill-free extension-only rebuild). This exercises the
// cache round-trip and the skip decision it feeds.
// ============================================================================

function tmpMarker(): string {
  return join(mkdtempSync(join(tmpdir(), "overlay-cache-")), "overlay-hash.txt");
}

describe("overlay hash cache", () => {
  it("round-trips a written hash", () => {
    const fp = tmpMarker();
    writeCachedOverlayHash("deadbeef", fp);
    expect(readCachedOverlayHash(fp)).toBe("deadbeef");
  });

  it("returns null when the marker is absent", () => {
    const fp = join(mkdtempSync(join(tmpdir(), "overlay-cache-")), "nope.txt");
    expect(readCachedOverlayHash(fp)).toBeNull();
  });

  it("overwrites a prior hash", () => {
    const fp = tmpMarker();
    writeCachedOverlayHash("aaaa", fp);
    writeCachedOverlayHash("bbbb", fp);
    expect(readCachedOverlayHash(fp)).toBe("bbbb");
  });
});

describe("skip decision (overlay-hash cache feeds shouldSkipBinaryBuild)", () => {
  it("skips build + teardown when the overlay hash matches the cache", () => {
    const fp = tmpMarker();
    writeCachedOverlayHash("same-hash", fp);
    const skip = shouldSkipBinaryBuild("same-hash", readCachedOverlayHash(fp));
    expect(skip).toBe(true); // both binary build and teardown are gated on !skip
  });

  it("does NOT skip when the overlay changed", () => {
    const fp = tmpMarker();
    writeCachedOverlayHash("old-hash", fp);
    expect(shouldSkipBinaryBuild("new-hash", readCachedOverlayHash(fp))).toBe(false);
  });

  it("does NOT skip on a cold machine with no cached hash", () => {
    const fp = join(mkdtempSync(join(tmpdir(), "overlay-cache-")), "nope.txt");
    expect(shouldSkipBinaryBuild("any-hash", readCachedOverlayHash(fp))).toBe(false);
  });
});
