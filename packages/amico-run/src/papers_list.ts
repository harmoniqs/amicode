// papers_list.ts — the `amico papers list` body: fold + filter + render.
// Pure rendering decisions live in papers_render.ts; the fold is papers.ts.
import { papersFilters, renderCorpusTable } from "./papers_render.js";
import { foldCorpus } from "./papers.js";
import { studioPathsOrLegacy } from "@amicode/schema";
import { homedir } from "node:os";
import { join } from "node:path";
import type { VerbResult } from "./verbs.js";
import type { CorpusReport, PaperRecord } from "./papers.js";

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

function corpusCounts(corpus: CorpusReport, shown: number): Record<string, number> {
  return {
    papers: shown,
    total: corpus.papers.length,
    duplicates: corpus.duplicates.length,
    invalid: corpus.invalid.length,
    orphan_pdfs: corpus.orphanPdfs.length,
    records_without_pdf: corpus.recordsWithoutPdf.length,
  };
}

export function papersList(argv: string[]): VerbResult {
  const asJson = argv.includes("--json");
  const filters = papersFilters({
    status: flagValue(argv, "--status"),
    tag: flagValue(argv, "--tag"),
    platform: flagValue(argv, "--platform"),
    q: flagValue(argv, "--q"),
  });

  // Hermetic escapes win; production roots ride the studio ladder.
  const vaults = process.env.AMICO_PAPERS_VAULTS ?? studioPathsOrLegacy().vaultsRoot;
  const library = process.env.AMICO_PAPERS_LIBRARY ?? join(homedir(), ".amico", "library");
  const corpus = foldCorpus([vaults], library);
  const papers: PaperRecord[] = corpus.papers.filter(filters);

  const payload = papers.map((p) => ({
    title: p.title,
    authors: p.authors,
    arxiv: p.arxiv ?? null,
    doi: p.doi ?? null,
    status: p.status,
    relevance: p.relevance ?? null,
    systems: p.systems,
    tags: p.tags,
    file: p.file,
    pdf: p.pdf ? { file: p.pdf.file, sha256: p.pdf.sha256 } : null,
  }));

  if (asJson) {
    return {
      json: {
        ok: true,
        papers: payload,
        counts: corpusCounts(corpus, papers.length),
        duplicates: corpus.duplicates,
        invalid: corpus.invalid,
        orphan_pdfs: corpus.orphanPdfs,
        records_without_pdf: corpus.recordsWithoutPdf,
      },
      code: 0,
    };
  }

  return {
    json: { ok: true, table: renderCorpusTable(papers, corpus), counts: corpusCounts(corpus, papers.length) },
    code: 0,
  };
}
