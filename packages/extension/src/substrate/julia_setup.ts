// Managed Julia setup (#8): amicode owns the Julia it runs, via a juliaup
// channel pinned to the Manifest's MINOR (e.g. 1.12). The `1.12` channel tracks
// the latest 1.12 patch (1.12.6 as of writing) — a patch drift from the
// Manifest's pinned 1.12.3, which is fine: install.sh's long-standing policy is
// "minor must match, patch re-resolves." We never touch the user's global
// juliaup default — solves run through the channel's own binary, resolved here
// and handed to amico-run via its existing `--julia` plumbing.
//
// Pure helpers + command builders are unit-testable; the impure shell probes
// take an injectable runner (the healthcheck pattern).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Shape of a command to run in a visible integrated-terminal Task (the consent
 *  surface): the user sees exactly what executes. */
export interface JuliaSetupStep {
  label: string;
  /** A shell-ready command line (steps may pipe, e.g. the juliaup installer). */
  command: string;
}

/** Default absolute Julia project dir (matches resolveJuliaProject's default). */
export function defaultJuliaProject(): string {
  return path.join(os.homedir(), ".amico", "julia");
}

export const JULIA_SETUP_MARKER = ".amicode-instantiated";

/** Fingerprint the exact bundled project state that setup must instantiate. */
export function juliaProjectFingerprint(projectPath: string, manifestPath: string): string | null {
  try {
    return createHash("sha256")
      .update(fs.readFileSync(projectPath))
      .update("\0")
      .update(fs.readFileSync(manifestPath))
      .digest("hex");
  } catch {
    return null;
  }
}

/** Parse the pinned Julia MINOR (e.g. "1.12") from a Manifest.toml's
 *  `julia_version = "1.12.3"`. Returns null if unreadable/unparseable. */
export function pinnedJuliaMinor(manifestPath: string): string | null {
  try {
    const txt = fs.readFileSync(manifestPath, "utf8");
    const m = txt.match(/^julia_version\s*=\s*"(\d+)\.(\d+)\.\d+"/m);
    return m ? `${m[1]}.${m[2]}` : null;
  } catch {
    return null;
  }
}

/** Injectable command runner: returns stdout (trimmed), throws on non-zero. */
export type Runner = (cmd: string, args: string[]) => string;
const defaultRunner: Runner = (cmd, args) =>
  execFileSync(cmd, args, { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "ignore"] }).trim();

export interface JuliaupCommands {
  juliaup: string;
  julia: string;
}

/** Resolve juliaup and its sibling launcher from the same PATH entry. Bare
 *  `julia` is not sufficient: a standalone Julia may shadow juliaup's launcher. */
export function resolveJuliaupCommands(searchPath: string = process.env.PATH ?? ""): JuliaupCommands | null {
  const suffix = process.platform === "win32" ? ".exe" : "";
  for (const dir of searchPath.split(path.delimiter).filter(Boolean)) {
    const juliaup = path.join(dir, `juliaup${suffix}`);
    const julia = path.join(dir, `julia${suffix}`);
    if (fs.existsSync(juliaup) && fs.existsSync(julia)) return { juliaup, julia };
  }
  return null;
}

/** Canonical paths used immediately after Amicode installs juliaup. */
export function defaultJuliaupCommands(): JuliaupCommands {
  const suffix = process.platform === "win32" ? ".exe" : "";
  const bin = path.join(os.homedir(), ".juliaup", "bin");
  return {
    juliaup: path.join(bin, `juliaup${suffix}`),
    julia: path.join(bin, `julia${suffix}`),
  };
}

/** juliaup present on PATH? */
export function hasJuliaup(
  run: Runner = defaultRunner,
  commands: JuliaupCommands | null = resolveJuliaupCommands(),
): boolean {
  if (!commands) return false;
  try {
    run(commands.juliaup, ["--version"]);
    return true;
  } catch {
    return false;
  }
}

/** Is the `<minor>` channel installed + usable? Probes the channel shim rather
 *  than parsing `juliaup status` (whose table format is not stable across
 *  versions). `julia +1.12 --version` exits 0 only if the channel resolves. */
