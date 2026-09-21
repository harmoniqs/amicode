// FLEET HUB SERVICE (#1258 — reboot-survival for the canonical hub).
//
// The Studio's canonical hub must survive a REBOOT with NO editor ever opened.
// Today the hub is the extension-spawned detached server (ADR 0020): it
// survives a window close, but DIES ON REBOOT — so a roaming client cannot
// attach until someone opens a VS Code window on the hub. This module renders
// the OS service units that make the hub a persistent headless service.
//
// The corrected design (this issue supersedes the WITHDRAWN original scope):
// run the EXISTING #955 headless runner (amicode_service_runner_cli.ts, bundled
// to bin/dist/amicode-service-runner.mjs) under launchd (macOS) / systemd
// (Linux) with RunAtLoad + KeepAlive — NOT a bespoke `opencode serve` wrapper.
// A bespoke wrapper on the canonical port is reclaim-killed by the editor's
// adoptOrSpawn path, and it puts TWO writers on one SQLite DB — the failure the
// review found. Running the SAME runner the editor would adopt keeps ONE
// canonical DB / ONE writer (ADR 0005): the editor attaches to the running
// service instead of spawning a rival.
//
// This is the HUB SERVICE unit — DISTINCT from #1260's TUNNEL unit
// (systemdTunnelUnit / the co.harmoniqs.amico-tunnel.plist), which runs an
// `ssh -L` forward. The tunnel is the client↔hub transport; this is the hub's
// own reboot-survival. `fleet_transport.ts` owns the tunnel; this module owns
// the service — deliberately not conflated (both are pure-function renderers so
// the installer stays a thin, testable per-OS writer around them).
//
// Invariants held:
//   - One canonical DB / ONE writer (ADR 0005): the unit execs the runner (not
//     a bespoke server) and pins OPENCODE_DB to the canonical store.
//   - Never-fork (ADR 0005): a CLIENT never gets this unit — it is the HUB's
//     provisioning (the installer gates it on role=server).

/** The launchd Label / systemd identity of the canonical hub service. Distinct
 *  from the tunnel's `co.harmoniqs.amico-tunnel`. */
export const HUB_SERVICE_LABEL = "co.harmoniqs.amico-hub";

/** The default stdout/stderr redirection target for the launchd agent. */
const DEFAULT_LOG = "/tmp/amico-hub.log";

/** The deployment facts the installer resolves on the canonical hub and bakes
 *  into the service unit. A pure input — the renderers read process/fs nothing,
 *  so the unit suite exercises them without a host. */
export interface HubServiceUnitOptions {
  /** Absolute path to the `node` executable. launchd/systemd need an absolute
   *  program (no PATH lookup) — the installer resolves it via `command -v node`. */
  nodeBin: string;
  /** Absolute path to the bundled #955 runner
   *  (`bin/dist/amicode-service-runner.mjs`) — the program both OS forms exec. */
  runnerPath: string;
  /** AMICODE_APP_DIST — the built app-bundle dist root the runner serves. The
   *  runner REQUIRES it (it fails loud at boot when unset — #955 contract). */
  appDist: string;
  /** AMICODE_SERVICE_PORT — the canonical fleet port the whole fleet targets
   *  (the tunnel forwards to it, `tailscale serve` fronts it). */
  servicePort: number;
  /** OPENCODE_DB — the canonical ONE-writer store (ADR 0005). Pinning it is how
   *  the service and the editor share exactly one SQLite DB. */
  dbPath: string;
  /** stdout/stderr redirection target (launchd). Default `/tmp/amico-hub.log`. */
  logPath?: string;
  /** launchd Label / systemd identity. Default `co.harmoniqs.amico-hub`. */
  label?: string;
  /** Deploy-policy env layered OVER the required set — e.g. the hub's
   *  anonymous boundary posture (AMICODE_ENGINE_UNARMED=1 / AMICODE_SERVICE_AUTH=open,
   *  #955). NEVER credentials (the runner mints its own). Kept optional so this
   *  renderer stays scoped to reboot-survival; auth posture is the deploy's call. */
  extraEnv?: Record<string, string>;
}

/** The env the hub-service unit sets: the runner's required surface plus the
 *  ONE-writer pin, then any deploy-policy `extraEnv` layered over it. Ordered
 *  deterministically so the rendered unit is stable call-to-call. */
