// `amico project` — research project entity: schema validation, scaffolding,
// and CLI verbs (create / import). Pure logic in project.ts; verb I/O in
// project_verb.ts. Part of #665.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  validateProjectToml,
  nameToSlug,
  scaffoldManifest,
  venueToDocumentClass,
  renderMainTex,
  renderOutlineMd,
  renderProjectToml,
  SCAFFOLD_DIRS,
  ROOT_GITIGNORE,
  PAPER_GITIGNORE,
  PAPER_LATEXMKRC,
  type ProjectToml,
} from "../src/project.js";

// ── pure logic: schema validation ──────────────────────────────────────────

describe("validateProjectToml", () => {
  const valid: ProjectToml = {
    schema_version: 1,
    name: "Diraq ESR X-gate study",
    slug: "diraq-esr-x-gate-study",
    question: "Can we achieve F > 0.999 for a 29Si-robust X gate?",
    status: "proposing",
    created: "2026-08-31",
    tags: ["transmon", "esr"],
    authors: { lead: "JJ Lee" },
    domain_pack: { name: "quantum-control" },
  };

  it("accepts a valid project.toml with all required fields", () => {
    const result = validateProjectToml(valid);
    expect(result.ok).toBe(true);
  });

  it("accepts a minimal project.toml (required fields only)", () => {
    const minimal: ProjectToml = {
      schema_version: 1,
      name: "My Project",
      slug: "my-project",
      question: "What happens?",
      status: "proposing",
      created: "2026-08-31",
    };
    const result = validateProjectToml(minimal);
    expect(result.ok).toBe(true);
  });

  it("rejects missing required field: name", () => {
    const bad = { ...valid, name: undefined } as unknown as ProjectToml;
    const result = validateProjectToml(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e: string) => e.includes("name"))).toBe(true);
  });

  it("rejects missing required field: schema_version", () => {
    const bad = { ...valid, schema_version: undefined } as unknown as ProjectToml;
    const result = validateProjectToml(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e: string) => e.includes("schema_version"))).toBe(true);
  });

  it("rejects invalid status enum value", () => {
    const bad = { ...valid, status: "thinking" } as unknown as ProjectToml;
    const result = validateProjectToml(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e: string) => e.includes("status"))).toBe(true);
  });

  it("accepts all valid status values", () => {
    for (const s of ["proposing", "designing", "running", "analyzing", "writing", "complete"]) {
      const result = validateProjectToml({ ...valid, status: s as ProjectToml["status"] });
      expect(result.ok).toBe(true);
    }
  });

  it("tolerates unknown extra fields (forward-compatible)", () => {
    const extended = { ...valid, future_field: "surprise" } as unknown as ProjectToml;
    const result = validateProjectToml(extended);
    expect(result.ok).toBe(true);
  });
});

// ── pure logic: slug generation ────────────────────────────────────────────

describe("nameToSlug", () => {
  it("converts a project name to kebab-case slug", () => {
    expect(nameToSlug("Diraq ESR X-gate study")).toBe("diraq-esr-x-gate-study");
  });

  it("strips non-alphanumeric characters", () => {
    expect(nameToSlug("My Cool Project!!!")).toBe("my-cool-project");
  });

  it("collapses multiple hyphens", () => {
    expect(nameToSlug("a -- b --- c")).toBe("a-b-c");
  });

  it("trims leading/trailing hyphens", () => {
    expect(nameToSlug("  --hello-- ")).toBe("hello");
  });
});

// ── pure logic: scaffold manifest ──────────────────────────────────────────

describe("scaffoldManifest", () => {
  const project: ProjectToml = {
    schema_version: 1,
    name: "Test Project",
    slug: "test-project",
    question: "Does it work?",
    status: "proposing",
    created: "2026-08-31",
  };

  it("includes all prescribed directories from the PRD", () => {
    const manifest = scaffoldManifest(project);
    const dirs = manifest.filter((m) => m.content === null).map((m) => m.path);
    for (const expected of SCAFFOLD_DIRS) {
      expect(dirs).toContain(expected);
    }
  });

  it("produces project.toml, README.md, .gitignore at root", () => {
    const manifest = scaffoldManifest(project);
    const files = manifest.filter((m) => m.content !== null).map((m) => m.path);
    expect(files).toContain("project.toml");
    expect(files).toContain("README.md");
    expect(files).toContain(".gitignore");
  });

  it("produces paper/ files: outline.md, main.tex, references.bib, latexmkrc, .gitignore", () => {
    const manifest = scaffoldManifest(project);
    const files = manifest.filter((m) => m.content !== null).map((m) => m.path);
    expect(files).toContain("paper/outline.md");
    expect(files).toContain("paper/main.tex");
    expect(files).toContain("paper/references.bib");
    expect(files).toContain("paper/latexmkrc");
    expect(files).toContain("paper/.gitignore");
  });

  it("produces scripts/README.md", () => {
    const manifest = scaffoldManifest(project);
    const files = manifest.filter((m) => m.content !== null).map((m) => m.path);
    expect(files).toContain("scripts/README.md");
  });

  it("produces config stubs: system.toml, lab.toml", () => {
    const manifest = scaffoldManifest(project);
    const files = manifest.filter((m) => m.content !== null).map((m) => m.path);
    expect(files).toContain("config/system.toml");
    expect(files).toContain("config/lab.toml");
  });
});