export function hasChannel(
  minor: string,
  run: Runner = defaultRunner,
  commands: JuliaupCommands | null = resolveJuliaupCommands(),
): boolean {
  if (!commands) return false;
  try {
    run(commands.julia, [`+${minor}`, "--startup-file=no", "--version"]);
    return true;
  } catch {
    return false;
  }
}

/** Resolve the channel's concrete julia binary (absolute), to hand to amico-run
 *  as `--julia` so solves use amicode's pinned Julia regardless of the user's
 *  global default. Returns null if the channel can't be resolved. */
export function resolveChannelJulia(
  minor: string,
  run: Runner = defaultRunner,
  commands: JuliaupCommands | null = resolveJuliaupCommands(),
): string | null {
  if (!commands) return null;
  try {
    const bindir = run(commands.julia, [`+${minor}`, "--startup-file=no", "-e", "print(Sys.BINDIR)"]);
    if (!bindir) return null;
    const exe = process.platform === "win32" ? "julia.exe" : "julia";
    const p = path.join(bindir, exe);
    return fs.existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

/** Did setup finish successfully for the exact bundled project state? The
 *  marker is written atomically only after Pkg.instantiate exits successfully.
 *  A copied Manifest alone is intentionally insufficient: setup may have been
 *  interrupted after copying files but before dependencies were installed. */
export function projectInstantiated(project: string, expectedFingerprint: string): boolean {
  try {
    return fs.readFileSync(path.join(project, JULIA_SETUP_MARKER), "utf8").trim() === expectedFingerprint;
  } catch {
    return false;
  }
}

/** First-run gate (mirrors shouldOfferVaultSetup): offer setup if anything in
 *  the chain is missing and the user hasn't dismissed. */
export function shouldOfferJuliaSetup(o: {
  juliaupPresent: boolean;
  channelPresent: boolean;
  projectInstantiated: boolean;
  dismissed: boolean;
}): boolean {
  return !o.dismissed && (!o.juliaupPresent || !o.channelPresent || !o.projectInstantiated);
}

/** The juliaup installer one-liner. Unix (linux-x64 + darwin-arm64, the vsix
 *  targets); `--yes` makes it non-interactive so it runs unattended in the Task
 *  after the user's explicit consent-click. */
export function juliaupInstallCommand(): string {
  return "curl -fsSL https://install.julialang.org | sh -s -- --yes";
}

/** Build the ordered, consented setup steps for the given state. Only the steps
 *  that are actually needed are emitted (idempotent + minimal). `project` is the
 *  Julia project dir; `manifestSrc`/`projectSrc` are the bundled pins to seed. */
export function buildSetupSteps(o: {
  minor: string;
  juliaupPresent: boolean;
  channelPresent: boolean;
  project: string;
  projectSrc: string;
  manifestSrc: string;
  projectFingerprint: string;
  juliaupCommands?: JuliaupCommands;
}): JuliaSetupStep[] {
  const steps: JuliaSetupStep[] = [];
  const commands = o.juliaupCommands ?? resolveJuliaupCommands() ?? defaultJuliaupCommands();
  const marker = path.join(o.project, JULIA_SETUP_MARKER);
  if (!o.juliaupPresent) {
    steps.push({ label: "Install juliaup", command: juliaupInstallCommand() });
  }
  if (!o.channelPresent) {
    // works whether juliaup was just installed (its shim is on PATH via the
    // installer's profile edit; the Task re-sources) or already present.
    steps.push({ label: `Add Julia ${o.minor}`, command: `"${commands.juliaup}" add ${o.minor}` });
  }
  // Seed the pinned project, then instantiate through the channel. Quote paths
  // for spaces. Instantiate is idempotent + safe to re-run.
  steps.push({
    label: "Instantiate Piccolo project",
    command:
      `mkdir -p "${o.project}" && ` +
      `cp "${o.projectSrc}" "${o.project}/Project.toml" && ` +
      `cp "${o.manifestSrc}" "${o.project}/Manifest.toml" && ` +
      `"${commands.julia}" +${o.minor} --project="${o.project}" -e 'using Pkg; Pkg.instantiate()' && ` +
      `printf '%s\\n' '${o.projectFingerprint}' > "${marker}.tmp" && ` +
      `mv "${marker}.tmp" "${marker}"`,
  });
  return steps;
}
