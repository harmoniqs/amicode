// packages/amico-run/src/pasqal_devices.ts — the read-only device-path core
// for the Pasqal Connection (issue #160). This module is the SELECTION surface:
// it consumes ONLY the connections seam's non-secret status cache
// ($AMICODE_CONNECTIONS_FILE → ~/.amico/connections.json, written by the fork's
// connections route, ADR 0002) — it NEVER reads the token file
// (~/.amico/pasqal.json), never spawns the validator, and never fires a probe.
// Everything here is pure over injected inputs so the whole thing is hermetic.
//
// The status cache holds a whitelisted `pasqal-cloud` entry: {state, identity,
// devices:[{id?,name?,state?}], validated_at, expires_at, …} (fork
// connections.ts ConnectionStatus). We re-whitelist on read: any stray key —
// a poisoned "token", anything — has no path into our output.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const PASQAL_CONNECTION_ID = "pasqal-cloud";

/** The ONLY free target. Everything else — EMU_TN, EMU_MPS, EMU_SV, FRESNEL
 *  (QPU), any future name — is NON-FREE (default-deny), so an unknown device
 *  can never slip past the paid-submission confirm gate (AC5). Matches the
 *  connector's FREE_DEVICES set. */
export const FREE_DEVICE_IDS: ReadonlySet<string> = new Set(["EMU_FREE"]);

/** A connected claim whose last validation is older than this renders its
 *  device list stale — the same 24h clock the fork's STALE_MS uses. */
export const CACHE_STALE_MS = 24 * 60 * 60 * 1000;

export type DeviceTier = "free" | "non-free";

/** $AMICODE_CONNECTIONS_FILE overrides the path (the fork's connectionsFile()
 *  idiom — same env var, so we read exactly what the route writes); default
 *  lives beside cloud.json under ~/.amico. */
export function connectionsCacheFile(env: NodeJS.ProcessEnv = process.env): string {
  const v = env.AMICODE_CONNECTIONS_FILE;
  if (v && v.trim() !== "") return v;
  return join(homedir(), ".amico", "connections.json");
}

/** Default-deny classification, case-insensitive on the identifier. */
export function classifyDeviceTier(idOrName: string): DeviceTier {
  return FREE_DEVICE_IDS.has(idOrName.trim().toUpperCase()) ? "free" : "non-free";
}

export interface ClassifiedDevice {
  id: string; // the stable identifier used for --device (id ?? name)
  name?: string;
  state?: string;
  tier: DeviceTier;
}

export type DevicePathBlockKind = "not-connected" | "expired" | "validating" | "no-devices" | "stale-devices";

export interface DevicePathBlock {
  kind: DevicePathBlockKind;
  /** distinct, actionable, secret-free (AC4). */
  message: string;
}

export interface DevicePathStatus {
  /** true iff the device path is usable (connected, fresh, ≥1 device). */
  ok: boolean;
  connection_state: string;
  identity?: string; // project id — non-secret (glossary: never the credential)
  validated_at: string | null;
  stale: boolean;
  devices: ClassifiedDevice[];
  block?: DevicePathBlock;
}

interface RawEntry {
  state?: unknown;
  identity?: unknown;
  validated_at?: unknown;
  expires_at?: unknown;
  devices?: unknown;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

/** Re-whitelist the cached device list — only id/name/state survive, each
 *  type-checked; a device needs at least an id or a name to be selectable. */
function whitelistDevices(v: unknown): ClassifiedDevice[] {
  if (!Array.isArray(v)) return [];
  const out: ClassifiedDevice[] = [];
  for (const raw of v) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const d = raw as Record<string, unknown>;
    const id = str(d.id) ?? str(d.name);
    if (!id) continue;
    const dev: ClassifiedDevice = { id, tier: classifyDeviceTier(id) };
    const name = str(d.name);
    const state = str(d.state);
    if (name) dev.name = name;
    if (state) dev.state = state;
    out.push(dev);
  }
  return out;
}

function readCacheEntry(file: string): RawEntry | undefined {
  try {
    if (!existsSync(file)) return undefined;
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
    const entry = (raw as Record<string, unknown>)[PASQAL_CONNECTION_ID];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return undefined;
    return entry as RawEntry;
  } catch {
    return undefined; // missing/unreadable/unparseable → absent, never a throw
  }
}

