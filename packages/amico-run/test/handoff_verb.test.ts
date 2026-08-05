// `amico handoff` (spec-20260804-211500) — pure core (handoff.ts) + verb bodies
// (handoff_verb.ts) against a FAKE gh runner; no network, no `gh` binary needed.
// Run: `pnpm --filter @amicode/amico-run test`.
import { describe, it, expect } from "vitest";
import {
  checkReceipt,
  exitCodeFor,
  grantReceipt,
  handoffLine,
  httpStatus,
  isPermission,
  isRepoSlug,
  type HandleReceipt,
} from "../src/handoff.js";
import { handoffVerb, type GhCall, type GhRunner } from "../src/handoff_verb.js";

// ── fake gh seam ──────────────────────────────────────────────────────────────
interface Script {
  putStatus?: Record<string, number>; // per-handle PUT HTTP status (default 204)
  collaborator?: Record<string, boolean>; // per-handle collaborator record (default: true iff PUT 204)
  invited?: Record<string, boolean>; // per-handle pending invitation (default false)
  collaboratorLogins?: string[]; // lookup list
  putStderr?: string;
}

function call(http: number | undefined, body = "", code?: number, stderr = ""): GhCall {
  const hdr = http ? `HTTP/2.0 ${http} ${http === 204 ? "No Content" : "Status"}\n` : "";
  return { code: code ?? (http !== undefined && http < 300 ? 0 : 1), http, stdout: hdr + body, stderr };
}

function fakeRunner(s: Script): GhRunner {
  return (args: string[]): GhCall => {
    const url = args.find((a) => a.startsWith("repos/")) ?? "";
    const handle = url.split("/collaborators/")[1]?.split("/")[0] ?? "";
    if (args.includes("PUT")) {
      const http = s.putStatus?.[handle] ?? 204;
      return call(http, "", undefined, http >= 300 ? s.putStderr ?? "gh: error" : "");
    }
    if (url.includes("/collaborators/") && !args.includes("--jq")) {
      const ok = s.collaborator?.[handle] ?? (s.putStatus?.[handle] ?? 204) === 204;
      return ok ? call(204) : call(404);
    }
    if (url.endsWith("/invitations")) {
      const logins = Object.entries(s.invited ?? {})
        .filter(([, v]) => v)
        .map(([k]) => ({ invitee: { login: k } }));
      return call(200, JSON.stringify(logins));
    }
    if (args.includes("--jq")) {
      return call(200, (s.collaboratorLogins ?? []).join("\n"));
    }
    throw new Error(`fakeRunner: unscripted call ${args.join(" ")}`);
  };
}

// ── pure core ─────────────────────────────────────────────────────────────────
describe("handoff.ts pure core", () => {
  it("validates permissions and repo slugs", () => {
    expect(isPermission("push")).toBe(true);
    expect(isPermission("root")).toBe(false);
    expect(isRepoSlug("harmoniqs/ions-certify")).toBe(true);
    expect(isRepoSlug("not-a-slug")).toBe(false);
  });

  it("parses HTTP status out of `gh api -i` output", () => {
    expect(httpStatus("HTTP/2.0 204 No Content\nDate: x\n")).toBe(204);
    expect(httpStatus("noise\nHTTP/2.0 404 Not Found\n{}")).toBe(404);
    expect(httpStatus("no status here")).toBeUndefined();
  });

  it("grantReceipt: 204+verified → immediate; 201 → pending with the do-not-announce detail; else failed", () => {
    expect(grantReceipt("ann", "push", 204, { collaborator: true, invited: false }).access).toBe("immediate");
    const pending = grantReceipt("ann", "push", 201, { collaborator: false, invited: true });
    expect(pending.access).toBe("pending-acceptance");
    expect(pending.detail).toMatch(/UNTIL ACCEPTED/);
    expect(grantReceipt("ann", "push", 422, { collaborator: false, invited: false }, "gh: 422").access).toBe("failed");
    // the pathological one: 204 but the record does not verify
    expect(grantReceipt("ann", "push", 204, { collaborator: false, invited: false }).access).toBe("failed");
  });

  it("checkReceipt: collaborator → immediate; invited → pending; neither → none; error → failed", () => {
    expect(checkReceipt("ann", { collaborator: true, invited: false }).access).toBe("immediate");
    expect(checkReceipt("ann", { collaborator: false, invited: true }).access).toBe("pending-acceptance");
    expect(checkReceipt("ann", { collaborator: false, invited: false }).access).toBe("none");
    expect(checkReceipt("ann", { collaborator: false, invited: false }, "boom").access).toBe("failed");
  });

  it("exitCodeFor: failed → 2 beats pending → 1 beats clean → 0", () => {
    const r = (access: HandleReceipt["access"]): HandleReceipt => ({ handle: "h", access, detail: "" });
    expect(exitCodeFor([r("immediate")])).toBe(0);
    expect(exitCodeFor([r("immediate"), r("pending-acceptance")])).toBe(1);
    expect(exitCodeFor([r("pending-acceptance"), r("failed")])).toBe(2);
    expect(exitCodeFor([r("none")])).toBe(1);
  });

  it("handoffLine only when every handle is immediate", () => {
    const ok: HandleReceipt[] = [{ handle: "ann-mahe", permission: "push", access: "immediate", detail: "" }];
    expect(handoffLine("harmoniqs/x", ok)).toBe("handoff ready: https://github.com/harmoniqs/x is readable by @ann-mahe (push)");
    expect(handoffLine("harmoniqs/x", [{ handle: "a", access: "pending-acceptance", detail: "" }])).toBeUndefined();
  });
});