// ── pure logic: TOML rendering round-trip ──────────────────────────────────

describe("renderProjectToml", () => {
  it("produces parseable TOML with all required fields", () => {
    const project: ProjectToml = {
      schema_version: 1,
      name: "Test Project",
      slug: "test-project",
      question: "Does it work?",
      status: "proposing",
      created: "2026-08-31",
    };
    const toml = renderProjectToml(project);
    expect(toml).toContain('name = "Test Project"');
    expect(toml).toContain("schema_version = 1");
    expect(toml).toContain('status = "proposing"');
  });
});

// ── pure logic: venue-aware templates ──────────────────────────────────────

describe("venueToDocumentClass", () => {
  it("maps Physical Review Letters to revtex", () => {
    expect(venueToDocumentClass("Physical Review Letters")).toBe("revtex");
  });

  it("maps Physical Review X to revtex", () => {
    expect(venueToDocumentClass("Physical Review X")).toBe("revtex");
  });

  it("maps PRL shorthand to revtex", () => {
    expect(venueToDocumentClass("PRL")).toBe("revtex");
  });

  it("maps unknown venue to minimal", () => {
    expect(venueToDocumentClass("Nature Physics")).toBe("minimal");
  });

  it("maps undefined venue to minimal", () => {
    expect(venueToDocumentClass(undefined)).toBe("minimal");
  });
});

describe("renderMainTex", () => {
  it("uses revtex4-2 document class for PRL", () => {
    const tex = renderMainTex("My Paper", "Physical Review Letters");
    expect(tex).toContain("revtex4-2");
    expect(tex).toContain("\\title{My Paper}");
  });

  it("uses article document class for unknown venues", () => {
    const tex = renderMainTex("My Paper", "Nature Physics");
    expect(tex).toContain("\\documentclass[11pt]{article}");
    expect(tex).not.toContain("revtex");
  });

  it("uses article when no venue specified", () => {
    const tex = renderMainTex("My Paper");
    expect(tex).toContain("\\documentclass[11pt]{article}");
  });
});

describe("renderOutlineMd", () => {
  it("includes YAML frontmatter with draft status", () => {
    const md = renderOutlineMd("Test", "What?");
    expect(md).toMatch(/^---\nstatus: draft/);
    expect(md).toContain("sections_approved: []");
  });

  it("uses compressed PRL format for Physical Review Letters", () => {
    const md = renderOutlineMd("Test", "What?", "Physical Review Letters");
    expect(md).toContain("PRL/PRX compressed format");
    expect(md).not.toContain("### Conclusion");
  });

  it("uses full section format for unknown venues", () => {
    const md = renderOutlineMd("Test", "What?");
    expect(md).toContain("### Conclusion");
  });
});

// ── pure logic: gitignore content ──────────────────────────────────────────

describe("gitignore content", () => {
  it("root .gitignore includes jld2/hdf5/h5 patterns", () => {
    expect(ROOT_GITIGNORE).toContain("*.jld2");
    expect(ROOT_GITIGNORE).toContain("*.hdf5");
    expect(ROOT_GITIGNORE).toContain("*.h5");
    expect(ROOT_GITIGNORE).toContain("__pycache__/");
    expect(ROOT_GITIGNORE).toContain(".DS_Store");
  });

  it("paper .gitignore excludes LaTeX build artifacts", () => {
    expect(PAPER_GITIGNORE).toContain("*.aux");
    expect(PAPER_GITIGNORE).toContain("*.bbl");
    expect(PAPER_GITIGNORE).toContain("*.synctex.gz");
    expect(PAPER_GITIGNORE).toContain("*.fdb_latexmk");
    expect(PAPER_GITIGNORE).toContain("*.pdf");
  });

  it("paper/latexmkrc has the correct content", () => {
    expect(PAPER_LATEXMKRC).toContain("pdflatex -interaction=nonstopmode");
  });
});

// ── integration: project create verb ───────────────────────────────────────

import { projectCreate, projectImport } from "../src/project_verb.js";

