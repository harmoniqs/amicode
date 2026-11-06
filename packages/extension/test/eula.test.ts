// eula.ts — the install-time EULA gate: the pure predicate, the text loader's
// fallback, and the inert-gate HTML (command URI → amicode.reviewEula).
import { describe, expect, it } from "vitest";
import {
  EULA_ACCEPTED_KEY,
  EULA_VERSION,
  PLACEHOLDER_EULA,
  eulaGateHtml,
  eulaText,
  isEulaAccepted,
} from "../src/eula";

function memento(init: Record<string, unknown> = {}) {
  const data = new Map(Object.entries(init));
  return {
    data,
    get: <T>(k: string) => data.get(k) as T | undefined,
    update: async (k: string, v: unknown) => {
      data.set(k, v);
    },
  };
}

describe("isEulaAccepted", () => {
  it("a fresh install (unset) is not accepted", () => {
    expect(isEulaAccepted(memento())).toBe(false);
  });
  it("acceptance of the CURRENT version is accepted", () => {
    expect(isEulaAccepted(memento({ [EULA_ACCEPTED_KEY]: EULA_VERSION }))).toBe(true);
  });
  it("acceptance of an OLD version re-prompts (not accepted)", () => {
    expect(isEulaAccepted(memento({ [EULA_ACCEPTED_KEY]: "0.0.1" }))).toBe(false);
  });
  it("junk in the key is not accepted", () => {
    expect(isEulaAccepted(memento({ [EULA_ACCEPTED_KEY]: true }))).toBe(false);
    expect(isEulaAccepted(memento({ [EULA_ACCEPTED_KEY]: 1 }))).toBe(false);
  });
  it("no memento → not accepted", () => {
    expect(isEulaAccepted(undefined)).toBe(false);
  });
});

describe("eulaText", () => {
  it("reads EULA.txt from the extension root when present", () => {
    const text = eulaText("/fake/ext", () => "REAL EULA TEXT");
    expect(text).toBe("REAL EULA TEXT");
  });
  it("falls back to the embedded placeholder when the file is missing", () => {
    const text = eulaText("/fake/ext", () => {
      throw new Error("ENOENT");
    });
    expect(text).toBe(PLACEHOLDER_EULA);
  });
  it("falls back to the placeholder on an empty file", () => {
    expect(eulaText("/fake/ext", () => "   ")).toBe(PLACEHOLDER_EULA);
  });
});

describe("eulaGateHtml", () => {
  it("links to the review command and shows the clean display version", () => {
    const html = eulaGateHtml();
    expect(html).toContain("command:amicode.reviewEula");
    expect(html).toContain("0.1.0");
    expect(html).toContain("Review &amp; Accept EULA…");
    expect(html).not.toContain("0.1.0-placeholder");
  });
});
