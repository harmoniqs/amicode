// `amico env` — research environment entity: schema validation, scaffold data,
// TOML rendering, and registry parsing. Pure logic in environment.ts.
// Part of #881 (sub-issue of #880 Research Environments).
import { describe, it, expect } from "vitest";

import {
  CURRENT_ENV_SCHEMA_VERSION,
  validateEnvironmentToml,
  renderEnvironmentToml,
  parseEnvironmentRegistry,
  renderEnvironmentRegistry,
  ENV_SCAFFOLD_DIRS,
  type EnvironmentToml,
  type EnvironmentRegistryEntry,
} from "../src/environment.js";
import { parse as parseToml } from "smol-toml";

// ── pure logic: schema validation ──────────────────────────────────────────

describe("validateEnvironmentToml", () => {
  const valid: EnvironmentToml = {
    schema_version: 1,
    name: "Transmon Optimal Control",
    slug: "transmon-optimal-control",
    created: "2026-09-07",
  };

  it("accepts a valid manifest with all required fields", () => {
    const result = validateEnvironmentToml(valid);
    expect(result.ok).toBe(true);
  });

  it("accepts a manifest with all optional fields", () => {
    const full: EnvironmentToml = {
      ...valid,
      description: "Shared knowledge for transmon gate synthesis",
      tags: ["transmon", "optimal-control"],
      domain: { platform: "transmon", field: "quantum-control" },
      authors: { lead: "JJ Lee", collaborators: ["Alice", "Bob"] },
      repo: { remote: "git@github.com:harmoniqs/transmon-oc.git" },
      paths: { lib: "julia_lib", results: "data/results" },
    };
    const result = validateEnvironmentToml(full);
    expect(result.ok).toBe(true);
  });

  it("rejects non-object input", () => {
    const result = validateEnvironmentToml("not an object");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toContain("object");
  });

  it("rejects null input", () => {
    const result = validateEnvironmentToml(null);
    expect(result.ok).toBe(false);
  });

  it("rejects missing required field: schema_version", () => {
    const { schema_version: _, ...bad } = valid;
    const result = validateEnvironmentToml(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e: string) => e.includes("schema_version"))).toBe(true);
  });

  it("rejects missing required field: name", () => {
    const { name: _, ...bad } = valid;
    const result = validateEnvironmentToml(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e: string) => e.includes("name"))).toBe(true);
  });

  it("rejects missing required field: slug", () => {
    const { slug: _, ...bad } = valid;
    const result = validateEnvironmentToml(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e: string) => e.includes("slug"))).toBe(true);
  });

  it("rejects missing required field: created", () => {
    const { created: _, ...bad } = valid;
    const result = validateEnvironmentToml(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e: string) => e.includes("created"))).toBe(true);
  });

  it("rejects non-numeric schema_version", () => {
    const bad = { ...valid, schema_version: "one" };
    const result = validateEnvironmentToml(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e: string) => e.includes("schema_version"))).toBe(true);
  });

  it("rejects schema_version exceeding CURRENT_ENV_SCHEMA_VERSION (AC-54)", () => {
    const bad = { ...valid, schema_version: CURRENT_ENV_SCHEMA_VERSION + 1 };
    const result = validateEnvironmentToml(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e: string) => e.includes("unreadable"))).toBe(true);
  });

  it("tolerates unknown extra fields (forward-compatible)", () => {
    const extended = { ...valid, future_field: "surprise" } as unknown as EnvironmentToml;
    const result = validateEnvironmentToml(extended);
    expect(result.ok).toBe(true);
  });

  it("collects multiple errors", () => {
    const result = validateEnvironmentToml({});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.length).toBeGreaterThanOrEqual(4);
  });
});

// ── pure logic: TOML rendering round-trip ──────────────────────────────────

describe("renderEnvironmentToml", () => {
  const env: EnvironmentToml = {
    schema_version: 1,
    name: "Transmon Optimal Control",
    slug: "transmon-optimal-control",
    created: "2026-09-07",
  };

  it("produces parseable TOML with all required fields", () => {
    const toml = renderEnvironmentToml(env);
    expect(toml).toContain("schema_version = 1");
    expect(toml).toContain('name = "Transmon Optimal Control"');
    expect(toml).toContain('slug = "transmon-optimal-control"');
    expect(toml).toContain('created = "2026-09-07"');
    // Must be parseable by smol-toml
    const parsed = parseToml(toml);
    expect(parsed.schema_version).toBe(1);
    expect(parsed.name).toBe("Transmon Optimal Control");
  });

  it("includes optional sections when present", () => {
    const full: EnvironmentToml = {
      ...env,
      description: "Shared knowledge base",
      tags: ["transmon", "gates"],
      domain: { platform: "transmon", field: "quantum-control" },
      authors: { lead: "JJ Lee", collaborators: ["Alice"] },
      repo: { remote: "git@github.com:org/repo.git" },
      paths: { lib: "julia_lib" },
    };
    const toml = renderEnvironmentToml(full);
    expect(toml).toContain('[domain]');
    expect(toml).toContain('platform = "transmon"');
    expect(toml).toContain('[authors]');
    expect(toml).toContain('lead = "JJ Lee"');
    expect(toml).toContain('[repo]');
    expect(toml).toContain('[paths]');
    expect(toml).toContain('lib = "julia_lib"');
  });

  it("round-trips through parse", () => {
    const full: EnvironmentToml = {
      ...env,
      description: "Round trip test",
      tags: ["a", "b"],
      domain: { platform: "transmon" },
      authors: { lead: "Test" },
    };
    const toml = renderEnvironmentToml(full);
    const parsed = parseToml(toml) as unknown as EnvironmentToml;
    expect(parsed.schema_version).toBe(full.schema_version);
    expect(parsed.name).toBe(full.name);
    expect(parsed.slug).toBe(full.slug);
    expect(parsed.created).toBe(full.created);
    expect(parsed.description).toBe(full.description);
    expect(parsed.tags).toEqual(full.tags);
  });

  it("omits optional sections when not present", () => {
    const toml = renderEnvironmentToml(env);
    expect(toml).not.toContain("[domain]");
    expect(toml).not.toContain("[authors]");
    expect(toml).not.toContain("[repo]");
    expect(toml).not.toContain("[paths]");
  });
});