function isPastExpiry(expires_at: string | undefined, now: number): boolean {
  if (!expires_at) return false;
  const at = Date.parse(expires_at);
  return Number.isFinite(at) && at <= now;
}

function isStale(validated_at: string | null, now: number): boolean {
  if (!validated_at) return true;
  const at = Date.parse(validated_at);
  if (!Number.isFinite(at)) return true;
  return now - at > CACHE_STALE_MS;
}

const MSG_NOT_CONNECTED =
  "Pasqal is not connected — open the Connections panel and connect the Pasqal card (reconnect).";
const MSG_EXPIRED =
  "The Pasqal token has expired — reconnect the Pasqal card in the Connections panel to mint a fresh one (revalidate).";
const MSG_VALIDATING = "Pasqal validation is in progress — wait for it to finish, then try again.";
const MSG_NO_DEVICES =
  "The Pasqal connection exposes no devices — reconnect the Pasqal card in the Connections panel to re-list its devices.";

/** Derive the device-path status from the non-secret status cache. Pure over
 *  the injected file + clock; output carries only whitelisted, secret-free
 *  fields. AC4: every non-usable state carries a distinct, actionable block. */
export function readDevicePathStatus(
  opts: { file?: string; env?: NodeJS.ProcessEnv; now?: number } = {},
): DevicePathStatus {
  const file = opts.file ?? connectionsCacheFile(opts.env);
  const now = opts.now ?? Date.now();
  const entry = readCacheEntry(file);

  const state = (entry && str(entry.state)) ?? "needs-key";
  const identity = entry && str(entry.identity);
  const validated_at = (entry && str(entry.validated_at)) ?? null;
  const expires_at = entry && str(entry.expires_at);
  const devices = whitelistDevices(entry?.devices);
  const stale = isStale(validated_at, now);

  const base: DevicePathStatus = {
    ok: false,
    connection_state: state,
    ...(identity ? { identity } : {}),
    validated_at,
    stale,
    devices,
  };

  if (state === "validating") return { ...base, block: { kind: "validating", message: MSG_VALIDATING } };

  // not connected: absent entry, needs-key, or any failure state
  if (state !== "connected" && state !== "expired") {
    return { ...base, block: { kind: "not-connected", message: MSG_NOT_CONNECTED } };
  }

  // expired: an explicit expired state OR a past expiry outranks connected
  if (state === "expired" || isPastExpiry(expires_at, now)) {
    return { ...base, connection_state: "expired", block: { kind: "expired", message: MSG_EXPIRED } };
  }

  // connected: gate on device-list health
  if (devices.length === 0) return { ...base, block: { kind: "no-devices", message: MSG_NO_DEVICES } };
  if (stale) {
    return {
      ...base,
      block: {
        kind: "stale-devices",
        message: `The Pasqal device list is stale (last validated ${validated_at}) — revalidate the Pasqal card in the Connections panel to refresh it before submitting.`,
      },
    };
  }
  return { ...base, ok: true };
}

/** The secret-free submission digest the user/agent must confirm before a
 *  non-free run (AC5). The confirm token is a short hash bound to WHAT is being
 *  submitted — device + pulse content + project — so it cannot be reused for a
 *  different device or pulse, and no token or password is any part of it. */
export function submissionDigest(input: {
  deviceId: string;
  deviceName?: string;
  tier: DeviceTier;
  pulseSha256: string;
  projectId?: string;
}): { text: string; confirm: string } {
  const canonical = [
    `device=${input.deviceId}`,
    `tier=${input.tier}`,
    `pulse_sha256=${input.pulseSha256}`,
    `project=${input.projectId ?? ""}`,
  ].join("\n");
  const confirm = createHash("sha256").update(canonical).digest("hex").slice(0, 12);
  const text =
    `Submission digest (NON-FREE / paid target — explicit confirmation required):\n` +
    `  device:  ${input.deviceId}${input.deviceName && input.deviceName !== input.deviceId ? ` (${input.deviceName})` : ""}\n` +
    `  tier:    ${input.tier}\n` +
    `  pulse:   sha256 ${input.pulseSha256.slice(0, 16)}…\n` +
    `  project: ${input.projectId ?? "(unknown)"}\n` +
    `To submit, re-run with:  --confirm ${confirm}  (means: "yes, submit to ${input.deviceId}")`;
  return { text, confirm };
}

/** sha256 of a pulse file's bytes — the content binding for the digest. */
export function pulseSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
