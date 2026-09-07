// FLEET TUNNEL STAMP (amicissimo#392 — the local-shell data plane, Slice B,
// D7): "the tunnel stamps its own config". Two named stamps:
//
//  1. The STAMPED ALIAS — the installed tunnel config must carry the real
//     alias, never the literal `FLEET_SSH_ALIAS` placeholder. The 2026-09-03
//     hand-rejoin finding is an obligation with a fixture: an unstamped
//     tunnel cannot ship again (the rejoin fixture asserts it).
//  2. The GENERATION — the config carries a tunnel generation marker
//     (`amicode-tunnel-generation: N`); a rejoin bumps it, and the transport
//     stamps every proxied response (SSE included) with
//     `x-amicode-tunnel-generation`, so a rejoin can tell which tunnel
//     generation produced the stream.
//
// All outcomes are NAMED: a placeholder, a missing alias, an absent config —
// never a silent pass, never a throw.
import { existsSync, readFileSync } from "node:fs";

/** The literal placeholder that must never survive into an installed
 *  tunnel config (the hand-rejoin regression). */
export const TUNNEL_ALIAS_PLACEHOLDER = "FLEET_SSH_ALIAS";

/** The response header the transport stamps proxied responses with — the
 *  generation a rejoin is told apart by. */
export const TUNNEL_GENERATION_HEADER = "x-amicode-tunnel-generation";

const GENERATION_MARKER_RE = /amicode-tunnel-generation:\s*(\d+)/;

export type TunnelStampInspection =
  | { stamped: true; alias: string | null; generation: number | null }
  | { stamped: false; reason: "placeholder-present" | "alias-absent" | "config-absent"; generation: number | null };

/** Stamp the alias into a tunnel config: every placeholder occurrence is
 *  replaced; an optional generation lays the generation marker down (into
 *  an XML comment before `</plist>` for plists, a trailing comment line
 *  otherwise). */
export function stampTunnelAlias(
  configText: string,
  alias: string,
  generation?: number,
): { ok: true; text: string; alias: string } | { ok: false; reason: "alias-empty" } {
  const a = alias.trim();
  if (a === "") return { ok: false, reason: "alias-empty" };
  let text = configText.split(TUNNEL_ALIAS_PLACEHOLDER).join(a);
  if (generation !== undefined) text = setGenerationMarker(text, generation);
  return { ok: true, text, alias: a };
}

/** The generation a config carries, or null when it carries none. */
export function readTunnelGeneration(configText: string): number | null {
  const m = GENERATION_MARKER_RE.exec(configText);
  return m ? Number(m[1]) : null;
}

/** A rejoin: bump the generation — the new tunnel generation the client
 *  can tell apart from the old one's streams. */
export function bumpTunnelGeneration(configText: string): { ok: true; text: string; generation: number } {
  const current = readTunnelGeneration(configText);
  const generation = (current ?? 0) + 1;
  return { ok: true, text: setGenerationMarker(configText, generation), generation };
}

/** Inspect a config's stamp. With `expectAlias`, the fixture's sharp form:
 *  the config must carry no placeholder AND contain that alias. */
export function inspectTunnelStamp(configText: string | null | undefined, expectAlias?: string): TunnelStampInspection {
  if (configText === null || configText === undefined) {
    return { stamped: false, reason: "config-absent", generation: null };
  }
  const generation = readTunnelGeneration(configText);
  if (configText.includes(TUNNEL_ALIAS_PLACEHOLDER)) {
    return { stamped: false, reason: "placeholder-present", generation };
  }
  if (expectAlias !== undefined && !configText.includes(expectAlias)) {
    return { stamped: false, reason: "alias-absent", generation };
  }
  return { stamped: true, alias: expectAlias ?? null, generation };
}

/** Read + inspect the installed tunnel config file. An absent or
 *  unreadable config is the NAMED config-absent outcome — the honest
 *  setup state, never a throw. */
export function inspectTunnelConfigFile(path: string | undefined, expectAlias?: string): TunnelStampInspection {
  if (!path || !existsSync(path)) return { stamped: false, reason: "config-absent", generation: null };
  try {
    return inspectTunnelStamp(readFileSync(path, "utf8"), expectAlias);
  } catch {
    return { stamped: false, reason: "config-absent", generation: null };
  }
}

function setGenerationMarker(text: string, generation: number): string {
  const marker = `amicode-tunnel-generation: ${generation}`;
  if (GENERATION_MARKER_RE.test(text)) return text.replace(GENERATION_MARKER_RE, marker);
  // lay the marker down where the format can carry it: an XML comment
  // before </plist> for plists, a trailing comment line otherwise
  if (text.includes("</plist>")) {
    return text.replace("</plist>", `  <!-- ${marker} -->\n</plist>`);
  }
  return `${text.replace(/\n*$/, "\n")}# ${marker}\n`;
}
