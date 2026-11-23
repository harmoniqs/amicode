// amicode#2096 (ADR 0001): ~/.amico/cloud.json holds the Company Compute key
// and MUST land 0600 — including when a pre-existing file is 0644 (a
// writeFileSync `mode` only applies on create, so a naive in-place write would
// leave the old world-readable mode). Exercised through BOTH writers of the
// file in the extension-hosted amicode service: the CredentialStore seam and
// the POST /amicode/connections/credential route that calls it. HOME is a
// temp dir so the default ~/.amico/cloud.json path is real but sandboxed.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { cloudFile, readCredential, writeCredential } from "../src/amicode_service/credentials";
import { submitCredentialResponse } from "../src/amicode_service/connections";

const mode = (file: string) => statSync(file).mode & 0o777;
const ENV_KEYS = ["HOME", "AMICO_CLOUD_FILE", "AMICODE_OPS_DIR"] as const;
let saved: Record<string, string | undefined>;
let home: string;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  home = mkdtempSync(path.join(tmpdir(), "amicode-2096-"));
  process.env.HOME = home;
  delete process.env.AMICO_CLOUD_FILE;
  delete process.env.AMICODE_OPS_DIR;
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(home, { recursive: true, force: true });
});

function preExisting0644(): string {
  const file = path.join(home, ".amico", "cloud.json");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, '{"base_url":"https://old.example","token":"old-tok"}\n');
  chmodSync(file, 0o644);
  expect(mode(file)).toBe(0o644);
  return file;
}

describe("cloud.json is 0600 (amicode#2096)", () => {
  it("default path resolves under the temp HOME", () => {
    expect(cloudFile()).toBe(path.join(home, ".amico", "cloud.json"));
  });

  it("writeCredential creates cloud.json at 0600", () => {
    writeCredential("company-compute", { base_url: "https://x.example", token: "tok" });
    expect(mode(cloudFile())).toBe(0o600);
  });

  it("writeCredential re-modes a pre-existing 0644 cloud.json to 0600", () => {
    const file = preExisting0644();
    writeCredential("company-compute", { base_url: "https://new.example", token: "new-tok" });
    expect(mode(file)).toBe(0o600);
    expect(readCredential("company-compute")).toEqual({ base_url: "https://new.example", token: "new-tok" });
  });

  it("the connections credential route re-modes a pre-existing 0644 cloud.json to 0600", async () => {
    const file = preExisting0644();
    const out = JSON.parse(
      await submitCredentialResponse(
        JSON.stringify({ id: "company-compute", base_url: "https://route.example", token: "route-tok" }),
        { bindHostname: "127.0.0.1", fetchImpl: async () => ({ status: 200, json: async () => ({}) }) },
      ),
    );
    expect(out.ok).toBe(true);
    expect(mode(file)).toBe(0o600);
    expect(readCredential("company-compute")).toEqual({ base_url: "https://route.example", token: "route-tok" });
  });
});
