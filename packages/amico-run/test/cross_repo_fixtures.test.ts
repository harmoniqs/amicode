// packages/amico-run/test/cross_repo_fixtures.test.ts — the amicode half of the
// cross-repo golden-fixture handshake (issue #168 AC4, corpus minted by #162).
//
// PROVENANCE: test/fixtures/credentials/{cloud.json,pasqal.json} are vendored
// BYTE-FOR-BYTE from the opencode fork's canonical corpus at
//   packages/opencode/test/server/fixtures/credentials/cloud.json
//   packages/opencode/test/server/fixtures/credentials/pasqal.json
// (source of record; do not hand-edit the vendored copies). Both sides pin the
// same bytes: if either repo drifts — key order, whitespace, the 2-space-JSON +
// trailing-newline at-rest serialization, or any value — THIS test fails before
// the panels can disagree about what a credential file looks like.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readRemoteConfig } from "../src/remote_config.js";
import { readPasqalCredentials } from "../src/pasqal_launch.js";

const FIXTURES = join(__dirname, "fixtures", "credentials");

// The canonical at-rest bytes (2-space JSON + trailing newline), spelled out so a
// drifted vendored copy AND a drifted serializer both fail loudly.
const CLOUD_BYTES = `{
  "base_url": "https://solves.staging.harmoniqs.co",
  "token": "tok-fixture-company-compute"
}
`;
const PASQAL_BYTES = `{
  "project_id": "proj-fixture-pasqal",
  "token": "tok-fixture-pasqal",
  "expires_at": "2026-08-01T00:00:00Z"
}
`;

describe("cross-repo golden fixtures (AC4) — the #162 corpus, parsed by the REAL readers", () => {
  it("cloud.json: vendored bytes are exactly the canonical serialization", () => {
    expect(readFileSync(join(FIXTURES, "cloud.json"), "utf8")).toBe(CLOUD_BYTES);
  });

  it("cloud.json: the real readRemoteConfig (via AMICO_CLOUD_FILE) parses it to the expected {baseUrl, token}", () => {
    const c = readRemoteConfig({ AMICO_CLOUD_FILE: join(FIXTURES, "cloud.json") } as NodeJS.ProcessEnv);
    expect(c).toEqual({
      baseUrl: "https://solves.staging.harmoniqs.co",
      token: "tok-fixture-company-compute",
    });
  });

  it("pasqal.json: vendored bytes are exactly the canonical serialization", () => {
    expect(readFileSync(join(FIXTURES, "pasqal.json"), "utf8")).toBe(PASQAL_BYTES);
  });

  it("pasqal.json: the real readPasqalCredentials (via AMICO_PASQAL_FILE) parses it — expiry deliberately NOT checked here (parse-level, time-independent)", () => {
    const c = readPasqalCredentials({ AMICO_PASQAL_FILE: join(FIXTURES, "pasqal.json") } as NodeJS.ProcessEnv);
    expect(c).toEqual({
      projectId: "proj-fixture-pasqal",
      token: "tok-fixture-pasqal",
      expiresAt: "2026-08-01T00:00:00Z",
    });
  });
});
