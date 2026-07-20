// Behavioral provisioning gate (sequel to assert_packaged_cli.mjs / #161):
// prove the SHIPPED pasqal-connector assets can actually provision a working
// interpreter — the guard against shipping a requirements.txt that doesn't
// install the SDK the validator needs (the v0.0.3-alpha fresh-install bug:
// validator exit 1 → the panel's misleading "Service unreachable").
//
// Artifact-behavioral only: the extension-side provisioning LOGIC
// (hash gating, override precedence, fail-closed lanes) is vitest-covered in
// test/pasqal_python.test.ts; this gate exercises the assets + a real
// python3, hermetically (scratch HOME; from-scratch {PATH,HOME} env).
//
// Lanes (CLI: node assert_provisioned_python.mjs [--assets-dir <dir>]):
//   pin        — requirements.txt carries an exact pasqal-cloud== pin
//   venv+pip   — a real venv provisions from the shipped requirements (PyPI)
//   sdk-import — the venv python imports pasqal_cloud at the pinned version
//   validator  — the venv python executes pasqal_validate.py; with no env it
//                exits 1 on the env guard (interpreter contract, no network)
// Fail-closed: any lane that cannot run is a FAIL, never a skip.
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ASSETS_DIR = join(HERE, "pasqal-connector");

/** The single source of truth: the exact == pin in the SHIPPED requirements. */
export function pinnedPasqalCloudVersion(reqPath) {
  const m = /^pasqal-cloud==([0-9][0-9A-Za-z.]*)\s*$/m.exec(readFileSync(reqPath, "utf8"));
  return m ? m[1] : undefined;
}

function run(bin, argv, env, timeoutMs = 300_000) {
  try {
    const stdout = execFileSync(bin, argv, { env, timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, stdout: stdout.toString() };
  } catch (err) {
    return {
      code: typeof err.status === "number" ? err.status : 1,
      stdout: (err.stdout ?? "").toString(),
      stderr: (err.stderr ?? "").toString(),
    };
  }
}

export async function runGate({ assetsDir = DEFAULT_ASSETS_DIR } = {}) {
  const results = [];
  const check = (name, ok, detail) => results.push({ check: name, ok, detail });

  const reqPath = join(assetsDir, "requirements.txt");
  const validatorPath = join(assetsDir, "pasqal_validate.py");
  const scratchHome = mkdtempSync(join(tmpdir(), "amico-pasqal-provision-home-"));
  // From-scratch env — the same {PATH, HOME} contract the provisioner uses.
  const env = { PATH: process.env.PATH ?? "", HOME: scratchHome };

  // pin: an exact == pin, parseable — unpinned requirements red (the
  // declared-but-unpinned analog of a declared-but-unprobed bin).
  const pin = existsSync(reqPath) ? pinnedPasqalCloudVersion(reqPath) : undefined;
  check("pin", pin !== undefined, pin ? `pasqal-cloud==${pin}` : `no exact pasqal-cloud== pin in ${reqPath}`);

  // venv+pip: a real provision from the shipped assets.
  const venv = join(scratchHome, "venv");
  const venvPython = join(venv, "bin", "python");
  let provisioned = false;
  if (pin !== undefined) {
    const mkvenv = run("python3", ["-m", "venv", venv], env);
    if (mkvenv.code !== 0)
      check("venv+pip", false, `python3 -m venv failed (${mkvenv.code}) — gate needs python3 >= 3.10 on PATH`);
    else {
      const pip = run(venvPython, ["-m", "pip", "install", "-r", reqPath], env);
      provisioned = pip.code === 0;
      check("venv+pip", provisioned, provisioned ? venv : `pip install -r failed (${pip.code})`);
    }
  } else check("venv+pip", false, "skipped-as-fail: no pin");

  // sdk-import: the provisioned interpreter imports the SDK at the pinned
  // version — the exact thing the validator needs at panel-connect time.
  if (provisioned) {
    const probe = run(
      venvPython,
      ["-c", "import pasqal_cloud, importlib.metadata as m; print(m.version('pasqal-cloud'))"],
      env,
    );
    const got = probe.stdout.trim();
    check("sdk-import", probe.code === 0 && got === pin, probe.code === 0 ? `pasqal-cloud ${got}` : "import failed");
  } else check("sdk-import", false, "skipped-as-fail: no venv");

  // validator: interpreter contract smoke — no env vars → the env guard exits
  // 1 BEFORE any import/network; proves the venv python executes the script.
  if (provisioned && existsSync(validatorPath)) {
    const v = run(venvPython, [validatorPath], env, 60_000);
    check("validator", v.code === 1, `exit ${v.code} (want 1: missing-env guard)`);
  } else check("validator", false, existsSync(validatorPath) ? "skipped-as-fail: no venv" : `missing ${validatorPath}`);

  return results;
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMain) {
  const argIdx = process.argv.indexOf("--assets-dir");
  const assetsDir = argIdx >= 0 ? process.argv[argIdx + 1] : DEFAULT_ASSETS_DIR;
  const results = await runGate({ assetsDir });
  let failed = 0;
  for (const r of results) {
    // eslint-disable-next-line no-console
    console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.check}  ${r.detail}`);
    if (!r.ok) failed++;
  }
  process.exit(failed === 0 ? 0 : 1);
}
