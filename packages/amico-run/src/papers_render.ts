// papers_render.ts — pure filter + table rendering for `amico papers list`.
// No I/O; trivially testable.
import type { CorpusReport, PaperRecord } from "./papers.js";

export interface FilterSpec {
  status?: string;
  tag?: string;
  platform?: string;
  q?: string;
}

/** Build the predicate chain — each present flag ANDs. */
export function papersFilters(spec: FilterSpec): (p: PaperRecord) => boolean {
  const tests: ((p: PaperRecord) => boolean)[] = [];
  if (spec.status) {
    const want = spec.status as PaperRecord["status"];
    tests.push((p) => p.status === want);
  }
  if (spec.tag) tests.push((p) => p.tags.includes(spec.tag!));
  if (spec.platform) tests.push((p) => p.systems.includes(spec.platform!));
  if (spec.q) {
    const needle = spec.q.toLowerCase();
    tests.push((p) =>
      [p.title, ...p.authors, p.arxiv ?? "", p.doi ?? "", ...p.tags].some((s) => s.toLowerCase().includes(needle)),
    );
  }
  return (p) => tests.every((t) => t(p));
}

/** The human table: title · identity · status · systems · pdf?. */
export function renderCorpusTable(papers: PaperRecord[], corpus: CorpusReport): string {
  const ident = (p: PaperRecord) => p.arxiv ? `arXiv:${p.arxiv}` : p.doi ? `doi:${p.doi}` : "?";
  const rows = papers.map((p) => [p.title.slice(0, 52), ident(p), p.status, p.systems.join(","), p.pdf ? "pdf" : "—"]);
  const width = [56, 22, 8, 16, 3].map((w, i) => Math.max(w, ...rows.map((r) => r[i]!.length)));
  const lines = [
    `${"title".padEnd(width[0]!)}  ${"identity".padEnd(width[1]!)}  ${"status".padEnd(width[2]!)}  ${"systems".padEnd(width[3]!)}  pdf`,
    ...rows.map((r) => r.map((c, i) => c.padEnd(width[i]!)).join("  ")),
  ];
  if (corpus.duplicates.length) lines.push(``, `duplicates: ${corpus.duplicates.map((d) => `${d.key} ×${d.files.length}`).join(", ")}`);
  if (corpus.invalid.length) lines.push(`invalid notes: ${corpus.invalid.length} (amico papers list --json for files)`);
  if (corpus.orphanPdfs.length) lines.push(`orphan pdfs: ${corpus.orphanPdfs.length}`);
  if (corpus.recordsWithoutPdf.length) lines.push(`records without pdfs: ${corpus.recordsWithoutPdf.length} (the acquisition to-do list)`);
  return lines.join("\n");
}
