// FLEET ACTIVATION (#398 — slice 4e, the beta activation wiring): the
// config/env-driven arming of the data plane's fleet mode. The activation
// gap this fills (recorded by the Slice A/B casts): the wiring option and
// the staging log line existed, but nothing supplied the fleet option's hub
// getter, so a beta machine had no path from "I configured a hub + tunnel"
// to "fleet mode arms".
//
// The contract, verbatim from the issue:
//
//   the service's fleet mode arms when (a) the amicissimo entitlement
//   resolves, (b) the lawful overlay manifest stages, AND (c) activation is
//   configured — a config field + env override (`fleet.hub.url` +
//   `fleet.tunnel.alias`, or the env equivalents) supplying the hub base URL
//   + tunnel alias. NO activation config → the fleet option is never passed
//   → byte-identical base (the H3 discipline extends to activation: absent
//   config = absent surface, by test).
//
// Named outcomes only: every not-armed state carries its reason (never a
// silent no-op, never a throw); a partially-configured activation is named
// by its MISSING half. Both fields are required — D7: the tunnel stamps its
// own config, and an activation without a tunnel alias cannot stamp one.
//
// Posture tuning (D6) rides the same config surface: the named keys with
// defaults equal to today's fixture values (no behavior change unless
// configured). A garbage value falls back to the default WITH a named note.
//
// vscode-free on purpose: the extension resolves its settings into the
// config fields; this module only applies the precedence (env overrides
// config) and the validation. The smoke harness resolves the same shape
// from env alone — one contract, both consumers.
import {
  DEGRADED_LATENCY_P95_MS,
  DEGRADED_WINDOW_SAMPLES,
  HUB_DOWN_CONSECUTIVE_NO_RESPONSES,
  RECOVERY_CONSECUTIVE_HEALTHY,
  type FleetPostureTuning,
} from "./amicode_service/fleet_posture";

/** The env equivalents of the activation config fields. The hub URL and
 *  tunnel alias are the two essentials; the tunnel config path makes the
 *  D7 stamp surface (stamped alias + generation marker) inspectable in the
 *  status route. */
export const FLEET_ACTIVATION_ENV = {
  hubUrl: "AMICODE_FLEET_HUB_URL",
  tunnelAlias: "AMICODE_FLEET_TUNNEL_ALIAS",
  tunnelConfigPath: "AMICODE_FLEET_TUNNEL_CONFIG",
} as const;

/** The activation config, already resolved from whatever surface the caller
 *  owns (the extension's `amicode.fleet*` settings; the smoke harness's
 *  env). Empty/whitespace strings are ABSENT, never armed-on-garbage. */
export interface FleetActivationConfig {
  /** The hub base URL (`amicode.fleetHubUrl`; env AMICODE_FLEET_HUB_URL). */
  hubUrl?: string;
  /** The tunnel's ssh alias (`amicode.fleetTunnelAlias`; env
   *  AMICODE_FLEET_TUNNEL_ALIAS) — D7: the installed tunnel config must
   *  carry the stamped alias, so activation names it and requires it. */
  tunnelAlias?: string;
  /** The installed tunnel config's path (`amicode.fleetTunnelConfigPath`;
   *  env AMICODE_FLEET_TUNNEL_CONFIG) — read per request by the status
   *  route; absence only means the D7 stamp is not surfaced. */
  tunnelConfigPath?: string;
  /** The overlay source root (env AMICO_OVERLAY_SOURCE already rides the
   *  staging ladder; a config value pins it explicitly). */
  overlaySource?: string;
  /** The D6 posture tuning overrides (named keys; defaults = the fixture
   *  values). Invalid values fall back to the default with a named note. */
  posture?: Partial<FleetPostureTuning>;
}

/** The resolved activation. Not-armed carries the NAMED reason — the fleet
 *  option is never passed for it, and the boot log says why. Armed carries
 *  everything the wiring needs, posture tuning fully resolved. */
