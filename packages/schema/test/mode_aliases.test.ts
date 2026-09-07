// mode_aliases.test.ts — the read-resolve alias table (spec-20260907-011500
// D1, issue #858): autodev → develop, autoresearch → research. The aliases
// are READ-RESOLVE, never migrate-on-write: append-only artifacts (session
// ledgers, spec frontmatter, campaign fixtures) legitimately keep old ids
// forever and resolve at read time; tooling that joins on a mode id supports
// both ids permanently. `build` is NOT aliased — it exits the PICKER, not the
// vocabulary (it remains a valid explicit id everywhere).
//
// The alias window's END is contract-version-gated, not calendar-gated:
// removal is NON-ADDITIVE, so it rides the next mode-bundle CONTRACT-VERSION
// bump (the freeze-validator-legal exit). The lint below pins that gate.
import { describe, it, expect } from "vitest";
import {
  MODE_ID_ALIASES,
  resolveModeId,
  SUPPORTED_MODE_BUNDLE_VERSION,
} from "../src/mode_registry.js";

describe("the mode-id read-resolve alias table (spec-20260907-011500 D1, #858)", () => {
  it("maps exactly the two renamed director modes", () => {
    expect(MODE_ID_ALIASES).toEqual({ autodev: "develop", autoresearch: "research" });
  });

  it("resolves the old ids and passes everything else through untouched", () => {
    expect(resolveModeId("autodev")).toBe("develop");
    expect(resolveModeId("autoresearch")).toBe("research");
    // the renamed ids are identity
    expect(resolveModeId("develop")).toBe("develop");
    expect(resolveModeId("research")).toBe("research");
    // `build` remains a valid explicit id — never renamed (it re-enters the picker as a named tile, #868 rev 3)
    expect(resolveModeId("build")).toBe("build");
    // plan, role agents, custom agents, empty — all identity
    expect(resolveModeId("plan")).toBe("plan");
    expect(resolveModeId("implementer")).toBe("implementer");
    expect(resolveModeId("my-custom-agent")).toBe("my-custom-agent");
    expect(resolveModeId("")).toBe("");
  });

  it("is idempotent (an already-resolved id never double-resolves)", () => {
    for (const id of ["autodev", "autoresearch", "develop", "research", "build", "plan"]) {
      expect(resolveModeId(resolveModeId(id))).toBe(resolveModeId(id));
    }
  });

  it("no alias target collides with another alias key (the chain is one hop by construction)", () => {
    for (const target of Object.values(MODE_ID_ALIASES)) {
      expect(MODE_ID_ALIASES, `alias target ${target} must not itself be an alias key`).not.toHaveProperty(target);
    }
  });
});

describe("the alias window's exit is contract-version-gated (the freeze-validator-legal exit)", () => {
  it("while the contract version is 1 the alias window is OPEN — removing the aliases without the bump fails this lint", () => {
    // Removal is NON-ADDITIVE (the freeze validator's rule): it must ride the
    // next CONTRACT-VERSION bump, never a calendar date. If you are here
    // because you deleted the aliases: bump SUPPORTED_MODE_BUNDLE_VERSION and
    // this lint passes — that IS the legal exit.
    if (SUPPORTED_MODE_BUNDLE_VERSION === "1") {
      expect(
        Object.keys(MODE_ID_ALIASES).length,
        "contract v1 ships the read-resolve alias window; removing the aliases is " +
          "non-additive and must ride the next CONTRACT-VERSION bump " +
          "(spec-20260907-011500 D1)",
      ).toBeGreaterThan(0);
    }
  });
});
