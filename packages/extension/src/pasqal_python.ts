/** Pasqal python provisioning (sequel to #161's staging; the fresh-install fix).
 *
 *  The fork's Connections panel validates a Pasqal credential by spawning
 *  pasqal_validate.py with interpreter = $AMICO_PYTHON when set, else bare
 *  `python3` from the server child's PATH. On a fresh machine no ambient
 *  interpreter has pasqal-cloud, the validator exits 1 ("SDK not installed"),
 *  and the panel renders the config lane as "Service unreachable" — the
 *  credential is never even checked.
 *
 *  This module makes the extension own that interpreter: provision a venv
 *  under <opsDir>/venvs/pasqal-connector from the STAGED requirements.txt
 *  (hash-gated, stamp-on-success), and the activation hands the venv python
 *  to buildServerSpawnEnv as AMICO_PYTHON. A host-set $AMICO_PYTHON wins
 *  outright and skips provisioning — the same user-override precedence as
 *  $AMICO_PASQAL_VALIDATOR. Failures never throw to the caller and never set
 *  AMICO_PYTHON (absent, not empty): the server keeps today's fallback. */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { amicodeOpsDir } from "./substrate/vault_store";
import { pasqalConnectorDir } from "./pasqal_assets";

/** <opsDir>/venvs/pasqal-connector — extension-owned, like the staged dir. */
export function pasqalVenvDir(opsDir: string = amicodeOpsDir()): string {
  return path.join(opsDir, "venvs", "pasqal-connector");
}

/** Posix layout only — the lock file targets darwin-arm64 and linux-x64. */
export function venvPython(venvDir: string): string {
  return path.join(venvDir, "bin", "python");
}

/** Stamp written next to the venv ONLY after pip succeeds — a failed provision
 *  leaves no stamp, so the next activation retries for free. */
export const REQUIREMENTS_STAMP = ".requirements.sha256";

/** sha256 of the STAGED requirements.txt bytes (the #161 copy the panel's
 *  validator dir carries — the extension's source tree is not on user disks). */
export function requirementsHash(requirementsPath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(requirementsPath)).digest("hex");
}

/** stat + hash only — the activation fast path must never spawn anything. */
export function needsProvision(opsDir: string = amicodeOpsDir()): boolean {
  const venv = pasqalVenvDir(opsDir);
  try {
    if (!fs.existsSync(venvPython(venv))) return true;
    const stamp = fs.readFileSync(path.join(venv, REQUIREMENTS_STAMP), "utf8").trim();
    return stamp !== requirementsHash(path.join(pasqalConnectorDir(opsDir), "requirements.txt"));
  } catch {
    return true; // unreadable stamp/requirements = re-provision, fail-safe
  }
}

/** pasqal-cloud 0.23 needs 3.10+; the macOS system python is 3.9 by design. */
export const MIN_PYTHON: readonly [number, number] = [3, 10];

/** Parse the `%d.%d` probe output. Anything unparseable fails safe (not-ok) —
 *  a candidate that can't state its version is not a candidate. */
export function parsePythonVersion(stdout: string): { ok: true; major: number; minor: number } | { ok: false } {
  const m = /^(\d+)\.(\d+)\s*$/.exec(stdout.trim());
  if (!m) return { ok: false };
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (major > MIN_PYTHON[0] || (major === MIN_PYTHON[0] && minor >= MIN_PYTHON[1])) return { ok: true, major, minor };
  return { ok: false };
}

/** Interpreter candidates, first suitable wins. `python3` resolves via the
 *  child PATH; the absolute paths cover Dock-launched VS Code whose extension
 *  host inherits the launchd-minimal PATH (no homebrew — today's bug). */
export const DEFAULT_PYTHON_CANDIDATES: readonly string[] = [
  "python3",
  "/opt/homebrew/bin/python3",
  "/usr/local/bin/python3",
  "/usr/bin/python3",
];

const VERSION_PROBE = ["-c", "import sys; print('%d.%d' % sys.version_info[:2])"] as const;

/** Injectable subprocess seam (the #160 LauncherSpawn convention). */
export type ProvisionSpawn = (
  bin: string,
  argv: string[],
  env: Record<string, string>,
) => Promise<{ code: number; stdout: string }>;

