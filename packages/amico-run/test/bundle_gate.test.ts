// bundle_gate.test.ts — the #643 bundle-build gate (scripts/assert_built_bundles.mjs).
//
// The deployed verb-router bundle went 46 days stale because nothing gated the
// build: the dists are gitignored artifacts, and a broken entry or unresolvable
// import only failed on whichever machine last tried to build. The gate asserts,
// against the package's DECLARED bin map (the single source of truth — the same
// map the extension staging and assert_packaged_cli.mjs re-read):
//   (a) every declared bundle exists in dist/ and is non-empty (absence or a
//       half-built set reds);
//   (b) the built verb router still ANSWERS — `amico --help` exits 0 with the
//       usage surface (a bundle that builds-but-dies reds; vitest transpiles,
//       so the unit suite never executes the shipped artifact — this gate does).
// The mutation direction is proven with fabricated dist dirs: a missing bundle
// and a dead router both red the gate.
import { describe, test, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { declaredDistBundles, runBundleGate } from "../scripts/assert_built_bundles.mjs";

const ROOT = join(__dirname, "..");

// the suite's build convention (amico.test.ts et al.): build the real bundles
// before probing them — the esbuild config is atomic + idempotent by design.
beforeAll(() => {
  execFileSync("node", [join(ROOT, "esbuild.config.mjs")], { cwd: ROOT });
});

describe("bundle-build gate (#643)", () => {
  test("the real build satisfies the gate: every declared bundle present, verb-router smoke answers", async () => {
    const { ok, results } = await runBundleGate({ pkgDir: ROOT });
    expect(ok).toBe(true);
    expect(results.filter((r) => !r.ok)).toEqual([]); // no failing rows — detail says why if not

    // fail-closed coverage: every DECLARED bin (bin map + shadowBins) is gated
    const bins = declaredDistBundles(ROOT).map((b) => b.name).sort();
    expect(bins).toContain("amico"); // the verb router is the incident's subject
    const gated = new Set(results.map((r) => r.bin));
    for (const b of bins) expect(gated.has(b)).toBe(true);
  });
});

// ── fabricated dist dirs: the mutation direction ─────────────────────────────

/** A fabricated package dir whose dist/ the gate runs against: a package.json
 * carrying the REAL bin map (the gate's input contract) + `files` mapping a
 * dist basename to its bytes. */
function fabricatedPkg(files: Record<string, string>): string {
  const pkg = mkdtempSync(join(tmpdir(), "amico-bundle-gate-"));
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({
      name: "@amicode/amico-run-fixture",
      bin: {
        "amico-run": "./launcher/amico-run",
        amico: "./launcher/amico",
        "amico-pasqal": "./launcher/amico-pasqal",
        "amico-git-credential": "./launcher/amico-git-credential",
      },
      amicode: { shadowBins: { gh: "./launcher/gh" } },
    }),
  );
  mkdirSync(join(pkg, "dist"), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(pkg, "dist", name), body);
  }
  return pkg;
}

const ALL_BUNDLES = ["amico-run.js", "amico.js", "amico-pasqal.js", "amico-git-credential.js", "gh.js"];
/** A router stub that answers --help like the real one (exit 0, usage text). */
const LIVE_ROUTER = 'console.log("usage:\\n  amico run <script.jl> [--spec <s.json>]");\n';

describe("bundle-build gate — fabricated dists (the red direction)", () => {
  test("a missing declared bundle reds the gate, naming the bundle", async () => {
    const files: Record<string, string> = {};
    for (const b of ALL_BUNDLES) files[b] = b === "amico.js" ? LIVE_ROUTER : "export {};\n";
    delete files["amico-pasqal.js"]; // one declared bundle absent
    const { ok, results } = await runBundleGate({ pkgDir: fabricatedPkg(files) });
    expect(ok).toBe(false);
    const row = results.find((r) => r.bin === "amico-pasqal" && /built/.test(r.check));
    expect(row?.ok).toBe(false);
    expect(row?.detail).toMatch(/amico-pasqal\.js/);
  });

  test("a router that no longer answers reds the gate (builds-but-dies)", async () => {
    const files: Record<string, string> = {};
    for (const b of ALL_BUNDLES) files[b] = b === "amico.js" ? "process.exit(3);\n" : "export {};\n";
    const { ok, results } = await runBundleGate({ pkgDir: fabricatedPkg(files) });
    expect(ok).toBe(false);
    const row = results.find((r) => r.bin === "amico" && /smoke/.test(r.check));
    expect(row?.ok).toBe(false);
  });
});