// ── grant ─────────────────────────────────────────────────────────────────────
describe("amico handoff grant", () => {
  it("happy path: 204 → immediate receipt, exit 0, paste-ready handoff_line", () => {
    const { json, code } = handoffVerb(["grant", "harmoniqs/x", "ann-mahe"], fakeRunner({}));
    expect(code).toBe(0);
    const j = json as never as { receipts: HandleReceipt[]; handoff_line: string };
    expect(j.receipts[0].access).toBe("immediate");
    expect(j.receipts[0].permission).toBe("push");
    expect(j.handoff_line).toContain("@ann-mahe");
  });

  it("invitation path: 201 → pending-acceptance, exit 1, loud warning (announce must stop)", () => {
    const { json, code } = handoffVerb(["grant", "harmoniqs/x", "outsider"], fakeRunner({ putStatus: { outsider: 201 }, invited: { outsider: true } }));
    expect(code).toBe(1);
    const j = json as never as { receipts: HandleReceipt[]; warning: string; handoff_line?: string };
    expect(j.receipts[0].access).toBe("pending-acceptance");
    expect(j.warning).toMatch(/UNACCEPTED invitation/);
    expect(j.handoff_line).toBeUndefined();
  });

  it("API failure → failed receipt with stderr, exit 2", () => {
    const { json, code } = handoffVerb(
      ["grant", "harmoniqs/x", "ghost"],
      fakeRunner({ putStatus: { ghost: 422 }, collaborator: { ghost: false }, putStderr: "gh: Validation Failed" }),
    );
    expect(code).toBe(2);
    expect((json as never as { receipts: HandleReceipt[] }).receipts[0].detail).toContain("Validation Failed");
  });

  it("--also: per-handle receipts; exit = worst (mixed immediate + pending → 1)", () => {
    const { json, code } = handoffVerb(
      ["grant", "harmoniqs/x", "ann-mahe", "--also", "outsider,jj"],
      fakeRunner({ putStatus: { outsider: 201 }, invited: { outsider: true } }),
    );
    expect(code).toBe(1);
    const rs = (json as never as { receipts: HandleReceipt[] }).receipts;
    expect(rs.map((r) => r.handle)).toEqual(["ann-mahe", "outsider", "jj"]);
    expect(rs.map((r) => r.access)).toEqual(["immediate", "pending-acceptance", "immediate"]);
  });

  it("usage errors: bad permission / bad slug / missing handle / unknown subcommand → 64", () => {
    expect(handoffVerb(["grant", "harmoniqs/x", "ann", "--permission", "root"], fakeRunner({})).code).toBe(64);
    expect(handoffVerb(["grant", "not-a-slug", "ann"], fakeRunner({})).code).toBe(64);
    expect(handoffVerb(["grant", "harmoniqs/x"], fakeRunner({})).code).toBe(64);
    expect(handoffVerb(["frobnicate"], fakeRunner({})).code).toBe(64);
  });
});

// ── check ─────────────────────────────────────────────────────────────────────
describe("amico handoff check", () => {
  it("collaborator → immediate, exit 0", () => {
    const { json, code } = handoffVerb(["check", "harmoniqs/x", "ann-mahe"], fakeRunner({ collaborator: { "ann-mahe": true } }));
    expect(code).toBe(0);
    expect((json as never as { receipt: HandleReceipt }).receipt.access).toBe("immediate");
  });

  it("invited-but-not-accepted → pending, exit 1", () => {
    const { json, code } = handoffVerb(["check", "harmoniqs/x", "outsider"], fakeRunner({ collaborator: { outsider: false }, invited: { outsider: true } }));
    expect(code).toBe(1);
    expect((json as never as { receipt: HandleReceipt }).receipt.access).toBe("pending-acceptance");
  });

  it("no record → none, exit 1 (the 404 state Ann was in)", () => {
    const { json, code } = handoffVerb(["check", "harmoniqs/x", "ghost"], fakeRunner({ collaborator: { ghost: false } }));
    expect(code).toBe(1);
    expect((json as never as { receipt: HandleReceipt }).receipt.access).toBe("none");
  });
});

// ── lookup ────────────────────────────────────────────────────────────────────
describe("amico handoff lookup", () => {
  it("filters collaborator logins by substring, case-insensitive", () => {
    const { json, code } = handoffVerb(
      ["lookup", "harmoniqs/ions", "ann"],
      fakeRunner({ collaboratorLogins: ["ann-mahe", "aarontrowbridge", "jack-champagne", "nguyenston"] }),
    );
    expect(code).toBe(0);
    expect((json as never as { matches: string[] }).matches).toEqual(["ann-mahe"]);
  });

  it("no match → empty list, exit 0", () => {
    const { json, code } = handoffVerb(["lookup", "harmoniqs/ions", "zzz"], fakeRunner({ collaboratorLogins: ["ann-mahe"] }));
    expect(code).toBe(0);
    expect((json as never as { matches: string[] }).matches).toEqual([]);
  });
});
