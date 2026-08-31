// project.ts — pure logic for research project entities (issue #665).
//
// Schema definition, validation, slug generation, scaffolding, and template
// rendering. NO filesystem I/O — that lives in project_verb.ts. This module
// is the unit-testable core.

// ── schema types ────────────────────────────────────────────────────────────

export const PROJECT_STATUSES = [
  "proposing",
  "designing",
  "running",
  "analyzing",
  "writing",
  "complete",
] as const;

export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export interface ProjectToml {
  schema_version: number;
  name: string;
  slug: string;
  question: string;
  status: ProjectStatus;
  created: string; // YYYY-MM-DD
  tags?: string[];
  authors?: {
    lead?: string;
    collaborators?: string[];
  };
  venue?: {
    name?: string;
    deadline?: string;
  };
  domain_pack?: {
    name?: string;
  };
  links?: {
    related_projects?: string[];
    doi?: string;
  };
}

// ── validation ──────────────────────────────────────────────────────────────

export type ValidationResult =
  | { ok: true }
  | { ok: false; errors: string[] };

const REQUIRED_FIELDS: (keyof ProjectToml)[] = [
  "schema_version",
  "name",
  "slug",
  "question",
  "status",
  "created",
];

export function validateProjectToml(data: unknown): ValidationResult {
  if (typeof data !== "object" || data === null) {
    return { ok: false, errors: ["project.toml must be a TOML table (object)"] };
  }

  const obj = data as Record<string, unknown>;
  const errors: string[] = [];

  for (const field of REQUIRED_FIELDS) {
    if (obj[field] === undefined || obj[field] === null) {
      errors.push(`missing required field: ${field}`);
    }
  }

  if (typeof obj.schema_version !== "undefined" && typeof obj.schema_version !== "number") {
    errors.push("schema_version must be an integer");
  }

  if (typeof obj.status === "string" && !(PROJECT_STATUSES as readonly string[]).includes(obj.status)) {
    errors.push(
      `invalid status "${obj.status}" — must be one of: ${PROJECT_STATUSES.join(", ")}`,
    );
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

// ── slug generation ─────────────────────────────────────────────────────────

export function nameToSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ── scaffolding data ────────────────────────────────────────────────────────

/** The prescribed directory layout for a Research Project (PRD #663). */
export const SCAFFOLD_DIRS = [
  "scripts",
  "scripts/testbed",
  "data/raw",
  "data/processed",
  "data/plots",
  "analysis",
  "paper/figures",
  "paper/supplementary",
  "ledger/hypotheses",
  "ledger/observations",
  "ledger/literature",
  "ledger/campaigns",
  "reports/weekly",
  "reports/presentations",
  "reports/milestones",
  "config",
  "skills",
] as const;

// ── TOML rendering ──────────────────────────────────────────────────────────

/** Render a ProjectToml to a TOML string. We hand-render to control section
 *  ordering and comments — smol-toml's stringify would work but produces less
 *  readable output for a manifest the user will edit. */
export function renderProjectToml(p: ProjectToml): string {
  const lines: string[] = [];
  lines.push(`schema_version = ${p.schema_version}`);
  lines.push(`name = ${q(p.name)}`);
  lines.push(`slug = ${q(p.slug)}`);
  lines.push(`question = ${q(p.question)}`);
  lines.push(`status = ${q(p.status)}`);
  lines.push(`created = ${q(p.created)}`);

  if (p.tags && p.tags.length > 0) {
    lines.push(`tags = [${p.tags.map(q).join(", ")}]`);
  }

  if (p.authors) {
    lines.push("");
    lines.push("[authors]");
    if (p.authors.lead) lines.push(`lead = ${q(p.authors.lead)}`);
    if (p.authors.collaborators && p.authors.collaborators.length > 0) {
      lines.push(`collaborators = [${p.authors.collaborators.map(q).join(", ")}]`);
    }
  }

  if (p.venue) {
    lines.push("");
    lines.push("[venue]");
    if (p.venue.name) lines.push(`name = ${q(p.venue.name)}`);
    if (p.venue.deadline) lines.push(`deadline = ${q(p.venue.deadline)}`);
  }

  if (p.domain_pack) {
    lines.push("");
    lines.push("[domain_pack]");
    if (p.domain_pack.name) lines.push(`name = ${q(p.domain_pack.name)}`);
  }

  if (p.links) {
    lines.push("");
    lines.push("[links]");
    if (p.links.related_projects && p.links.related_projects.length > 0) {
      lines.push(`related_projects = [${p.links.related_projects.map(q).join(", ")}]`);
    }
    if (p.links.doi) lines.push(`doi = ${q(p.links.doi)}`);
  }

  lines.push(""); // trailing newline
  return lines.join("\n");
}

function q(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// ── template content ────────────────────────────────────────────────────────

/** Venue → LaTeX document class mapping. */
export function venueToDocumentClass(venue?: string): "revtex" | "minimal" {
  if (!venue) return "minimal";
  const v = venue.toLowerCase();
  if (v.includes("physical review letters") || v === "prl") return "revtex";
  if (v.includes("physical review x") || v === "prx") return "revtex";
  return "minimal";
}

export function renderMainTex(name: string, venue?: string): string {
  const cls = venueToDocumentClass(venue);
  if (cls === "revtex") {
    return `\\documentclass[aps,prl,twocolumn,superscriptaddress]{revtex4-2}
\\usepackage{amsmath,amssymb,graphicx,hyperref}

\\begin{document}

\\title{${texEscape(name)}}
\\author{TODO}
\\affiliation{TODO}

\\begin{abstract}
TODO
\\end{abstract}

\\maketitle

\\section{Introduction}
\\label{sec:intro}

% TODO

\\bibliography{references}

\\end{document}
`;
  }
  return `\\documentclass[11pt]{article}
\\usepackage{amsmath,amssymb,graphicx,hyperref}

\\title{${texEscape(name)}}
\\author{TODO}
\\date{\\today}

\\begin{document}
\\maketitle

\\begin{abstract}
TODO
\\end{abstract}

\\section{Introduction}
\\label{sec:intro}

% TODO

\\bibliographystyle{plain}
\\bibliography{references}

\\end{document}
`;
}

function texEscape(s: string): string {
  return s.replace(/[&%$#_{}~^\\]/g, (c) => `\\${c}`);
}

export function renderOutlineMd(name: string, question: string, venue?: string): string {
  const cls = venueToDocumentClass(venue);
  const header = `---
status: draft
last_reviewed:
sections_approved: []
---

# ${name}

**Research question:** ${question}

`;
  if (cls === "revtex") {
    return `${header}## Outline (PRL/PRX compressed format)

### Abstract
- [ ] TODO

### Introduction
- [ ] TODO

### Results
- [ ] TODO

### Discussion
- [ ] TODO

### Methods
- [ ] TODO

### Supplementary
- [ ] TODO
`;
  }
  return `${header}## Outline

### Abstract
- [ ] TODO

### Introduction
- [ ] TODO

### Methods
- [ ] TODO

### Results
- [ ] TODO

### Discussion
- [ ] TODO

### Conclusion
- [ ] TODO
`;
}

export function renderReadme(name: string, question: string): string {
  return `# ${name}

${question}

## Layout

- \`scripts/\` — experiment scripts (\`testbed/\` for scratch work)
- \`data/\` — raw, processed, and plot outputs
- \`analysis/\` — analysis notebooks and post-processing
- \`paper/\` — manuscript (\`outline.md\` → \`main.tex\`)
- \`ledger/\` — hypotheses, observations, literature, and campaign logs
- \`reports/\` — weekly updates, presentations, and milestone reports
- \`config/\` — system and lab configuration
- \`skills/\` — project-specific Amico skills
`;
}

export const WEEKLY_REPORT_TEMPLATE = `---
date: YYYY-MM-DD
author: 
period: YYYY-MM-DD to YYYY-MM-DD
status: draft
---

# Weekly Update — [period]

## Progress
- 

## Key Results
- 

## Blockers
- 

## Next Week
- 

## Notes
`;

export const ROOT_GITIGNORE = `# Data artifacts (large binary files)
data/raw/**/*.jld2
data/raw/**/*.hdf5
data/raw/**/*.h5

# Python
*.pyc
__pycache__/

# OS
.DS_Store
`;

export const PAPER_GITIGNORE = `# LaTeX build artifacts
*.aux
*.bbl
*.blg
*.log
*.out
*.toc
*.synctex.gz
*.fdb_latexmk
*.fls
*.pdf
`;

export const PAPER_LATEXMKRC = `$pdflatex = 'pdflatex -interaction=nonstopmode %O %S';
`;

export const SCRIPTS_README = `# Scripts

Experiment scripts for this project. Use \`testbed/\` for scratch work and quick experiments.
`;

/** Build the full scaffold manifest: relative paths and their contents. Files
 *  with `null` content are directories (created with mkdirSync). */
export function scaffoldManifest(
  p: ProjectToml,
): { path: string; content: string | null }[] {
  const items: { path: string; content: string | null }[] = [];

  // directories
  for (const dir of SCAFFOLD_DIRS) {
    items.push({ path: dir, content: null });
  }

  // root files
  items.push({ path: "project.toml", content: renderProjectToml(p) });
  items.push({ path: "README.md", content: renderReadme(p.name, p.question) });
  items.push({ path: ".gitignore", content: ROOT_GITIGNORE });

  // scripts/
  items.push({ path: "scripts/README.md", content: SCRIPTS_README });

  // paper/
  items.push({ path: "paper/outline.md", content: renderOutlineMd(p.name, p.question, p.venue?.name) });
  items.push({ path: "paper/main.tex", content: renderMainTex(p.name, p.venue?.name) });
  items.push({ path: "paper/references.bib", content: "" });
  items.push({ path: "paper/latexmkrc", content: PAPER_LATEXMKRC });
  items.push({ path: "paper/.gitignore", content: PAPER_GITIGNORE });

  // config/ stubs
  items.push({ path: "config/system.toml", content: "# System configuration\n" });
  items.push({ path: "config/lab.toml", content: "# Lab configuration\n" });

  // reports/
  items.push({ path: "reports/weekly/template.md", content: WEEKLY_REPORT_TEMPLATE });

  return items;
}
