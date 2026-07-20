// The #161 behavioral packaging gate: the STAGED CLI (packages/extension/bin,
// or the bin dir extracted from a built .vsix) must accept the remote executor.
//
// Why behavioral: the CLI bundles are gitignored build artifacts rebuilt at
// package time — nothing pins their content, and a stale local bundle has
// shipped silently before (the last vsix release predated the remote-executor
// merge). So the gate asserts BEHAVIOR, hermetically (no cloud, no network,
// scratch $HOME), on failure MODE rather than success:
//
//   per DECLARED bin of the CLI package (packages/amico-run package.json `bin`):
//     1. the staged launcher exists and is executable      (absence reds)
//     2. its dist bundle exists                            (half-staged reds)
//     3. a remote-executor invocation does NOT die with the
//        unknown-executor rejection — the stale-bundle signature. The probe
//        passes a nonexistent script, so a FRESH bundle fails config-class
//        ("script not found", exit 64) while a STALE one prints
//        "unknown --executor remote". Exit 0 under a scratch $HOME is
//        impossible for a real bundle and also reds (a probe that proves
//        nothing must not pass).
//     4. the usage text lists `remote`
//
// Fail-closed: a bin declared in the map with no probe defined here reds the
// gate — adding a bin without deciding its behavioral contract is itself the
// regression this gate exists to catch. (test/cli_gate.test.ts pins both
// directions with stub bins.)
//
// Usage:  node scripts/assert_packaged_cli.mjs [--bin-dir <dir>] [--bin-map <package.json>]
//   --bin-dir  staged bin root (default: packages/extension/bin — run the
//              builds first; point it at <unzipped-vsix>/extension/bin to gate
//              a packaged artifact)
//   --bin-map  the CLI package.json carrying the `bin` map
//              (default: packages/amico-run/package.json)
import { execFile } from "node:child_process";
import { accessSync, constants as fsConstants, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_BIN_DIR = join(PKG_ROOT, "bin");
const DEFAULT_BIN_MAP = join(PKG_ROOT, "..", "amico-run", "package.json");

/** The stale-bundle signature (launch.ts's rejection line). Matched against
 *  stderr — anything ELSE (config-class "script not found", "cloud config not
 *  found", …) is an acceptable hermetic failure mode. */
const UNKNOWN_EXECUTOR = /unknown --executor/;

/** Declared bins from the CLI package's `bin` map → staged file layout.
 *  Staging convention (extension esbuild.config.mjs): bin key K ships as
 *  bin/launcher/<basename> + bin/dist/<basename>.js. */
export function declaredBins(binMapPath = DEFAULT_BIN_MAP) {
  const pkg = JSON.parse(readFileSync(binMapPath, "utf8"));
  const bin = pkg.bin;
  if (!bin || typeof bin !== "object" || Object.keys(bin).length === 0)
    throw new Error(`${binMapPath}: no \`bin\` map — nothing to gate is a failure, not a pass`);
  return Object.entries(bin).map(([name, launcherPath]) => {
    const base = basename(String(launcherPath));
    return { name, launcher: join("launcher", base), dist: join("dist", `${base}.js`) };
  });
}

/** Per-bin behavioral probes. Each entry: a list of { check, args(missingScript),
 *  expect(result) → detail|null } evaluated against the staged launcher.
 *  `remoteRejection` is the shared lane-3 assertion. */
function remoteRejection({ code, stderr }) {
  if (UNKNOWN_EXECUTOR.test(stderr))
    return `stale bundle: rejected the remote executor — ${stderr.trim().split("\n")[0]}`;
  if (code === 0)
    return "exit 0 under a scratch HOME with a nonexistent script — the hermetic probe cannot succeed; this bundle is not the real CLI";
  return null; // failed for some OTHER reason (config-class) — remote executor accepted
}

export const PROBES = {
  "amico-run": [
    {
      check: "accepts remote executor",
      args: (missing) => [missing, "--executor", "remote"],
      expect: remoteRejection,
    },
    {
      check: "usage lists remote",
      args: () => ["--help"],
      expect: ({ code, stdout }) =>
        code === 0 && /--executor\s+local\|remote/.test(stdout)
          ? null
          : `--help does not list the remote executor (exit ${code})`,
    },
  ],
  // The verb router delegates `amico run` verbatim to the same launch path —
  // probed through the verb so the ROUTER's own staging is what's gated.
  amico: [
    {
      check: "accepts remote executor",
      args: (missing) => ["run", missing, "--executor", "remote"],
      expect: remoteRejection,
    },
    {
      check: "usage lists remote",
      args: () => ["run", "--help"],
      expect: ({ code, stdout }) =>
        code === 0 && /--executor\s+local\|remote/.test(stdout)
          ? null
          : `run --help does not list the remote executor (exit ${code})`,
    },
  ],
  // amico-pasqal has NO executor surface by design (#168: the launcher takes no
  // flags, so no secret can ride argv). Its staleness signal is presence — the
  // bin postdates the remote-executor merge, so a stale staging simply lacks it
  // (lane 1 reds) — plus the help contract below proving the bundle answers.
  "amico-pasqal": [
    {
      check: "help contract answers",
      args: () => ["--help"],
      expect: ({ code, stdout }) =>
        code === 0 && /amico-pasqal <connector-script\.py>/.test(stdout)
          ? null
          : `--help is not the amico-pasqal launcher usage (exit ${code})`,
    },
  ],
};

function execCapture(file, args, env) {
  return new Promise((resolveP) => {
    execFile(file, args, { env, timeout: 30_000, encoding: "utf8" }, (err, stdout, stderr) => {
      // err.code is the exit code for non-zero exits; spawn faults carry errno strings.
      const code = err ? (typeof err.code === "number" ? err.code : -1) : 0;
      resolveP({ code, stdout: stdout ?? "", stderr: stderr ?? "", spawnError: err && typeof err.code !== "number" ? String(err.code ?? err.message) : undefined });
    });
  });
}

/** Run every check for every declared bin. Returns { ok, results } where each
 *  result is { bin, check, ok, detail }. Never throws on a failing bin — the
 *  caller gets the full picture. */
export async function runGate({ binDir = DEFAULT_BIN_DIR, binMapPath = DEFAULT_BIN_MAP } = {}) {
  const results = [];
  const push = (bin, check, detail) => results.push({ bin, check, ok: detail === null, detail: detail ?? "ok" });

  // Hermetic probe env, built from scratch: PATH so the launcher resolves node,
  // a SCRATCH HOME so no user ~/.amico/cloud.json (or pasqal.json) leaks in,
  // and none of the AMICO_* override envs cross over.
  const scratchHome = mkdtempSync(join(tmpdir(), "amico-cli-gate-home-"));
  const env = { PATH: process.env.PATH ?? "", HOME: scratchHome };
  const missingScript = join(scratchHome, "no_such_script.jl");

  for (const bin of declaredBins(binMapPath)) {
    const launcher = resolve(binDir, bin.launcher);
    if (!existsSync(launcher)) {
      push(bin.name, "launcher staged", `missing from the staged set: ${launcher}`);
      continue; // nothing to probe
    }
    push(bin.name, "launcher staged", null);
    try {
      accessSync(launcher, fsConstants.X_OK);
      push(bin.name, "launcher executable", null);
    } catch {
      push(bin.name, "launcher executable", `staged launcher is not executable: ${launcher}`);
      continue;
    }
    const dist = resolve(binDir, bin.dist);
    push(bin.name, "dist bundle staged", existsSync(dist) ? null : `missing dist bundle: ${dist}`);

    const probes = PROBES[bin.name];
    if (!probes) {
      push(bin.name, "behavioral probe", `no behavioral probe defined for declared bin "${bin.name}" — add one to scripts/assert_packaged_cli.mjs (fail-closed)`);
      continue;
    }
    for (const probe of probes) {
      const r = await execCapture(launcher, probe.args(missingScript), env);
      if (r.spawnError) {
        push(bin.name, probe.check, `launcher did not run: ${r.spawnError}`);
        continue;
      }
      push(bin.name, probe.check, probe.expect(r));
    }
  }
  return { ok: results.every((r) => r.ok), results };
}

async function main(argv) {
  let binDir = DEFAULT_BIN_DIR;
  let binMapPath = DEFAULT_BIN_MAP;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--bin-dir") binDir = resolve(argv[++i]);
    else if (argv[i] === "--bin-map") binMapPath = resolve(argv[++i]);
    else {
      console.error(`assert_packaged_cli: unknown arg ${argv[i]} (usage: [--bin-dir <dir>] [--bin-map <package.json>])`);
      return 2;
    }
  }
  console.log(`[cli-gate] bin dir: ${binDir}`);
  console.log(`[cli-gate] bin map: ${binMapPath}`);
  const { ok, results } = await runGate({ binDir, binMapPath });
  for (const r of results) console.log(`[cli-gate] ${r.ok ? "PASS" : "FAIL"}  ${r.bin.padEnd(14)} ${r.check}${r.ok ? "" : ` — ${r.detail}`}`);
  console.log(ok ? "[cli-gate] OK — every declared bin is staged and accepts the remote executor" : "[cli-gate] FAILED — the staged CLI is stale or incomplete (see FAIL lines)");
  return ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (c) => {
      process.exitCode = c;
    },
    (e) => {
      console.error(`[cli-gate] ${e.message}`);
      process.exitCode = 1;
    },
  );
}
