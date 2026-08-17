// The `library-paper` kind (#405): the paper record — the note frontmatter
// contract, formalized from the two real vault notes (TEMPO, mitten-qLDPC —
// the source of truth, proven in production). Identity: title+authors and at
// least one of arxiv/doi; lifecycle: staged→distilled (absent = distilled,
// the historical notes); provenance and scoping strictly typed when present.
import { describe, it, expect } from "vitest";
import { validate, SUPPORTED_VERSIONS_BY_KIND } from "../src/index.js";

const rec = (over: Record<string, unknown> = {}) => ({
  type: "paper",
  title: "Efficient non-Markovian quantum dynamics using TEMPO",
  authors: ["Strathearn", "Kirton", "Kilda", "Keeling", "Lovett"],
  arxiv: "1711.09641",
  date_read: "2026-07-03",
  relevance: "high",
  systems: ["transmon", "bosonic"],
  tags: ["paper", "tempo", "process-tensor"],
  ...over,
});
const drop = (o: Record<string, unknown>, k: string) => {
  const c = { ...o };
  delete c[k];
  return c;
};

describe("the library-paper kind", () => {
  it("accepts the TEMPO note's frontmatter, unchanged (real-data parity)", () => {
    expect(validate(rec(), "library-paper")).toMatchObject({ ok: true });
  });
  it("accepts the mitten-qLDPC shape — doi instead of arxiv, route_intent tolerated", () => {
    expect(validate(rec({ arxiv: undefined, doi: "10.48550/arXiv.2607.28795", route_intent: "team" }), "library-paper")).toMatchObject({ ok: true });
  });
  it("requires BOTH title and authors", () => {
    expect(validate(drop(rec(), "title"), "library-paper").ok).toBe(false);
    expect(validate(drop(rec(), "authors"), "library-paper").ok).toBe(false);
  });
  it("requires an identity key — arxiv or doi; bare records refuse", () => {
    expect(validate(drop(rec(), "arxiv"), "library-paper").ok).toBe(false);
    expect(validate(drop({ ...rec(), doi: "10.1234/x" }, "arxiv"), "library-paper").ok).toBe(true);
  });
  it("status is the lifecycle enum; ABSENT means distilled (the historical notes)", () => {
    expect(validate(rec({ status: "staged" }), "library-paper")).toMatchObject({ ok: true });
    expect(validate(rec({ status: "published" }), "library-paper").ok).toBe(false);
  });
  it("relevance: enum for queryability; PROSE relevance tolerated (production data)", () => {
    expect(validate(rec({ relevance: "Original transmon paper; foundational reference for all transmon work" }), "library-paper")).toMatchObject({ ok: true });
    expect(validate(rec({ relevance: 3 }), "library-paper").ok).toBe(false);
  });
  it("null arxiv is type-tolerated but identity still required (the anyOf flags the gap)", () => {
    expect(validate(rec({ arxiv: null, doi: "10.1234/x" }), "library-paper")).toMatchObject({ ok: true });
    expect(validate(rec({ arxiv: null }), "library-paper").ok).toBe(false);
  });
  it("the team vault's vocabulary is absorbed: journal/published/species/read_depth/hardware/promoted_from", () => {
    expect(
      validate(
        rec({ journal: "PRX Quantum 3, 040336 (2022)", published: "2025-09-24", species: "cesium", read_depth: "skim", hardware: "ibm-heron-boston", promoted_from: null }),
        "library-paper",
      ),
    ).toMatchObject({ ok: true });
  });
  it("arxiv ids: dotted form, version suffix TOLERATED (the fold normalizes); garbage refuses", () => {
    expect(validate(rec({ arxiv: "1711.09641v2" }), "library-paper").ok).toBe(true);
    expect(validate(rec({ arxiv: "not-an-id" }), "library-paper").ok).toBe(false);
  });
  it("provenance: source is an enum of the known pipelines; session_id a string", () => {
    expect(validate(rec({ source: "dream-distill", source_session: "71907fc9" }), "library-paper")).toMatchObject({ ok: true });
    expect(validate(rec({ source: "vibes" }), "library-paper").ok).toBe(false);
  });
  it("type must be paper; unknown keys refuse (strict — we own both sides)", () => {
    expect(validate(rec({ type: "spec" }), "library-paper").ok).toBe(false);
    expect(validate(rec({ banana: 1 }), "library-paper").ok).toBe(false);
  });
  it("registered WITHOUT a version map entry — notes carry no schema_version (the ledger-record pattern)", () => {
    expect((SUPPORTED_VERSIONS_BY_KIND as Record<string, string[]>)["library-paper"]).toBeUndefined();
  });
});