export type FleetActivation =
  | { armed: false; reason: string }
  | {
      armed: true;
      hubUrl: string;
      tunnelAlias: string;
      tunnelConfigPath?: string;
      overlaySource?: string;
      posture: FleetPostureTuning;
      /** Named notes (e.g. an ignored invalid tuning value) — never silent. */
      notes: string[];
      /** Test/harness injection for the staging gate's inputs; undefined =
       *  the machine's real resolution (the production path). */
      entitlements?: string[] | null;
      entitlementConfigDir?: string;
    };

function pick(cfgVal: string | undefined, envVal: string | undefined): string | undefined {
  const e = envVal?.trim();
  if (e !== undefined && e !== "") return e;
  const c = cfgVal?.trim();
  if (c !== undefined && c !== "") return c;
  return undefined;
}

function tuningNumber(
  raw: number | undefined,
  name: string,
  dflt: number,
  notes: string[],
  integer: boolean,
): number {
  if (raw === undefined) return dflt;
  const ok = typeof raw === "number" && Number.isFinite(raw) && raw > 0 && (!integer || Number.isInteger(raw));
  if (!ok) {
    notes.push(`posture tuning ${name}: invalid value ${String(raw)} ignored — the default ${dflt} stands`);
    return dflt;
  }
  return raw;
}

/**
 * Resolve the fleet activation from config fields + env overrides (env
 * wins). Never throws: every outcome is named, every not-armed reason says
 * which half of the activation is missing.
 */
export function resolveFleetActivation(
  input: { config?: FleetActivationConfig; env?: NodeJS.ProcessEnv } = {},
): FleetActivation {
  const env = input.env ?? process.env;
  const cfg = input.config ?? {};
  const hubUrl = pick(cfg.hubUrl, env[FLEET_ACTIVATION_ENV.hubUrl]);
  const tunnelAlias = pick(cfg.tunnelAlias, env[FLEET_ACTIVATION_ENV.tunnelAlias]);
  const tunnelConfigPath = pick(cfg.tunnelConfigPath, env[FLEET_ACTIVATION_ENV.tunnelConfigPath]);
  const overlaySource = pick(cfg.overlaySource, env.AMICO_OVERLAY_SOURCE);

  if (hubUrl === undefined && tunnelAlias === undefined) {
    return {
      armed: false,
      reason:
        "no-activation-config: no fleet hub URL and no tunnel alias configured " +
        "(config fleet.hub.url / fleet.tunnel.alias, or their env equivalents) — " +
        "the fleet option is never passed, the base posture is byte-identical",
    };
  }
  if (hubUrl === undefined) {
    return {
      armed: false,
      reason:
        "hub-url-missing: a tunnel alias is configured but no hub base URL — " +
        "activation is incomplete, the fleet option is never passed",
    };
  }
  if (tunnelAlias === undefined) {
    return {
      armed: false,
      reason:
        "tunnel-alias-missing: a hub URL is configured but no tunnel alias — " +
        "the tunnel stamps its own config (D7) and an activation without an " +
        "alias cannot stamp one, so the fleet option is never passed",
    };
  }

  const notes: string[] = [];
  const p = cfg.posture ?? {};
  const posture: FleetPostureTuning = {
    degradedLatencyP95Ms: tuningNumber(p.degradedLatencyP95Ms, "degradedLatencyP95Ms", DEGRADED_LATENCY_P95_MS, notes, false),
    degradedWindowSamples: tuningNumber(p.degradedWindowSamples, "degradedWindowSamples", DEGRADED_WINDOW_SAMPLES, notes, true),
    hubDownConsecutiveNoResponses: tuningNumber(
      p.hubDownConsecutiveNoResponses,
      "hubDownConsecutiveNoResponses",
      HUB_DOWN_CONSECUTIVE_NO_RESPONSES,
      notes,
      true,
    ),
    recoveryConsecutiveHealthy: tuningNumber(
      p.recoveryConsecutiveHealthy,
      "recoveryConsecutiveHealthy",
      RECOVERY_CONSECUTIVE_HEALTHY,
      notes,
      true,
    ),
  };

  return {
    armed: true,
    hubUrl,
    tunnelAlias,
    ...(tunnelConfigPath !== undefined ? { tunnelConfigPath } : {}),
    ...(overlaySource !== undefined ? { overlaySource } : {}),
    posture,
    notes,
  };
}
