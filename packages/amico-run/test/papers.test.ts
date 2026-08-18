// The unified literature corpus fold (#405): one read-only view over vault
// papers/ notes + the library PDF store — collected, unified, deduped by
// identity, content-addressed join, orphans surfaced. The fold NEVER writes
// (dedup reports; merging is a human promote act).
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foldCorpus } from "../src/papers.js";
let root: string;
let vaultA: string;
let vaultB: string;
let library: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "papers-fold-"));
  vaultA = join(root, "vaults", "personal");
  vaultB = join(root, "vaults", "team");
  library = join(root, "library");
  mkdirSync(join(vaultA, "papers"), { recursive: true });
  mkdirSync(join(vaultB, "papers"), { recursive: true });
  mkdirSync(library, { recursive: true });
});
const cleanup = () => rmSync(root, { recursive: true, force: true });

const TEMPO = `---
type: paper
title: "Efficient non-Markovian quantum dynamics using TEMPO"
authors: [Strathearn, Kirton, Kilda, Keeling, Lovett]
arxiv: "1711.09641"
date_read: 2026-07-03
relevance: high
systems: [transmon, bosonic]
tags: [paper, tempo]
---

# TEMPO
Body text.
`;

function note(dir: string, file: string, fm: string) {
  writeFileSync(join(dir, "papers", file), `---\n${fm}\n---\n\n# t\n`);
}

describe("foldCorpus", () => {
  it("unifies notes across mounts, validates each, and reports invalid notes without dying", () => {
    note(vaultA, "tempo.md", `type: paper\ntitle: "TEMPO"\nauthors: [S]\narxiv: "1711.09641"`);
    note(vaultB, "bad.md", `type: paper\ntitle: "No identity"\nauthors: [X]`);
    const r = foldCorpus([join(root, "vaults")], library);
    expect(r.papers.map((p) => p.arxiv)).toEqual(["1711.09641"]);
    expect(r.invalid).toHaveLength(1);
    expect(r.invalid[0]!.file).toContain("bad.md");
    expect(r.invalid[0]!.errors.join()).toMatch(/arxiv|doi/);
    cleanup();
  });

  it("dedups by normalized identity — version suffixes fold to the same arxiv id, REPORTED not merged", () => {
    note(vaultA, "a.md", `type: paper\ntitle: "T1"\nauthors: [A]\narxiv: "1711.09641"`);
    note(vaultB, "b.md", `type: paper\ntitle: "T1 v2 reading"\nauthors: [A]\narxiv: "1711.09641v2"`);
    const r = foldCorpus([join(root, "vaults")], library);
    expect(r.papers).toHaveLength(2); // both notes exist
    expect(r.duplicates).toHaveLength(1);
    expect(r.duplicates[0]!.key).toBe("arxiv:1711.09641");
    expect(r.duplicates[0]!.files).toHaveLength(2);
    cleanup();
  });

  it("joins library PDFs by identity in the filename, content-addressed; orphans both ways", () => {
    note(vaultA, "tempo.md", `type: paper\ntitle: "TEMPO"\nauthors: [S]\narxiv: "1711.09641"`);
    const pdf1 = join(library, "1711.09641.pdf");
    writeFileSync(pdf1, "%PDF-fake-tempo");
    const pdf2 = join(library, "someone-shared-this.pdf");
    writeFileSync(pdf2, "%PDF-no-identity");
    const r = foldCorpus([join(root, "vaults")], library);
    const tempo = r.papers.find((p) => p.arxiv === "1711.09641")!;
    expect(tempo.pdf).toMatchObject({ file: pdf1 });
    expect(tempo.pdf!.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(r.orphanPdfs.map((o) => o.file)).toEqual([pdf2]);
    expect(r.recordsWithoutPdf.map((x) => x.title)).toEqual([]); // tempo HAS a pdf
    cleanup();
  });

  it("records without a matching PDF are surfaced (the acquisition to-do list)", () => {
    note(vaultA, "tempo.md", `type: paper\ntitle: "TEMPO"\nauthors: [S]\narxiv: "1711.09641"`);
    const r = foldCorpus([join(root, "vaults")], library);
    expect(r.recordsWithoutPdf).toHaveLength(1);
    cleanup();
  });

  it("missing roots degrade to empty — the fold never throws for absence", () => {
    const r = foldCorpus([join(root, "no-vaults")], join(root, "no-library"));
    expect(r.papers).toEqual([]);
    expect(r.duplicates).toEqual([]);
    expect(r.invalid).toEqual([]);
    cleanup();
  });

  // Machine-local parity: the production notes are the contract's source of
  // truth — but they exist only on a machine carrying the real vaults. CI
  // runners have none; the fold returns 0 there and the check is meaningless.
  // (The contract itself is pinned by the schema suite's fixtures-by-copy.)
  it.skipIf(!existsSync("/Users/aaron/.amico/vaults/vault-aaron/papers"))(
    "THE REAL CORPUS: the production notes validate against the contract unchanged",
    () => {
      const real = "/Users/aaron/.amico/vaults/vault-aaron/papers";
      const r = foldCorpus(["/Users/aaron/.amico/vaults"], "/Users/aaron/.amico/library");
      expect(r.invalid.filter((x) => x.file.startsWith(real))).toEqual([]);
      expect(r.papers.filter((p) => p.file.startsWith(real)).length).toBeGreaterThanOrEqual(2);
      cleanup();
    },
  );
});
