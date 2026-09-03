// `amico premium` (#750, split design amicode#747) — the entitlement-gated
// premium surface. The Altissimo pattern: entitlement, not capability fork —
// the vault machinery works fully without the premium bundle (the split's
// funnel invariant); a not-granted report is an honest state (exit 0) naming
// the grant path, and a granted report lights the premium surfaces, each
// probed present-or-absent, never a crash.
//
// Read-only by construction: the report reads the entitlements file, the
// checkout paths, and the config presence. It never writes anything and
// never re-points inference (the routing seam is the designed swap point,
// touched only by its owner — the report merely NAMES it).
import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";

export interface PremiumDeps {
  checkDir?: (p: string) => boolean;
  checkFile?: (p: string) => boolean;
  readFile?: (p: string) => string | null;
  // for the agent count: list files under a dir (hermetic injection)
  listDir?: (p: string) => string[];
}

export interface PremiumSurfaces {
  checkout: boolean;
  notturno_engine: boolean;
  tuned_agents: number;
  routing_seam: boolean;
}

export interface PremiumReport {
  granted: boolean;
  surfaces: Partial<PremiumSurfaces>;
  rendered: string;
  json: string | null;
  exit: number;
}

export const PREMIUM_CODE = "amicissimo";

// v1 local reader, same shape + spirit as the extension's LocalEntitlementProvider
// (packages/extension/src/scores/entitlements.ts — the redemption service later
// replaces both). Minimal TOML: the v1 file is `codes = [...]` (+ `expired`).
// An absent file = public-only, silently; a malformed file = no codes, silently
// (an entitlement failure never dead-ends anything — the funnel invariant).
function readCodes(file: string, deps: PremiumDeps): string[] {
  const read = deps.readFile ?? ((p: string) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null));
  const raw = read(file);
  if (raw === null) return [];
  const m = /codes\s*=\s*\[([^\]]*)\]/.exec(raw);
  if (!m) return [];
  return Array.from(m[1].matchAll(/"([^"]+)"/g)).map((x) => x[1]);
}

export function premiumReport(argv: string[] = [], deps: PremiumDeps = {}): PremiumReport {
  const flag = (n: string): string | undefined => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const wantJson = argv.includes("--json");
  const badFlag = argv.find((a) => a.startsWith("--") && !["--json", "--checkout", "--config"].includes(a));
  if (badFlag || (argv.length > 0 && !argv[0].startsWith("--"))) {
    const message = `premium: unknown argument ${badFlag ?? argv[0]}`;
    return { granted: false, surfaces: {}, rendered: message, json: null, exit: 64 };
  }

  const exists = deps.checkDir ?? ((p: string) => fs.existsSync(p) && fs.statSync(p).isDirectory());
  const existsFile = deps.checkFile ?? ((p: string) => fs.existsSync(p));
  const configFile =
    flag("config") ?? path.join(homedir(), ".amico", "amicode", "entitlements.toml");
  const checkout =
    flag("checkout") ??
    (process.env.AMICISSIMO_ROOT ??
      path.join(homedir(), "harmoniqs", "amicissimo")) as string;

  const codes = readCodes(configFile, deps);
  const granted = codes.includes(PREMIUM_CODE);

  if (!granted) {
    const rendered = [
      "premium: not granted — the vault machinery works fully without it.",
      "",
      "Grant path: repo access to harmoniqs/amicissimo + the `amicissimo` code in",
      `  ${configFile}`,
      "",
      "Surfaces not probed (not granted).",
    ].join("\n");
    return {
      granted: false,
      surfaces: {},
      rendered,
      json: wantJson ? JSON.stringify({ granted: false, surfaces: {} }) : null,
      exit: 0,
    };
  }

  const checkoutPresent = exists(checkout);
  const enginePresent = checkoutPresent && exists(path.join(checkout, "automation"));
  const listDir =
    deps.listDir ?? ((p: string) => (fs.existsSync(p) ? fs.readdirSync(p) : []));
  const agentCount = checkoutPresent
    ? listDir(path.join(checkout, "vault", "agents")).filter((f) => f.endsWith(".md")).length
    : 0;
  // the seam is a SIBLING of the entitlements file (the real layout: ~/.amico/amicode/) —
  // derived, never hardcoded to a machine's home
  const seamPresent = existsFile(path.join(path.dirname(configFile), "distiller.config.json"));

  const surfaces: PremiumSurfaces = {
    checkout: checkoutPresent,
    notturno_engine: enginePresent,
    tuned_agents: agentCount,
    routing_seam: seamPresent,
  };

  const lines: string[] = ["premium: granted (the `amicissimo` entitlement code)", ""];
  if (checkoutPresent) {
    lines.push(`  checkout: ${checkout}`);
    lines.push(
      enginePresent
        ? `  notturno engine: present (${checkout}/automation — the job registry; see its README)`
        : `  notturno engine: not found at ${checkout}/automation (checkout present, engine absent — partial clone?)`,
    );
    lines.push(`  tuned brain: ${agentCount} agent definition(s) under vault/agents/`);
    lines.push(
      seamPresent
        ? "  routing seam: present — the inference routing points where the config says; the swap to a hosted tier is the config, nothing else"
        : "  routing seam: no distiller config on this machine (run armonia-distiller-config --write)",
    );
  } else {
    lines.push(`  checkout: not found at ${checkout} (repo-granted machine? clone harmoniqs/amicissimo or set AMICISSIMO_ROOT)`);
  }

  return {
    granted: true,
    surfaces,
    rendered: lines.join("\n"),
    json: wantJson ? JSON.stringify({ granted: true, surfaces }) : null,
    exit: 0,
  };
}
