// #1481 (Binding Amendment) — the trusted-Observe RETENTION layer + the
// read-only transcript view. This is the stateful half that upholds the central
// invariant: "missing projection data may never render the session as local."
//
// It WRAPS #1455's FleetProjection (AC5 — never replaces it): it observes a
// sequence of projections and, on a source LOSS, retains the last-known remote
// sessions with their owner provenance + a NAMED availability state, rather than
// letting them vanish (which the UI would read as local). Observe-trust
// REVOCATION strips sensitive metadata, leaving only a non-sensitive tombstone.
// The read-only transcript view is GET-only (Observe performs no remote mutation).
import { describe, it, expect, vi } from "vitest";
import {
  ObserveRetention,
  fetchRemoteTranscript,
  type ObserveSessionRow,
} from "../src/amicode_service/trusted_observe_projection";
import type { FleetProjection, SourceFetchRecord } from "../src/amicode_service/merged_projection";

// A minimal FleetProjection builder for the retention tests.
function projection(opts: {
  sessions: Array<{ id: string; owner: string; ownerName: string; isLocal: boolean; title?: string; directory?: string }>;
  sources: Record<string, Partial<SourceFetchRecord> & { present: boolean }>;
}): FleetProjection {
  return {
    ok: true,
    mode: "fleet",
    sessions: opts.sessions.map((s) => ({
      id: s.id,
      ...(s.title !== undefined ? { title: s.title } : {}),
      ...(s.directory !== undefined ? { directory: s.directory } : {}),
      amicode_provenance: s.owner,
      amicode_owner: {
        owner_machine_id: s.owner,
        owner_name: s.ownerName,
        ...(s.directory !== undefined ? { directory: s.directory } : {}),
        is_local: s.isLocal,
      },
    })),
    sources: Object.fromEntries(
      Object.entries(opts.sources).map(([k, v]) => [k, { source: k, ...v } as SourceFetchRecord]),
    ),
    currency: { token: "cur-x", sources: Object.keys(opts.sources), derived_over: "fetched" },
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// #1481 ObserveRetention — never-local invariant + present passthrough
// ══════════════════════════════════════════════════════════════════════════════

describe("#1481 ObserveRetention — present source passthrough", () => {
  it("present sources pass through with owner provenance and availability 'present'; local stays is_local:true", () => {
    const r = new ObserveRetention();
    const rows = r.reconcile(
      projection({
        sessions: [
          { id: "ses-local", owner: "self", ownerName: "Self", isLocal: true, title: "mine" },
          { id: "ses-remote", owner: "studio", ownerName: "Studio", isLocal: false, title: "studio work" },
        ],
        sources: { self: { present: true, count: 1 }, studio: { present: true, count: 1 } },
      }),
    );
    const byId = new Map(rows.map((x) => [x.id, x]));
    expect(byId.get("ses-local")!.amicode_availability).toBe("present");
    expect(byId.get("ses-local")!.amicode_owner.is_local).toBe(true);
    expect(byId.get("ses-remote")!.amicode_availability).toBe("present");
    expect(byId.get("ses-remote")!.amicode_owner.is_local).toBe(false);
    // never-local invariant: EVERY row carries an owner tag (a bare, tag-less row
    // is what the UI would render as local — that must never happen)
    expect(rows.every((x) => x.amicode_owner !== undefined)).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Source loss → retained sessions with "unavailable" availability
// ══════════════════════════════════════════════════════════════════════════════

describe("#1481 ObserveRetention — source loss retention", () => {
  it("a remote source that was present then goes absent → its sessions are RETAINED with availability 'unavailable', never dropped", () => {
    const r = new ObserveRetention();
    // First: both sources present.
    r.reconcile(
      projection({
        sessions: [
          { id: "ses-local", owner: "self", ownerName: "Self", isLocal: true },
          { id: "ses-remote", owner: "studio", ownerName: "Studio", isLocal: false, title: "studio work" },
        ],
        sources: { self: { present: true, count: 1 }, studio: { present: true, count: 1 } },
      }),
    );
    // Second: the studio source goes DOWN (present:false, fetch-failed).
    const rows = r.reconcile(
      projection({
        sessions: [{ id: "ses-local", owner: "self", ownerName: "Self", isLocal: true }],
        sources: { self: { present: true, count: 1 }, studio: { present: false, reason: "fetch-failed" } },
      }),
    );
    const byId = new Map(rows.map((x) => [x.id, x]));
    // the retained session is STILL in the list, never vanished
    expect(byId.has("ses-remote")).toBe(true);
    expect(byId.get("ses-remote")!.amicode_availability).toBe("unavailable");
    // its owner provenance is INTACT (the never-local invariant holds)
    expect(byId.get("ses-remote")!.amicode_owner.owner_machine_id).toBe("studio");
    expect(byId.get("ses-remote")!.amicode_owner.is_local).toBe(false);
    // the local session is unaffected
    expect(byId.get("ses-local")!.amicode_availability).toBe("present");
  });

  it("when the source RECOVERS, retained sessions are replaced by fresh data from the projection", () => {
    const r = new ObserveRetention();
    // First: present
    r.reconcile(
      projection({
        sessions: [
          { id: "ses-remote", owner: "studio", ownerName: "Studio", isLocal: false, title: "old title" },
        ],
        sources: { self: { present: true, count: 0 }, studio: { present: true, count: 1 } },
      }),
    );
    // Second: source lost
    r.reconcile(
      projection({
        sessions: [],
        sources: { self: { present: true, count: 0 }, studio: { present: false, reason: "fetch-failed" } },
      }),
    );
    // Third: source recovers with updated data
    const rows = r.reconcile(
      projection({
        sessions: [
          { id: "ses-remote", owner: "studio", ownerName: "Studio", isLocal: false, title: "new title" },
        ],
        sources: { self: { present: true, count: 0 }, studio: { present: true, count: 1 } },
      }),
    );
    const remote = rows.find((x) => x.id === "ses-remote");
    expect(remote).toBeDefined();
    expect(remote!.amicode_availability).toBe("present");
    expect((remote as Record<string, unknown>).title).toBe("new title");
  });

  it("local sessions are NEVER retained on source loss — only remote sessions", () => {
    const r = new ObserveRetention();
    r.reconcile(
      projection({
        sessions: [{ id: "ses-local", owner: "self", ownerName: "Self", isLocal: true }],
        sources: { self: { present: true, count: 1 } },
      }),
    );
    // Local source lost:
    const rows = r.reconcile(
      projection({
        sessions: [],
        sources: { self: { present: false, reason: "fetch-failed" } },
      }),
    );
    // Local sessions do NOT get retained — they are genuinely gone
    expect(rows.some((x) => x.id === "ses-local")).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Trust revocation → tombstone with sensitive data stripped
// ══════════════════════════════════════════════════════════════════════════════

describe("#1481 ObserveRetention — trust revocation tombstone", () => {
  it("revoking a source's trust produces tombstones: owner provenance + id are kept, sensitive metadata (title, directory) is stripped", () => {
    const r = new ObserveRetention();
    // First: trusted, present
    r.reconcile(
      projection({
        sessions: [
          { id: "ses-secret", owner: "studio", ownerName: "Studio", isLocal: false, title: "confidential plan", directory: "/secret/proj" },
        ],
        sources: { self: { present: true, count: 0 }, studio: { present: true, count: 1 } },
      }),
    );
    // Second: trust REVOKED (the source switches to untrusted or identity-conflict)
    const rows = r.reconcile(
      projection({
        sessions: [],
        sources: { self: { present: true, count: 0 }, studio: { present: false, reason: "untrusted" } },
      }),
    );
    const tombstone = rows.find((x) => x.id === "ses-secret");
    expect(tombstone).toBeDefined();
    expect(tombstone!.amicode_availability).toBe("revoked");
    // owner provenance is kept (it's non-sensitive — you know WHICH machine owned it)
    expect(tombstone!.amicode_owner.owner_machine_id).toBe("studio");
    expect(tombstone!.amicode_owner.is_local).toBe(false);
    // sensitive metadata is STRIPPED
    expect((tombstone as Record<string, unknown>).title).toBeUndefined();
    expect((tombstone as Record<string, unknown>).directory).toBeUndefined();
    expect(tombstone!.amicode_owner.directory).toBeUndefined();
  });

  it("identity-conflict also triggers tombstoning (it is a trust-breaking state)", () => {
    const r = new ObserveRetention();
    r.reconcile(
      projection({
        sessions: [
          { id: "ses-conflict", owner: "studio", ownerName: "Studio", isLocal: false, title: "private" },
        ],
        sources: { self: { present: true, count: 0 }, studio: { present: true, count: 1 } },
      }),
    );
    const rows = r.reconcile(
      projection({
        sessions: [],
        sources: { self: { present: true, count: 0 }, studio: { present: false, reason: "identity-conflict" } },
      }),
    );
    const tombstone = rows.find((x) => x.id === "ses-conflict");
    expect(tombstone).toBeDefined();
    expect(tombstone!.amicode_availability).toBe("revoked");
    expect((tombstone as Record<string, unknown>).title).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC3 remainder — peer loss, revoked trust, transport failure as named states
// ══════════════════════════════════════════════════════════════════════════════

describe("#1481 AC3 remainder — peer loss / revoked trust / transport failure row states", () => {
  it("a transport failure (fetch-failed) source produces 'unavailable' rows, not vanished ones", () => {
    const r = new ObserveRetention();
    r.reconcile(
      projection({
        sessions: [
          { id: "ses-a", owner: "peer-a", ownerName: "Peer A", isLocal: false },
          { id: "ses-b", owner: "peer-b", ownerName: "Peer B", isLocal: false },
        ],
        sources: { self: { present: true, count: 0 }, "peer-a": { present: true, count: 1 }, "peer-b": { present: true, count: 1 } },
      }),
    );
    // peer-a has transport failure; peer-b is fine
    const rows = r.reconcile(
      projection({
        sessions: [{ id: "ses-b", owner: "peer-b", ownerName: "Peer B", isLocal: false }],
        sources: { self: { present: true, count: 0 }, "peer-a": { present: false, reason: "fetch-failed" }, "peer-b": { present: true, count: 1 } },
      }),
    );
    const byId = new Map(rows.map((x) => [x.id, x]));
    expect(byId.get("ses-a")!.amicode_availability).toBe("unavailable");
    expect(byId.get("ses-b")!.amicode_availability).toBe("present");
    // one peer's failure never hides another's sessions
    expect(rows.length).toBe(2);
  });

  it("an unauthorized (revoked-trust) source produces 'revoked' tombstones, DISTINCT from 'unavailable' (transport failure)", () => {
    const r = new ObserveRetention();
    r.reconcile(
      projection({
        sessions: [{ id: "ses-revoked", owner: "rogue", ownerName: "Rogue", isLocal: false, title: "secret" }],
        sources: { self: { present: true, count: 0 }, rogue: { present: true, count: 1 } },
      }),
    );
    // The peer returned 401 → unauthorized (revoked trust)
    const rows = r.reconcile(
      projection({
        sessions: [],
        sources: { self: { present: true, count: 0 }, rogue: { present: false, reason: "unauthorized" } },
      }),
    );
    const row = rows.find((x) => x.id === "ses-revoked");
    expect(row).toBeDefined();
    expect(row!.amicode_availability).toBe("revoked");
    // sensitive data stripped (tombstone)
    expect((row as Record<string, unknown>).title).toBeUndefined();
  });

  it("the never-local invariant holds across all failure modes: every row always has amicode_owner", () => {
    const r = new ObserveRetention();
    r.reconcile(
      projection({
        sessions: [
          { id: "ses-1", owner: "p1", ownerName: "P1", isLocal: false },
          { id: "ses-2", owner: "p2", ownerName: "P2", isLocal: false },
          { id: "ses-3", owner: "p3", ownerName: "P3", isLocal: false },
        ],
        sources: { self: { present: true }, p1: { present: true }, p2: { present: true }, p3: { present: true } },
      }),
    );
    const rows = r.reconcile(
      projection({
        sessions: [],
        sources: {
          self: { present: true },
          p1: { present: false, reason: "fetch-failed" },
          p2: { present: false, reason: "unauthorized" },
          p3: { present: false, reason: "untrusted" },
        },
      }),
    );
    expect(rows.length).toBe(3);
    for (const row of rows) {
      expect(row.amicode_owner).toBeDefined();
      expect(row.amicode_owner.owner_machine_id).toBeTruthy();
      expect(row.amicode_owner.is_local).toBe(false);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC2 — session badge + filter model
// ══════════════════════════════════════════════════════════════════════════════

describe("#1481 AC2 — session badge + filter model from ObserveRetention rows", () => {
  it("each row carries a machine badge (owner_name + is_local); local sessions have no badge", () => {
    const r = new ObserveRetention();
    const rows = r.reconcile(
      projection({
        sessions: [
          { id: "ses-local", owner: "self", ownerName: "MacBook", isLocal: true },
          { id: "ses-studio", owner: "studio", ownerName: "Mac Studio", isLocal: false },
          { id: "ses-mini", owner: "mini", ownerName: "Mac Mini", isLocal: false },
        ],
        sources: { self: { present: true }, studio: { present: true }, mini: { present: true } },
      }),
    );
    // Remote sessions carry a badge (owner_name + device info)
    const studio = rows.find((x) => x.id === "ses-studio")!;
    expect(studio.amicode_owner.owner_name).toBe("Mac Studio");
    expect(studio.amicode_owner.is_local).toBe(false);
    // Local sessions: is_local:true → the UI renders no badge
    const local = rows.find((x) => x.id === "ses-local")!;
    expect(local.amicode_owner.is_local).toBe(true);
  });

  it("rows can be filtered by machine — distinct machines from the row set", () => {
    const r = new ObserveRetention();
    const rows = r.reconcile(
      projection({
        sessions: [
          { id: "s1", owner: "self", ownerName: "MacBook", isLocal: true },
          { id: "s2", owner: "studio", ownerName: "Mac Studio", isLocal: false },
          { id: "s3", owner: "studio", ownerName: "Mac Studio", isLocal: false },
          { id: "s4", owner: "mini", ownerName: "Mac Mini", isLocal: false },
        ],
        sources: { self: { present: true }, studio: { present: true }, mini: { present: true } },
      }),
    );
    // Filter by machine
    const studioRows = rows.filter((x) => x.amicode_owner.owner_machine_id === "studio");
    expect(studioRows).toHaveLength(2);
    // Distinct machines derivable from the row set
    const machines = [...new Set(rows.map((x) => x.amicode_owner.owner_machine_id))];
    expect(machines.sort()).toEqual(["mini", "self", "studio"]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// fetchRemoteTranscript — static GET-only read-only transcript fetch
// ══════════════════════════════════════════════════════════════════════════════

describe("#1481 fetchRemoteTranscript — read-only remote transcript view", () => {
  it("fetches a remote session's messages via GET (read-only, no mutation)", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ messages: [{ role: "user", content: "hello" }] }),
    });
    const result = await fetchRemoteTranscript({
      baseUrl: "http://studio:43117",
      sessionId: "ses-remote-1",
      token: "tok-studio",
      fetchImpl: mockFetch as unknown as typeof fetch,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].role).toBe("user");
    }
    // verified GET (read-only, never POST/PATCH/DELETE)
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain("/session/ses-remote-1");
    expect(opts.method ?? "GET").toBe("GET");
  });

  it("returns a named failure on transport error (not a throw)", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await fetchRemoteTranscript({
      baseUrl: "http://down:43117",
      sessionId: "ses-x",
      token: "tok",
      fetchImpl: mockFetch as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("transport-error");
    }
  });

  it("returns a named failure on 401 (revoked trust, not a throw)", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    const result = await fetchRemoteTranscript({
      baseUrl: "http://studio:43117",
      sessionId: "ses-x",
      token: "stale-tok",
      fetchImpl: mockFetch as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("unauthorized");
    }
  });
});
