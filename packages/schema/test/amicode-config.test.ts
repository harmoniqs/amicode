// The `amicode-config` kind (#402): the studio manifest — one file binding
// the installation. Strict shape (we own both sides); semantic checks (exactly
// one rw personal mount, drift) live in `amicode doctor`, not the validator —
// the schema checks structure, the doctor checks the world.
import { describe, it, expect } from "vitest";
import { validate, SUPPORTED_VERSIONS_BY_KIND, kindForFilename } from "../src/index.js";

const cfg = (over: Record<string, unknown> = {}) => ({
  schema_version: "1",
  studio_root: "~/armonia",
  ...over,
});
const drop = (o: Record<string, unknown>, k: string) => {
  const c = { ...o };
  delete c[k];
  return c;
};

describe("the amicode-config kind", () => {
  it("accepts a minimal manifest — studio root alone binds the installation", () => {
    expect(validate(cfg(), "amicode-config")).toMatchObject({ ok: true });
  });
  it("accepts the full shape — ordered mounts + root overrides + tenant", () => {
    expect(
      validate(
        cfg({
          tenant: "local",
          vaults: {
            mounts: [
              { name: "vault-aaron", kind: "personal", mode: "rw", path: "~/armonia/vaults/vault-aaron" },
              { name: "armonissima", kind: "team", mode: "ro", path: "~/armonia/vaults/armonissima" },
            ],
          },
          catalog: "~/armonia/catalog",
          ledger: "~/armonia/ledger",
          harness: "~/armonia/ledger/harness",
          packs_external: "~/armonia/packs",
          problems: "~/armonia/data/problems",
          runs: "~/armonia/data/runs",
          vaults_root: "~/armonia/data/vaults",
        }),
        "amicode-config",
      ),
    ).toMatchObject({ ok: true });
  });
  it("requires studio_root — the binding IS the manifest", () => {
    expect(validate(drop(cfg(), "studio_root"), "amicode-config").ok).toBe(false);
  });
  it("rejects an unrecognized schema_version", () => {
    expect(validate(cfg({ schema_version: "2" }), "amicode-config").ok).toBe(false);
  });
  it("rejects unknown top-level keys (strict: we own both sides)", () => {
    expect(validate(cfg({ secrets: {} }), "amicode-config").ok).toBe(false);
  });
  it("mount kinds and modes are enums; names/paths are non-empty strings", () => {
    const base = cfg({ vaults: { mounts: [{ name: "v", kind: "personal", mode: "rw", path: "~/v" }] } });
    expect(validate(base, "amicode-config").ok).toBe(true);
    expect(
      validate(cfg({ vaults: { mounts: [{ name: "v", kind: "diagonal", mode: "rw", path: "~/v" }] } }), "amicode-config").ok,
    ).toBe(false);
    expect(
      validate(cfg({ vaults: { mounts: [{ name: "v", kind: "personal", mode: "sometimes", path: "~/v" }] } }), "amicode-config").ok,
    ).toBe(false);
    expect(
      validate(cfg({ vaults: { mounts: [{ name: "", kind: "personal", mode: "rw", path: "~/v" }] } }), "amicode-config").ok,
    ).toBe(false);
  });
  it("mounts is an array (TOML [[vaults.mounts]] document order = precedence)", () => {
    expect(validate(cfg({ vaults: { mounts: "vault-aaron" } }), "amicode-config").ok).toBe(false);
  });
  it("carries a version, so the module does not crash at load", () => {
    expect(SUPPORTED_VERSIONS_BY_KIND["amicode-config"]).toEqual(["1"]);
  });
  it("config.toml is deliberately NOT filename-kinded — the name is too generic to claim", () => {
    expect(kindForFilename("/home/u/.amicode/config.toml")).toBeUndefined();
  });
});
