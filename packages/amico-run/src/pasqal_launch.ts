// packages/amico-run/src/pasqal_launch.ts
// The `amico-pasqal` launcher (issue #168, 159/S8): hand the stored Pasqal
// credential to a connector script WITHOUT the secret ever riding a command
// line. SECURITY: the token value must never appear in any argv at any layer
// (ps-visible, transcript-persisted), in an error message, or in a log line
// (the remote_config.ts / llm_creds.mjs stance) — the child environment
// (PASQAL_TOKEN + PASQAL_PROJECT_ID) is the secret's ONLY carriage, and the
// child env is built from scratch (never a process.env spread).
import { spawn } from "node:child_process";
import { accessSync, constants as fsConstants, existsSync, readFileSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { ConfigError } from "./types.js";
import { pasqalConfigFile } from "./paths.js";

export interface PasqalCredentials {
  projectId: string;
  token: string; // always a real string — no nulls at rest (slice #162 contract)
  expiresAt?: string; // ISO 8601; absent = the panel stored no expiry
}

/** $AMICO_PASQAL_FILE overrides the path (tests) — the cloudConfigFile idiom. */
export function pasqalCredentialFile(env: NodeJS.ProcessEnv = process.env): string {
  const v = env.AMICO_PASQAL_FILE;
  if (v && v.trim() !== "") return v;
  return pasqalConfigFile();
}

/** Read + shape-check the credential file. Distinct, actionable, TOKEN-FREE errors
 *  (AC3): the launcher never prompts and never mints — absent/expired credentials
 *  are the Connections panel's job to fix. Expiry is checked separately
 *  (assertPasqalFresh) so parse-level consumers (golden-fixture tests) stay
 *  time-independent. All failures are ConfigError — exit-64 class: nothing ran. */
export function readPasqalCredentials(env: NodeJS.ProcessEnv = process.env): PasqalCredentials {
  const file = pasqalCredentialFile(env);
  if (!existsSync(file))
    throw new ConfigError(`not connected — add Pasqal credentials in the Connections panel (no credential file at ${file})`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new ConfigError(`malformed Pasqal credential file at ${file} — reconnect in the Connections panel to rewrite it`);
  }
  const d = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  // Shape errors name KEYS only — a value could be a mistyped secret.
  if (typeof d.project_id !== "string" || d.project_id === "" || typeof d.token !== "string" || d.token === "")
    throw new ConfigError(
      `Pasqal credential file at ${file} needs non-empty string keys "project_id" and "token" — reconnect in the Connections panel`,
    );
  if (d.expires_at !== undefined && (typeof d.expires_at !== "string" || Number.isNaN(Date.parse(d.expires_at))))
    throw new ConfigError(
      `Pasqal credential file at ${file} has an unreadable "expires_at" — reconnect in the Connections panel`,
    );
  return { projectId: d.project_id, token: d.token, expiresAt: d.expires_at as string | undefined };
}

/** Expired token → distinct actionable error (AC3). The expiry timestamp is not a
 *  secret; the token value never appears. `now` is injectable for tests. */
export function assertPasqalFresh(creds: PasqalCredentials, now: Date = new Date()): void {
  if (creds.expiresAt !== undefined && Date.parse(creds.expiresAt) <= now.getTime())
    throw new ConfigError(
      `Pasqal token expired at ${creds.expiresAt} — reconnect in the Connections panel to mint a fresh one`,
    );
}

/** Interpreter resolution: $AMICO_PYTHON override (the documented escape hatch for
 *  GUI-launched macOS PATH issues), else python3 on PATH. Returns an ABSOLUTE path
 *  so the spawn is deterministic. Misconfiguration here is exit-64 class — clearly
 *  distinct from the connector's own exit-3 "service unreachable", which the
 *  launcher passes through untouched. */
export function resolvePasqalInterpreter(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.AMICO_PYTHON;
  const bin = override && override.trim() !== "" ? override : "python3";
  const candidates = bin.includes("/")
    ? [resolve(bin)]
    : (env.PATH ?? "")
        .split(delimiter)
        .filter(Boolean)
        .map((d) => join(d, bin));
  for (const c of candidates) {
    try {
      accessSync(c, fsConstants.X_OK);
      return c;
    } catch {
      /* keep looking */
    }
  }
  throw override
    ? new ConfigError(`AMICO_PYTHON interpreter not found or not executable: ${override}`)
    : new ConfigError(`python3 not found on PATH — install Python 3, or set AMICO_PYTHON to your interpreter`);
}

function signalCode(signal: NodeJS.Signals | null): number {
  const n = signal ? (osConstants.signals as Record<string, number>)[signal] : undefined;
  return 128 + (n ?? 1);
}

const USAGE = `usage: amico-pasqal <connector-script.py> [args…]
       credential file:  $AMICO_PASQAL_FILE, else ~/.amico/pasqal.json
       interpreter:      $AMICO_PYTHON, else python3 on PATH
The Pasqal token + project id reach the connector in ENV ONLY
(PASQAL_TOKEN, PASQAL_PROJECT_ID) — never on any command line.
The launcher takes NO secret arguments and passes everything after
the script through to the connector verbatim.`;

/** The launcher body. Config-class failures print one actionable line and exit 64
 *  (nothing ran); once the connector is spawned, its exit code passes through. */
export async function pasqalLaunch(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const head = argv[0];
  if (head === "--help" || head === "-h") {
    console.log(USAGE);
    return 0;
  }
  if (!head) {
    console.error(`amico-pasqal: no connector script given\n${USAGE}`);
    return 64;
  }
  if (head.startsWith("-")) {
    // No launcher flags exist by design — nothing can put a secret on OUR argv.
    console.error(`amico-pasqal: unknown flag ${head} (the launcher takes no flags)\n${USAGE}`);
    return 64;
  }
  const script = resolve(head);
  if (!existsSync(script)) {
    console.error(`amico-pasqal: connector script not found: ${script}`);
    return 64;
  }

  let creds: PasqalCredentials;
  let python: string;
  try {
    creds = readPasqalCredentials(env);
    assertPasqalFresh(creds);
    python = resolvePasqalInterpreter(env);
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(`amico-pasqal: ${e.message}`);
      return 64;
    }
    throw e;
  }

  // Minimal child env, built from scratch: the resolved PATH (shebang/interpreter
  // resolution inside the child) + the credential pair. NOTHING else crosses over.
  const childEnv: Record<string, string> = {
    PASQAL_TOKEN: creds.token,
    PASQAL_PROJECT_ID: creds.projectId,
  };
  if (env.PATH) childEnv.PATH = env.PATH;

  return new Promise<number>((resolveP) => {
    const child = spawn(python, [script, ...argv.slice(1)], { stdio: "inherit", env: childEnv });
    child.on("error", (e) => {
      // Post-resolution spawn fault (raced deletion, EACCES) — still config-class.
      console.error(`amico-pasqal: failed to start interpreter: ${(e as NodeJS.ErrnoException).code ?? "spawn error"}`);
      resolveP(64);
    });
    child.on("close", (code, signal) => resolveP(code ?? signalCode(signal)));
  });
}
