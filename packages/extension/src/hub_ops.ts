// hub_ops.ts — "Amicode: Restart Hub Server" (amicode#649).
// Fleet clients restart the canonical hub over SSH by driving the hub-side
// ops script. The restart is initiated from the CLIENT's extension host — a
// surface NOT hosted on the hub — so it can never kill its own runtime (the
// 2026-08-30 self-host trap: an agent shell on the hub died mid-`systemctl`
// twice, once leaving a manual stop as the last action and the hub down).
// All process execution and HTTP is injected so the decision logic is
// unit-testable without a hub.

import { type FleetConfig } from "./fleet_fallback";

export type RunResult = { code: number; stdout: string; stderr: string };
export type Runner = (cmd: string[]) => Promise<RunResult>;

export type HubTarget = { alias: string; host: string; port: number };

/** The hub target from the client's fleet config: the canonical server's SSH
 *  alias + host:port. Null when the config doesn't name an alias (standalone
 *  machines and half-configured clients are the caller's problem). */
export function resolveHubTarget(cfg: FleetConfig | null | undefined): HubTarget | null {
  const canonical = cfg?.canonical;
  if (!canonical || typeof canonical.sshAlias !== "string" || canonical.sshAlias.trim() === "") return null;
  if (typeof canonical.host !== "string" || canonical.host === "") return null;
  const port = typeof canonical.port === "number" && Number.isFinite(canonical.port) ? canonical.port : 4096;
  return { alias: canonical.sshAlias.trim(), host: canonical.host, port };
}

/** The hub answers with 200 (unsecured posture) or 401 (auth gate) when
 *  serving — the canary is "the socket answers", not the auth posture. */
export function isServingCode(code: number): boolean {
  return code === 200 || code === 401;
}

const SCRIPT_PATH = ".amico/ops/hub-restart.sh";

function sshCmd(alias: string, args: string): string[] {
  return ["ssh", "-o", "ConnectTimeout=8", "-o", "BatchMode=yes", alias, `bash $HOME/${SCRIPT_PATH} ${args}`];
}

export type HubRestartStep = { step: "precheck" | "restart" | "canary"; ok: boolean; detail: string };

/** Drive the hub-side script: verify → restart → client-side tunnel canary.
 *  Every step reports honestly; a failed precheck never restarts. */
export async function restartHub(
  target: HubTarget,
  run: Runner,
  canary: (url: string) => Promise<number>,
): Promise<{ ok: boolean; steps: HubRestartStep[] }> {
  const steps: HubRestartStep[] = [];
  const pre = await run(sshCmd(target.alias, "verify")).catch((e: unknown) => ({
    code: -1,
    stdout: "",
    stderr: e instanceof Error ? e.message : String(e),
  }));
  steps.push({
    step: "precheck",
    ok: pre.code === 0,
    detail: pre.code === 0 ? (pre.stdout.trim().split("\n").find((l) => l.startsWith("verify:")) ?? "") : `unreachable: ${pre.stderr.trim() || `exit ${pre.code}`}`,
  });
  if (!steps[0].ok) return { ok: false, steps };

  const res = await run(sshCmd(target.alias, "restart")).catch((e: unknown) => ({
    code: -1,
    stdout: "",
    stderr: e instanceof Error ? e.message : String(e),
  }));
  const verifyLine = res.stdout.trim().split("\n").find((l) => l.startsWith("verify:")) ?? "";
  steps.push({ step: "restart", ok: res.code === 0, detail: res.code === 0 ? verifyLine : res.stdout.trim() || res.stderr.trim() || `exit ${res.code}` });
  if (!steps[steps.length - 1].ok) return { ok: false, steps };

  const code = await canary(`http://127.0.0.1:${target.port}/`).catch(() => 0);
  steps.push({ step: "canary", ok: isServingCode(code), detail: `tunnel http=${code}` });
  return { ok: steps[steps.length - 1].ok, steps };
}
