// Skill auto-loading from research project directories — #668.
// resolveProjectSkills scans workspace folders with project.toml for skills/.
// mergeSkillEntries extended with project source (highest priority).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveProjectSkills,
  mergeSkillEntries,
} from "../../src/scores/user_skill_providers";
import type { SkillIndexEntry } from "../../src/scores/package_skills";

describe("resolveProjectSkills", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "amicode-project-skills-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("discovers skills from a research project's skills/ directory", () => {
    const projectDir = join(tmpDir, "my-research");
    mkdirSync(join(projectDir, "skills", "my-analysis"), { recursive: true });
    writeFileSync(join(projectDir, "project.toml"), 'schema_version = 1\n');
    writeFileSync(join(projectDir, "skills", "my-analysis", "SKILL.md"), `---
name: my-analysis
description: Custom analysis skill for this project
agents: []
surface: public
---
# My Analysis
`);

    const skills = resolveProjectSkills([projectDir]);
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("my-analysis");
    expect(skills[0].source).toBe("project");
    expect(skills[0].description).toBe("Custom analysis skill for this project");
  });

  it("ignores directories without project.toml (dev projects)", () => {
    const devDir = join(tmpDir, "dev-repo");
    mkdirSync(join(devDir, "skills", "some-skill"), { recursive: true });
    writeFileSync(join(devDir, "skills", "some-skill", "SKILL.md"), `---
name: some-skill
description: A skill in a dev project
agents: []
---
# Some Skill
`);

    const skills = resolveProjectSkills([devDir]);
    expect(skills).toHaveLength(0);
  });

  it("returns empty for a research project with no skills/ directory", () => {
    const projectDir = join(tmpDir, "no-skills-proj");
    mkdirSync(projectDir);
    writeFileSync(join(projectDir, "project.toml"), 'schema_version = 1\n');

    const skills = resolveProjectSkills([projectDir]);
    expect(skills).toHaveLength(0);
  });

  it("scans multiple research projects from workspace folders", () => {
    const proj1 = join(tmpDir, "proj1");
    const proj2 = join(tmpDir, "proj2");
    mkdirSync(join(proj1, "skills", "skill-a"), { recursive: true });
    mkdirSync(join(proj2, "skills", "skill-b"), { recursive: true });
    writeFileSync(join(proj1, "project.toml"), 'schema_version = 1\n');
    writeFileSync(join(proj2, "project.toml"), 'schema_version = 1\n');
    writeFileSync(join(proj1, "skills", "skill-a", "SKILL.md"), `---
name: skill-a
description: Skill A
---
`);
    writeFileSync(join(proj2, "skills", "skill-b", "SKILL.md"), `---
name: skill-b
description: Skill B
---
`);

    const skills = resolveProjectSkills([proj1, proj2]);
    expect(skills).toHaveLength(2);
    expect(skills.map((s) => s.name).sort()).toEqual(["skill-a", "skill-b"]);
  });
});

describe("mergeSkillEntries with project source", () => {
  const shipped: SkillIndexEntry[] = [
    { source: "library", name: "debugging", description: "shipped debugging", path: "/lib/debugging/SKILL.md" },
    { source: "library", name: "tdd", description: "shipped tdd", path: "/lib/tdd/SKILL.md" },
  ];

  it("project skills have highest priority (shadow custom, workspace, shipped)", () => {
    const project: SkillIndexEntry[] = [
      { source: "project" as SkillIndexEntry["source"], name: "debugging", description: "project debugging", path: "/proj/skills/debugging/SKILL.md" },
    ];
    const merged = mergeSkillEntries(project, [], [], shipped);
    const debug = merged.find((e) => e.name === "debugging");
    expect(debug).toBeDefined();
    expect(debug!.source).toBe("project");
    expect(debug!.description).toBe("project debugging");
    expect(debug!.overridesShipped).toBe(true);
  });

  it("falls back to existing priority when no project skills: custom > workspace > shipped", () => {
    const custom: SkillIndexEntry[] = [
      { source: "custom", name: "debugging", description: "custom debugging", path: "/custom/debugging/SKILL.md" },
    ];
    const merged = mergeSkillEntries([], custom, [], shipped);
    const debug = merged.find((e) => e.name === "debugging");
    expect(debug!.source).toBe("custom");
    expect(debug!.overridesShipped).toBe(true);
  });

  it("multi-project collision: first project in folder order wins", () => {
    const project: SkillIndexEntry[] = [
      { source: "project" as SkillIndexEntry["source"], name: "analyze", description: "first", path: "/proj1/skills/analyze/SKILL.md" },
      { source: "project" as SkillIndexEntry["source"], name: "analyze", description: "second", path: "/proj2/skills/analyze/SKILL.md" },
    ];
    const merged = mergeSkillEntries(project, [], [], shipped);
    const analyze = merged.find((e) => e.name === "analyze");
    expect(analyze!.description).toBe("first");
  });
});