const realSpawn: ProvisionSpawn = (bin, argv, env) =>
  new Promise((resolve) => {
    import("node:child_process").then(({ execFile }) => {
      execFile(bin, argv, { env, timeout: 300_000 }, (err, stdout) => {
        if (!err) return resolve({ code: 0, stdout: stdout ?? "" });
        // err.code: number = exit code; string (ENOENT/ETIMEDOUT) = spawn-level
        // failure — both are "this candidate/step failed", nonzero.
        const raw: unknown = (err as NodeJS.ErrnoException).code;
        resolve({ code: typeof raw === "number" ? raw : 1, stdout: stdout ?? "" });
      });
    });
  });

export type ProvisionResult = { ok: true; pythonPath: string; provisioned: boolean } | { ok: false; message: string };

/** Provision (or reuse) the extension-owned venv and return its interpreter.
 *  Never throws; every failure lane returns one actionable message and leaves
 *  no stamp, so the next activation retries. */
export async function provisionPasqalPython(
  opts: {
    opsDir?: string;
    env?: Record<string, string | undefined>;
    candidates?: readonly string[];
    spawn?: ProvisionSpawn;
  } = {},
): Promise<ProvisionResult> {
  const opsDir = opts.opsDir ?? amicodeOpsDir();
  const spawn = opts.spawn ?? realSpawn;
  const candidates = opts.candidates ?? DEFAULT_PYTHON_CANDIDATES;
  const env = opts.env ?? process.env;
  // From-scratch child env: PATH to resolve `python3`, HOME because pip and
  // venv read it. Nothing else — no PASQAL_* secret can ride along.
  const childEnv: Record<string, string> = { PATH: env.PATH ?? "", HOME: env.HOME ?? "" };
  const venv = pasqalVenvDir(opsDir);
  const python = venvPython(venv);

  // Host override wins outright and skips provisioning entirely — the same
  // precedence as $AMICO_PASQAL_VALIDATOR. Absent-not-empty, like the fork.
  const override = env.AMICO_PYTHON;
  if (override !== undefined && override.trim() !== "") {
    return { ok: true, pythonPath: override, provisioned: false };
  }

  try {
    if (!needsProvision(opsDir)) return { ok: true, pythonPath: python, provisioned: false };

    const reqPath = path.join(pasqalConnectorDir(opsDir), "requirements.txt");

    let host: string | undefined;
    for (const candidate of candidates) {
      const probe = await spawn(candidate, [...VERSION_PROBE], childEnv);
      if (probe.code === 0 && parsePythonVersion(probe.stdout).ok) {
        host = candidate;
        break;
      }
    }
    if (host === undefined) return { ok: false, message: MSG_NO_PYTHON };

    const venvResult = await spawn(host, ["-m", "venv", venv], childEnv);
    if (venvResult.code !== 0) return { ok: false, message: MSG_VENV_FAILED };

    const pip = await spawn(python, ["-m", "pip", "install", "-r", reqPath], childEnv);
    if (pip.code !== 0) return { ok: false, message: MSG_PIP_FAILED };

    fs.mkdirSync(venv, { recursive: true });
    fs.writeFileSync(path.join(venv, REQUIREMENTS_STAMP), requirementsHash(reqPath));
    return { ok: true, pythonPath: python, provisioned: true };
  } catch {
    // Fixed string only — exception text could echo paths/env we don't control.
    return { ok: false, message: MSG_VENV_FAILED };
  }
}

/** Fixed, actionable, secret-free failure copy (one line per lane). */
export const MSG_NO_PYTHON =
  "pasqal python provisioning failed: no python3 >= 3.10 found — install Python 3.10+ or set AMICO_PYTHON to an interpreter with pasqal-cloud==0.23.0";
export const MSG_VENV_FAILED =
  "pasqal python provisioning failed: could not create the venv — check disk/permissions, or set AMICO_PYTHON to an interpreter with pasqal-cloud==0.23.0";
export const MSG_PIP_FAILED =
  "pasqal python provisioning failed: pip install did not complete (offline?) — it retries next activation, or set AMICO_PYTHON to an interpreter with pasqal-cloud==0.23.0";
