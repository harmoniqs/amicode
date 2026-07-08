// Tests for the amicode_* plugin's hashing sibling (opencode-plugin/hashes.ts).
//
// hashes.ts uses node:crypto — it is NOT importable into entities.ts (which is
// dependency-free / dual-runtime). It follows the score_guard.ts sibling rules:
// node: builtins allowed, named exports fine. Exercised here as plain functions.
import { describe, it, expect } from "vitest";
import { sha256Hex, entityHash } from "../opencode-plugin/hashes";

describe("sha256Hex", () => {
  it('matches the known vector for "abc"', () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("entityHash", () => {
  it("is prefixed with sha256: and stable across key order + excluded keys", () => {
    const h = entityHash({ b: 1, a: 2, recorded: "x" });
    expect(h.startsWith("sha256:")).toBe(true);
    expect(entityHash({ a: 2, b: 1 })).toBe(h);
  });
});
