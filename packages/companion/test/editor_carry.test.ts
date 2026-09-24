// Tests for issue #1278 — "Cross-scheme editor-URI carry across the posture
// switch" (ADR 0025 P3; part of #1269).
//
// A window reopen changes the file SCHEME: under Remote-SSH host files are
// `vscode-remote://ssh-remote+<alias>/<hostpath>`; under the thin-client lifeboat
// (#1267's FileSystemProvider) the SAME logical host path is `amico-host:/<hostpath>`.
// So a naive reopen loses every open editor across the flip. This module carries
// them by LOGICAL PATH across the two host schemes — and where an editor cannot
// be carried, it is REPORTED, never silently dropped (the issue's "No silent
// state loss" invariant).
//
// AC1: an open host-file editor reopens at the same logical path under the target
//      scheme — both directions (amico-host ↔ vscode-remote+ssh).
// AC2: an editor that cannot be carried is reported (never silently dropped).
// AC3: a non-host (local scratch) editor is unaffected — left exactly as-is.

import { describe, it, expect } from "vitest";
import {
  translateHostEditorUri,
  carryOpenEditors,
  notCarriedMessage,
  type EditorCarryDeps,
} from "../src/editor_carry";

// ══════════════════════════════════════════════════════════════════════════════
// AC1 — the translation map: same logical host path, opposite host scheme,
// both directions (amico-host ↔ vscode-remote+ssh).
// ══════════════════════════════════════════════════════════════════════════════
describe("translateHostEditorUri — carries the logical path across schemes (AC1)", () => {
  it("local → remote: amico-host:/<path> → vscode-remote://ssh-remote+<alias>/<path>", () => {
    const o = translateHostEditorUri("amico-host:/home/jj/foo.jl", "vscode-remote", { alias: "hub" });
    expect(o.kind).toBe("carried");
    if (o.kind === "carried") {
      expect(o.direction).toBe("to-remote");
      expect(o.to).toBe("vscode-remote://ssh-remote+hub/home/jj/foo.jl");
    }
  });

  it("remote → local: vscode-remote://ssh-remote+<alias>/<path> → amico-host:/<path>", () => {
    const o = translateHostEditorUri("vscode-remote://ssh-remote+hub/home/jj/foo.jl", "amico-host", {});
    expect(o.kind).toBe("carried");
    if (o.kind === "carried") {
      expect(o.direction).toBe("to-local");
      expect(o.to).toBe("amico-host:/home/jj/foo.jl");
    }
  });

  it("the remote target matches reopen.ts's builder EXACTLY (single slash, leading slash absorbed)", () => {
    // coherent with resolveRemoteSshReopenTarget: vscode-remote://ssh-remote+<a>/<path-no-leading-slash>
    const o = translateHostEditorUri("amico-host:/etc/hosts", "vscode-remote", { alias: "amico-erlich" });
    if (o.kind === "carried") expect(o.to).toBe("vscode-remote://ssh-remote+amico-erlich/etc/hosts");
  });

  it("round-trips: local → remote → local returns the original amico-host URI", () => {
    const up = translateHostEditorUri("amico-host:/home/jj/x.md", "vscode-remote", { alias: "hub" });
    expect(up.kind).toBe("carried");
    if (up.kind !== "carried") return;
    const down = translateHostEditorUri(up.to, "amico-host", {});
    expect(down.kind).toBe("carried");
    if (down.kind === "carried") expect(down.to).toBe("amico-host:/home/jj/x.md");
  });

  it("carries a deep nested path verbatim (no re-rooting, no mount surgery)", () => {
    const o = translateHostEditorUri("vscode-remote://ssh-remote+hub/a/b/c/d.txt", "amico-host", {});
    if (o.kind === "carried") expect(o.to).toBe("amico-host:/a/b/c/d.txt");
  });

  it("trims the alias when building the remote target", () => {
    const o = translateHostEditorUri("amico-host:/x", "vscode-remote", { alias: "  hub  " });
    if (o.kind === "carried") expect(o.to).toBe("vscode-remote://ssh-remote+hub/x");
  });

  it("tolerates the two-slash amico-host form (amico-host://mount/rel) without losing the mount segment", () => {
    // A defensive parse: whether the FSP URI serialized with an authority or not,
    // the whole logical path is carried.
    const o = translateHostEditorUri("amico-host://personal/notes/a.md", "vscode-remote", { alias: "hub" });
    if (o.kind === "carried") expect(o.to).toBe("vscode-remote://ssh-remote+hub/personal/notes/a.md");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC3 — a non-host (local scratch) editor is unaffected: left exactly as-is.
// ══════════════════════════════════════════════════════════════════════════════
describe("translateHostEditorUri — non-host editors are untouched (AC3)", () => {
  it("a local file:// scratch editor is not a host editor — do not carry", () => {
    expect(translateHostEditorUri("file:///tmp/scratch.txt", "amico-host", {}).kind).toBe("skip");
    const o = translateHostEditorUri("file:///tmp/scratch.txt", "vscode-remote", { alias: "hub" });
    expect(o.kind).toBe("skip");
    if (o.kind === "skip") expect(o.reason).toBe("not-host");
  });

  it("an untitled: scratch buffer is not a host editor — do not carry", () => {
    const o = translateHostEditorUri("untitled:Untitled-1", "amico-host", {});
    expect(o.kind).toBe("skip");
    if (o.kind === "skip") expect(o.reason).toBe("not-host");
  });

  it("a non-ssh vscode-remote (e.g. dev-container / wsl) is NOT the ssh host scheme — untouched", () => {
    const o = translateHostEditorUri("vscode-remote://dev-container+abc123/work/x.ts", "amico-host", {});
    expect(o.kind).toBe("skip");
    if (o.kind === "skip") expect(o.reason).toBe("not-host");
  });

  it("an editor already IN the target scheme is a no-op skip (nothing to carry)", () => {
    expect(translateHostEditorUri("amico-host:/x", "amico-host", {})).toEqual({ kind: "skip", reason: "already-target" });
    expect(
      translateHostEditorUri("vscode-remote://ssh-remote+hub/x", "vscode-remote", { alias: "hub" }),
    ).toEqual({ kind: "skip", reason: "already-target" });
  });

  it("garbage that is not a URI at all is skipped, never carried", () => {
    expect(translateHostEditorUri("not a uri", "amico-host", {}).kind).toBe("skip");
    expect(translateHostEditorUri("", "amico-host", {}).kind).toBe("skip");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC2 — a host editor that cannot be carried is reported, never silently dropped.
// ══════════════════════════════════════════════════════════════════════════════
describe("translateHostEditorUri — an un-carryable host editor is a typed cannot-carry (AC2)", () => {
  it("amico-host → remote with no alias cannot be mapped — a typed no-ssh-alias reason", () => {
    const blank = translateHostEditorUri("amico-host:/home/jj/foo.jl", "vscode-remote", { alias: "" });
    expect(blank.kind).toBe("cannot-carry");
    if (blank.kind === "cannot-carry") {
      expect(blank.reason).toBe("no-ssh-alias");
      expect(blank.detail).toMatch(/alias/i);
    }
    // no alias supplied at all is the same typed reason
    const missing = translateHostEditorUri("amico-host:/x", "vscode-remote", {});
    expect(missing.kind).toBe("cannot-carry");
    if (missing.kind === "cannot-carry") expect(missing.reason).toBe("no-ssh-alias");
  });

  it("a malformed host URI with no usable logical path is a typed unparseable reason (never dropped)", () => {
    const o = translateHostEditorUri("amico-host:", "vscode-remote", { alias: "hub" });
    expect(o.kind).toBe("cannot-carry");
    if (o.kind === "cannot-carry") expect(o.reason).toBe("unparseable");
  });

  it("a cannot-carry is NEVER classified as a skip (a skip would silently drop it)", () => {
    // the honesty invariant: a host editor we cannot map must be reportable, not
    // quietly bucketed with the untouched scratch editors.
    const o = translateHostEditorUri("amico-host:/x", "vscode-remote", { alias: "" });
    expect(o.kind).not.toBe("skip");
    expect(o.kind).not.toBe("carried");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// carryOpenEditors — the switch's carry step: capture → translate → carry the
// host editors, REPORT the un-carryable ones, leave the scratch untouched.
// ══════════════════════════════════════════════════════════════════════════════
interface CarryHarness {
  deps: EditorCarryDeps;
  carried: string[];
  reports: string[];
}
function carryHarness(open: string[]): CarryHarness {
  const carried: string[] = [];
  const reports: string[] = [];
  const deps: EditorCarryDeps = {
    listOpenEditors: () => open,
    carryEditor: (uri) => {
      carried.push(uri);
    },
    reportNotCarried: (m) => {
      reports.push(m);
    },
  };
  return { deps, carried, reports };
}

describe("carryOpenEditors — carries hosts, reports the un-carryable, leaves scratch (AC1/AC2/AC3)", () => {
  it("auto-DOWN (→ amico-host): the host editors carry, the scratch is untouched", async () => {
    const h = carryHarness([
      "vscode-remote://ssh-remote+hub/home/jj/a.jl",
      "vscode-remote://ssh-remote+hub/home/jj/b.md",
      "file:///tmp/scratch.txt",
      "untitled:Untitled-1",
    ]);
    const summary = await carryOpenEditors("amico-host", h.deps, {});
    expect(h.carried).toEqual(["amico-host:/home/jj/a.jl", "amico-host:/home/jj/b.md"]);
    expect(summary.carried).toHaveLength(2);
    expect(summary.skipped).toEqual(["file:///tmp/scratch.txt", "untitled:Untitled-1"]); // AC3 untouched
    expect(summary.notCarried).toHaveLength(0);
    expect(h.reports).toHaveLength(0);
  });

  it("prompt-UP (→ vscode-remote): the reverse — host editors carry to the ssh authority, scratch untouched", async () => {
    const h = carryHarness([
      "amico-host:/home/jj/a.jl",
      "amico-host:/home/jj/b.md",
      "file:///tmp/scratch.txt",
    ]);
    const summary = await carryOpenEditors("vscode-remote", h.deps, { alias: "amico-erlich" });
    expect(h.carried).toEqual([
      "vscode-remote://ssh-remote+amico-erlich/home/jj/a.jl",
      "vscode-remote://ssh-remote+amico-erlich/home/jj/b.md",
    ]);
    expect(summary.skipped).toEqual(["file:///tmp/scratch.txt"]);
    expect(h.reports).toHaveLength(0);
  });

  it("an un-carryable host editor is REPORTED and its well-formed siblings still carry (never silently dropped, AC2)", async () => {
    const h = carryHarness([
      "amico-host:/home/jj/a.jl", // carries
      "amico-host:", // malformed → cannot carry → reported
      "file:///tmp/scratch.txt", // untouched
    ]);
    const summary = await carryOpenEditors("vscode-remote", h.deps, { alias: "hub" });
    expect(h.carried).toEqual(["vscode-remote://ssh-remote+hub/home/jj/a.jl"]);
    expect(summary.notCarried).toHaveLength(1);
    expect(summary.notCarried[0].from).toBe("amico-host:");
    expect(h.reports).toHaveLength(1); // it was reported to the user
    expect(summary.skipped).toEqual(["file:///tmp/scratch.txt"]); // the malformed host URI is NOT in skipped
  });

  it("a blank alias makes every host editor un-carryable — all reported, none dropped", async () => {
    const h = carryHarness(["amico-host:/a", "amico-host:/b"]);
    const summary = await carryOpenEditors("vscode-remote", h.deps, { alias: "" });
    expect(h.carried).toHaveLength(0);
    expect(summary.notCarried).toHaveLength(2); // both reported (AC2), neither silently dropped
    expect(h.reports).toHaveLength(2);
  });

  it("an empty editor set is a clean no-op", async () => {
    const h = carryHarness([]);
    const summary = await carryOpenEditors("amico-host", h.deps, {});
    expect(summary).toEqual({ carried: [], notCarried: [], skipped: [] });
    expect(h.carried).toHaveLength(0);
    expect(h.reports).toHaveLength(0);
  });
});

describe("notCarriedMessage — honest, names the editor and why (never silent)", () => {
  it("names the editor URI and the reason, and says it was left as-is (not dropped)", () => {
    const m = notCarriedMessage("amico-host:/x", "no Remote-SSH alias to map it to");
    expect(m).toContain("amico-host:/x");
    expect(m).toContain("no Remote-SSH alias to map it to");
    expect(m.toLowerCase()).toMatch(/left as-is|not.*dropped|reopen/);
  });
});