// ── pure logic: registry parsing ───────────────────────────────────────────

describe("parseEnvironmentRegistry", () => {
  it("parses a valid registry with one entry", () => {
    const toml = `[[environments]]\nslug = "my-env"\npath = "/tmp/my-env"\n`;
    const entries = parseEnvironmentRegistry(toml);
    expect(entries).toHaveLength(1);
    expect(entries[0].slug).toBe("my-env");
    expect(entries[0].path).toBe("/tmp/my-env");
  });

  it("parses a valid registry with multiple entries", () => {
    const toml = `[[environments]]\nslug = "env-a"\npath = "/a"\n\n[[environments]]\nslug = "env-b"\npath = "/b"\n`;
    const entries = parseEnvironmentRegistry(toml);
    expect(entries).toHaveLength(2);
    expect(entries[0].slug).toBe("env-a");
    expect(entries[1].slug).toBe("env-b");
  });

  it("returns empty array for empty string", () => {
    expect(parseEnvironmentRegistry("")).toEqual([]);
  });

  it("returns empty array when no environments key", () => {
    expect(parseEnvironmentRegistry("# empty file\n")).toEqual([]);
  });

  it("skips entries missing slug or path", () => {
    const toml = `[[environments]]\nslug = "good"\npath = "/good"\n\n[[environments]]\nslug = "bad"\n`;
    const entries = parseEnvironmentRegistry(toml);
    expect(entries).toHaveLength(1);
    expect(entries[0].slug).toBe("good");
  });
});

describe("renderEnvironmentRegistry", () => {
  it("renders entries as [[environments]] array", () => {
    const entries: EnvironmentRegistryEntry[] = [
      { slug: "env-a", path: "/tmp/env-a" },
      { slug: "env-b", path: "/tmp/env-b" },
    ];
    const toml = renderEnvironmentRegistry(entries);
    expect(toml).toContain("[[environments]]");
    expect(toml).toContain('slug = "env-a"');
    expect(toml).toContain('path = "/tmp/env-a"');
  });

  it("round-trips through parse", () => {
    const entries: EnvironmentRegistryEntry[] = [
      { slug: "round-trip", path: "/home/user/round-trip" },
    ];
    const toml = renderEnvironmentRegistry(entries);
    const parsed = parseEnvironmentRegistry(toml);
    expect(parsed).toEqual(entries);
  });

  it("renders empty string for empty array", () => {
    const toml = renderEnvironmentRegistry([]);
    expect(toml.trim()).toBe("");
  });
});

// ── pure logic: scaffold dirs ──────────────────────────────────────────────

describe("ENV_SCAFFOLD_DIRS", () => {
  it("contains all 9 prescribed directories", () => {
    expect(ENV_SCAFFOLD_DIRS).toHaveLength(9);
    expect(ENV_SCAFFOLD_DIRS).toContain("insights");
    expect(ENV_SCAFFOLD_DIRS).toContain("methods");
    expect(ENV_SCAFFOLD_DIRS).toContain("context");
    expect(ENV_SCAFFOLD_DIRS).toContain("literature");
    expect(ENV_SCAFFOLD_DIRS).toContain("experiments");
    expect(ENV_SCAFFOLD_DIRS).toContain("lib");
    expect(ENV_SCAFFOLD_DIRS).toContain("templates");
    expect(ENV_SCAFFOLD_DIRS).toContain("config");
    expect(ENV_SCAFFOLD_DIRS).toContain("results");
  });
});

// ── ProjectToml environment field ──────────────────────────────────────────

import { renderProjectToml, type ProjectToml } from "../src/project.js";

describe("renderProjectToml [environment]", () => {
  const base: ProjectToml = {
    schema_version: 1,
    name: "Test",
    slug: "test",
    question: "Does it work?",
    status: "proposing",
    created: "2026-09-07",
  };

  it("omits [environment] section when not present", () => {
    const toml = renderProjectToml(base);
    expect(toml).not.toContain("[environment]");
  });

  it("includes [environment] section when present", () => {
    const p: ProjectToml = {
      ...base,
      environment: { slug: "transmon-oc" },
    };
    const toml = renderProjectToml(p);
    expect(toml).toContain("[environment]");
    expect(toml).toContain('slug = "transmon-oc"');
  });

  it("includes environment path when provided", () => {
    const p: ProjectToml = {
      ...base,
      environment: { slug: "transmon-oc", path: "/home/user/transmon-oc" },
    };
    const toml = renderProjectToml(p);
    expect(toml).toContain("[environment]");
    expect(toml).toContain('slug = "transmon-oc"');
    expect(toml).toContain('path = "/home/user/transmon-oc"');
  });
});
