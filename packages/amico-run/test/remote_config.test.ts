// packages/amico-run/test/remote_config.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloudConfigFile, readRemoteConfig } from "../src/remote_config.js";
import { ConfigError } from "../src/types.js";

// Hermetic env: never let the runner's real AMICO_CLOUD_* leak in.
const noEnv = {} as NodeJS.ProcessEnv;

describe("remote_config — endpoint + credential resolution (authoring.ts idiom)", () => {
  it("env pair wins over any file; trailing slash trimmed", () => {
    const c = readRemoteConfig({
      AMICO_CLOUD_URL: "https://x.example/",
      AMICO_CLOUD_TOKEN: "t1",
      AMICO_CLOUD_FILE: "/no/such/file.json",
    } as NodeJS.ProcessEnv);
    expect(c).toEqual({ baseUrl: "https://x.example", token: "t1" });
  });
  it("partial env pair → ConfigError naming both vars", () => {
    expect(() => readRemoteConfig({ AMICO_CLOUD_URL: "https://x" } as NodeJS.ProcessEnv)).toThrow(ConfigError);
    expect(() => readRemoteConfig({ AMICO_CLOUD_TOKEN: "t" } as NodeJS.ProcessEnv)).toThrow(/BOTH/);
  });
  it("falls back to $AMICO_CLOUD_FILE json", () => {
    const f = join(mkdtempSync(join(tmpdir(), "cloud-")), "cloud.json");
    writeFileSync(f, JSON.stringify({ base_url: "https://api.example/", token: "sekret" }));
    expect(readRemoteConfig({ ...noEnv, AMICO_CLOUD_FILE: f })).toEqual({
      baseUrl: "https://api.example",
      token: "sekret",
    });
  });
  it("missing file → ConfigError naming the path (exit-64 class: nothing ran)", () => {
    const f = join(mkdtempSync(join(tmpdir(), "cloud-")), "absent.json");
    expect(() => readRemoteConfig({ ...noEnv, AMICO_CLOUD_FILE: f })).toThrow(ConfigError);
    expect(() => readRemoteConfig({ ...noEnv, AMICO_CLOUD_FILE: f })).toThrow(f);
  });
  it("wrong-shape file → ConfigError; the token value NEVER appears in the message", () => {
    const f = join(mkdtempSync(join(tmpdir(), "cloud-")), "cloud.json");
    writeFileSync(f, JSON.stringify({ base_url: 42, token: "sekret-token-value" }));
    let msg = "";
    try {
      readRemoteConfig({ ...noEnv, AMICO_CLOUD_FILE: f });
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/base_url/);
    expect(msg).not.toContain("sekret-token-value"); // llm_creds.mjs security stance
  });
  it("malformed JSON → ConfigError (never a JSON.parse throw)", () => {
    const f = join(mkdtempSync(join(tmpdir(), "cloud-")), "cloud.json");
    writeFileSync(f, "{nope");
    expect(() => readRemoteConfig({ ...noEnv, AMICO_CLOUD_FILE: f })).toThrow(ConfigError);
  });
  it("default path is ~/.amico/cloud.json", () => {
    expect(cloudConfigFile(noEnv)).toMatch(/\.amico\/cloud\.json$/);
  });
});