describe("projectCreate", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "amico-project-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates a project directory with the full prescribed layout", () => {
    const projectDir = join(tmpDir, "my-test-project");
    const result = projectCreate(["My Test Project", "--path", projectDir, "--question", "Does TDD work?"]);

    expect((result.json as Record<string, unknown>).created).toBe(true);
    expect(result.code).toBe(0);

    // Verify project.toml exists and is valid
    expect(existsSync(join(projectDir, "project.toml"))).toBe(true);
    const tomlContent = readFileSync(join(projectDir, "project.toml"), "utf8");
    expect(tomlContent).toContain("My Test Project");
    expect(tomlContent).toContain("my-test-project");

    // Verify prescribed directories
    for (const dir of ["scripts", "scripts/testbed", "data/raw", "data/processed",
      "data/plots", "analysis", "paper/figures", "paper/supplementary",
      "ledger/hypotheses", "ledger/observations", "ledger/literature",
      "ledger/campaigns", "config", "skills"]) {
      expect(existsSync(join(projectDir, dir))).toBe(true);
    }

    // Verify root files
    expect(existsSync(join(projectDir, "README.md"))).toBe(true);
    expect(existsSync(join(projectDir, ".gitignore"))).toBe(true);

    // Verify paper files
    expect(existsSync(join(projectDir, "paper/outline.md"))).toBe(true);
    expect(existsSync(join(projectDir, "paper/main.tex"))).toBe(true);
    expect(existsSync(join(projectDir, "paper/references.bib"))).toBe(true);
    expect(existsSync(join(projectDir, "paper/latexmkrc"))).toBe(true);
    expect(existsSync(join(projectDir, "paper/.gitignore"))).toBe(true);

    // Verify git repository
    expect(existsSync(join(projectDir, ".git"))).toBe(true);
  });

  it("uses REVTeX template when --venue is Physical Review Letters", () => {
    const projectDir = join(tmpDir, "prl-project");
    projectCreate(["PRL Paper", "--path", projectDir, "--venue", "Physical Review Letters"]);

    const tex = readFileSync(join(projectDir, "paper/main.tex"), "utf8");
    expect(tex).toContain("revtex4-2");

    const outline = readFileSync(join(projectDir, "paper/outline.md"), "utf8");
    expect(outline).toContain("PRL/PRX compressed format");
  });

  it("is idempotent — re-running returns success without overwriting", () => {
    const projectDir = join(tmpDir, "idempotent-project");
    const first = projectCreate(["Idempotent", "--path", projectDir]);
    expect((first.json as Record<string, unknown>).created).toBe(true);

    const second = projectCreate(["Idempotent", "--path", projectDir]);
    expect(second.code).toBe(0);
    expect((second.json as Record<string, unknown>).idempotent).toBe(true);
  });

  it("returns error when no name is provided", () => {
    const result = projectCreate(["--path", join(tmpDir, "bad")]);
    expect(result.code).toBe(64);
    expect((result.json as Record<string, unknown>).error).toBeDefined();
  });
});

// ── integration: project import verb ───────────────────────────────────────

describe("projectImport", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "amico-project-import-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates project.toml and scaffolds missing dirs in an existing directory", () => {
    const existingDir = join(tmpDir, "existing-project");
    mkdirSync(join(existingDir, "scripts"), { recursive: true });
    writeFileSync(join(existingDir, "scripts/my_solve.jl"), "# existing file");

    const result = projectImport([existingDir, "--name", "Existing Project", "--question", "What?"]);

    expect((result.json as Record<string, unknown>).imported).toBe(true);
    expect(result.code).toBe(0);

    // project.toml was created
    expect(existsSync(join(existingDir, "project.toml"))).toBe(true);

    // Existing file was NOT overwritten
    expect(readFileSync(join(existingDir, "scripts/my_solve.jl"), "utf8")).toBe("# existing file");

    // Missing dirs were scaffolded
    expect(existsSync(join(existingDir, "scripts/testbed"))).toBe(true);
    expect(existsSync(join(existingDir, "data/raw"))).toBe(true);
    expect(existsSync(join(existingDir, "ledger/campaigns"))).toBe(true);
    expect(existsSync(join(existingDir, "paper/outline.md"))).toBe(true);
  });

  it("is idempotent — re-importing returns success without overwriting", () => {
    const dir = join(tmpDir, "idempotent-import");
    mkdirSync(dir, { recursive: true });

    const first = projectImport([dir, "--name", "Test"]);
    expect((first.json as Record<string, unknown>).imported).toBe(true);

    const second = projectImport([dir]);
    expect(second.code).toBe(0);
    expect((second.json as Record<string, unknown>).idempotent).toBe(true);
  });

  it("returns error for nonexistent directory", () => {
    const result = projectImport([join(tmpDir, "does-not-exist")]);
    expect(result.code).toBe(64);
  });
});
