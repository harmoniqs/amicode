import { describe, it, expect } from "vitest";
import {
  classifyError,
  LOCK_FILE_MISSING,
  LOCK_MISSING_TAG,
  GIT_DIRTY_TREE,
  GIT_NON_FF,
  DOWNLOAD_HASH_MISMATCH,
  RELEASE_DELETED,
  UNSUPPORTED_PLATFORM_WIN32,
  NODE_NOT_FOUND,
  STALE_OVERRIDE,
  UNKNOWN_ERROR,
  type RebuildError,
} from "../src/rebuild_errors";

describe("rebuild error catalog (#1016)", () => {
  it("every error has a code, message, and non-empty fix array", () => {
    const samples: RebuildError[] = [
      LOCK_FILE_MISSING("/tmp/missing"),
      LOCK_MISSING_TAG,
      GIT_DIRTY_TREE,
      GIT_NON_FF,
      DOWNLOAD_HASH_MISMATCH("test.tar.gz"),
      RELEASE_DELETED("v0.0.0"),
      UNSUPPORTED_PLATFORM_WIN32,
      NODE_NOT_FOUND,
      STALE_OVERRIDE("amicode.opencodeBinary", "/bad/path"),
      UNKNOWN_ERROR("something broke"),
    ];
    for (const err of samples) {
      expect(err.code).toBeTruthy();
      expect(err.message).toBeTruthy();
      expect(err.fix.length).toBeGreaterThan(0);
    }
  });

  describe("classifyError", () => {
    it("classifies SHA256 mismatch", () => {
      const err = classifyError("SHA256 mismatch for opencode-linux-x64.tar.gz: expected abc, actual def");
      expect(err.code).toBe("HASH_MISMATCH");
      expect(err.message).toContain("opencode-linux-x64.tar.gz");
    });

    it("classifies 404 / deleted release", () => {
      const err = classifyError("The release `v1.0.0` is no longer available");
      expect(err.code).toBe("RELEASE_DELETED");
    });

    it("classifies non-fast-forward", () => {
      const err = classifyError("fatal: Not possible to fast-forward, aborting.");
      expect(err.code).toBe("GIT_NON_FF");
    });

    it("classifies git pull failures", () => {
      const err = classifyError("git pull (amicode) failed: connection refused");
      expect(err.code).toBe("GIT_PULL_FAILED");
    });

    it("classifies pnpm install failures", () => {
      const err = classifyError("pnpm install failed: ECONNREFUSED");
      expect(err.code).toBe("PNPM_INSTALL");
    });

    it("falls back to UNKNOWN for unrecognized errors", () => {
      const err = classifyError("something completely unexpected");
      expect(err.code).toBe("UNKNOWN");
      expect(err.fix[0]).toMatch(/output/i);
    });
  });
});