export function hubServiceEnv(opts: HubServiceUnitOptions): Record<string, string> {
  return {
    AMICODE_APP_DIST: opts.appDist,
    // #1354: the hub's embedded engine must NOT collide with the extension's
    // engine. Layout on a server: FLEET_PORT-3 hub-engine · FLEET_PORT-2
    // ext-engine · FLEET_PORT-1 app-shelf · FLEET_PORT hub-service.
    AMICODE_ENGINE_PORT: String(opts.servicePort - 3),
    // #1354: open-auth REQUIRES an unarmed engine — /global/health proxies to
    // the engine, which 401s if it holds a password. The SSH tunnel is the
    // boundary; the engine behind it is passwordless. This is the matched pair
    // to AMICODE_SERVICE_AUTH=open, not optional deploy policy.
    AMICODE_ENGINE_UNARMED: "1",
    AMICODE_SERVICE_AUTH: "open", // #1354: the SSH tunnel is the auth boundary
    AMICODE_SERVICE_PORT: String(opts.servicePort),
    OPENCODE_DB: opts.dbPath, // the canonical ONE-writer store (ADR 0005)
    ...(opts.extraEnv ?? {}),
  };
}

/** The argv both OS forms exec: `node` → the bundled #955 runner. NEVER
 *  `opencode serve` (the withdrawn bespoke-wrapper design, which would be a
 *  SECOND writer on the canonical SQLite DB). This is the ONE-writer program —
 *  the SAME runner the editor's adoptOrSpawn attaches to. */
export function hubServiceProgramArgs(opts: HubServiceUnitOptions): string[] {
  return [opts.nodeBin, opts.runnerPath];
}

/** Escape a value for XML text/attribute content (plist string bodies). */
function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The launchd plist — the macOS reboot-survival form. `RunAtLoad` boots the
 *  service on load (so it comes up on reboot with NO editor opened) and
 *  `KeepAlive` restarts it if it dies. `ProgramArguments` execs the #955 runner
 *  (node → amicode-service-runner.mjs) — never a bespoke `opencode serve`. The
 *  EnvironmentVariables dict carries the runner's required env + the OPENCODE_DB
 *  one-writer pin. Tab-indented to match the existing co.harmoniqs.amico-tunnel
 *  plist house style. */
export function launchdHubServiceUnit(opts: HubServiceUnitOptions): string {
  const label = opts.label ?? HUB_SERVICE_LABEL;
  const log = opts.logPath ?? DEFAULT_LOG;
  const argXml = hubServiceProgramArgs(opts)
    .map((a) => `\t\t<string>${xmlEscape(a)}</string>`)
    .join("\n");
  const envXml = Object.entries(hubServiceEnv(opts))
    .map(([k, v]) => `\t\t<key>${xmlEscape(k)}</key>\n\t\t<string>${xmlEscape(v)}</string>`)
    .join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "\t<key>Label</key>",
    `\t<string>${xmlEscape(label)}</string>`,
    "\t<key>ProgramArguments</key>",
    "\t<array>",
    argXml,
    "\t</array>",
    "\t<key>EnvironmentVariables</key>",
    "\t<dict>",
    envXml,
    "\t</dict>",
    "\t<key>RunAtLoad</key>",
    "\t<true/>",
    "\t<key>KeepAlive</key>",
    "\t<true/>",
    "\t<key>StandardOutPath</key>",
    `\t<string>${xmlEscape(log)}</string>`,
    "\t<key>StandardErrorPath</key>",
    `\t<string>${xmlEscape(log)}</string>`,
    "\t<key>ThrottleInterval</key>",
    "\t<integer>10</integer>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

/** The systemd USER unit — the Linux reboot-survival form (the Linux
 *  implementation of the same service). `[Install] WantedBy=default.target`
 *  means `systemctl --user enable` starts it at boot (the RunAtLoad equivalent);
 *  `Restart=always` is the KeepAlive equivalent. `ExecStart` execs the #955
 *  runner (node → amicode-service-runner.mjs) — never a bespoke `opencode
 *  serve`. Each env var is an `Environment=` line, including the OPENCODE_DB
 *  one-writer pin. Install as `~/.config/systemd/user/amico-hub.service` and
 *  `systemctl --user enable --now` it (the fleet installer wires this on the
 *  canonical hub). */
export function systemdHubServiceUnit(opts: HubServiceUnitOptions): string {
  const exec = hubServiceProgramArgs(opts).join(" ");
  const envLines = Object.entries(hubServiceEnv(opts)).map(([k, v]) => `Environment=${k}=${v}`);
  return [
    "[Unit]",
    "Description=Amico canonical hub service (headless amicode_service runner — reboot-survival, #1258)",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    ...envLines,
    `ExecStart=${exec}`,
    "Restart=always",
    "RestartSec=10",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}
