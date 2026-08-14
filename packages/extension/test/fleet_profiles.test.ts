import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  slugify,
  parseProfile,
  serializeProfile,
  writeProfile,
  readProfile,
  listProfiles,
  slugExists,
  deleteProfile,
  duplicateProfile,
  validateProfile,
  type FleetProfile,
} from "../src/fleet_profiles";

const SAMPLE_PROFILE: FleetProfile = {
  schema: 1,
  name: "researcher-opus",
  base: "pulse-designer",
  model: "anthropic.claude-opus-4-6-v1",
  variant: "",
  task_type: "interactive",
  skills: ["transmon", "atoms", "bosonic"],
  gates: [],
  permissions: { bash: "allow", file_write: "allow" },
};

describe("slugify", () => {
  it("converts name to kebab-case", () => {
    expect(slugify("Researcher Opus")).toBe("researcher-opus");
  });

  it("strips special characters", () => {
    expect(slugify("My Profile! (v2)")).toBe("my-profile-v2");
  });

  it("handles leading/trailing hyphens", () => {
    expect(slugify("--test--")).toBe("test");
  });

  it("returns empty for non-alphanumeric", () => {
    expect(slugify("!!!")).toBe("");
  });
});

describe("parseProfile / serializeProfile round-trip", () => {
  it("round-trips without data loss", () => {
    const toml = serializeProfile(SAMPLE_PROFILE);
    const parsed = parseProfile(toml);
    expect(parsed).not.toBeNull();
    expect(parsed!.name).toBe(SAMPLE_PROFILE.name);
    expect(parsed!.model).toBe(SAMPLE_PROFILE.model);
    expect(parsed!.skills).toEqual(SAMPLE_PROFILE.skills);
    expect(parsed!.permissions).toEqual(SAMPLE_PROFILE.permissions);
    expect(parsed!.schema).toBe(1);
  });

  it("handles empty arrays", () => {
    const p = { ...SAMPLE_PROFILE, skills: [], gates: [] };
    const toml = serializeProfile(p);
    const parsed = parseProfile(toml);
    expect(parsed!.skills).toEqual([]);
    expect(parsed!.gates).toEqual([]);
  });

  it("returns null for invalid TOML", () => {
    expect(parseProfile("not valid toml [[[")).toBeNull();
  });
});

describe("file operations", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-profiles-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("writeProfile + readProfile round-trips", () => {
    writeProfile(SAMPLE_PROFILE, "researcher-opus", tmp);
    const read = readProfile(path.join(tmp, "researcher-opus.toml"));
    expect(read).not.toBeNull();
    expect(read!.name).toBe("researcher-opus");
    expect(read!.model).toBe("anthropic.claude-opus-4-6-v1");
  });

  it("writeProfile creates directory if absent", () => {
    const nested = path.join(tmp, "sub", "dir");
    writeProfile(SAMPLE_PROFILE, "test", nested);
    expect(fs.existsSync(path.join(nested, "test.toml"))).toBe(true);
  });

  it("listProfiles returns all profiles", () => {
    writeProfile(SAMPLE_PROFILE, "one", tmp);
    writeProfile({ ...SAMPLE_PROFILE, name: "two" }, "two", tmp);
    const list = listProfiles(tmp);
    expect(list).toHaveLength(2);
    expect(list.map((p) => p.slug).sort()).toEqual(["one", "two"]);
  });

  it("listProfiles returns empty for missing directory", () => {
    expect(listProfiles("/nonexistent/path")).toEqual([]);
  });

  it("slugExists checks file existence", () => {
    writeProfile(SAMPLE_PROFILE, "existing", tmp);
    expect(slugExists("existing", tmp)).toBe(true);
    expect(slugExists("nonexistent", tmp)).toBe(false);
  });

  it("deleteProfile removes the file", () => {
    writeProfile(SAMPLE_PROFILE, "todelete", tmp);
    expect(deleteProfile("todelete", tmp)).toBe(true);
    expect(slugExists("todelete", tmp)).toBe(false);
  });

  it("deleteProfile returns false for missing file", () => {
    expect(deleteProfile("ghost", tmp)).toBe(false);
  });

  it("duplicateProfile creates a copy with -copy suffix", () => {
    writeProfile(SAMPLE_PROFILE, "original", tmp);
    const newSlug = duplicateProfile("original", tmp);
    expect(newSlug).toBe("original-copy");
    const copy = readProfile(path.join(tmp, "original-copy.toml"));
    expect(copy).not.toBeNull();
    expect(copy!.name).toBe("researcher-opus (copy)");
    expect(copy!.model).toBe(SAMPLE_PROFILE.model);
  });

  it("duplicateProfile increments suffix on conflict", () => {
    writeProfile(SAMPLE_PROFILE, "base", tmp);
    writeProfile(SAMPLE_PROFILE, "base-copy", tmp);
    const newSlug = duplicateProfile("base", tmp);
    expect(newSlug).toBe("base-copy-2");
  });

  it("duplicateProfile returns null for missing source", () => {
    expect(duplicateProfile("nonexistent", tmp)).toBeNull();
  });
});

describe("validateProfile", () => {
  it("passes for a valid profile", () => {
    expect(validateProfile(SAMPLE_PROFILE)).toEqual([]);
  });

  it("fails for missing name", () => {
    const errors = validateProfile({ ...SAMPLE_PROFILE, name: "" });
    expect(errors).toContain("Name is required");
  });

  it("fails for missing model", () => {
    const errors = validateProfile({ ...SAMPLE_PROFILE, model: "" });
    expect(errors).toContain("Model is required");
  });

  it("fails for name that produces empty slug", () => {
    const errors = validateProfile({ ...SAMPLE_PROFILE, name: "!!!" });
    expect(errors).toContain("Name must produce a valid slug (at least one alphanumeric character)");
  });
});
