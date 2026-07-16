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

/** juliaup present on PATH? */
export function hasJuliaup(run: Runner = defaultRunner): boolean {
  try {
    run("juliaup", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

/** Is the `<minor>` channel installed + usable? Probes the channel shim rather
 *  than parsing `juliaup status` (whose table format is not stable across
 *  versions). `julia +1.12 --version` exits 0 only if the channel resolves. */
export function hasChannel(minor: string, run: Runner = defaultRunner): boolean {
  try {
    run("julia", [`+${minor}`, "--startup-file=no", "--version"]);
    return true;
  } catch {
    return false;
  }
}

/** Resolve the channel's concrete julia binary (absolute), to hand to amico-run
 *  as `--julia` so solves use amicode's pinned Julia regardless of the user's
 *  global default. Returns null if the channel can't be resolved. */
export function resolveChannelJulia(minor: string, run: Runner = defaultRunner): string | null {
  try {
    const bindir = run("julia", [`+${minor}`, "--startup-file=no", "-e", "print(Sys.BINDIR)"]);
    if (!bindir) return null;
    const exe = process.platform === "win32" ? "julia.exe" : "julia";
    const p = path.join(bindir, exe);
    return fs.existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

/** Has the pinned project been instantiated? Cheap gate check (existence of the
 *  copied Manifest); full "using Piccolo loads" verification stays in
 *  healthcheck. The setup Task re-runs instantiate idempotently regardless. */
export function projectInstantiated(project: string = defaultJuliaProject()): boolean {
  return fs.existsSync(path.join(project, "Manifest.toml"));
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
}): JuliaSetupStep[] {
  const steps: JuliaSetupStep[] = [];
  if (!o.juliaupPresent) {
    steps.push({ label: "Install juliaup", command: juliaupInstallCommand() });
  }
  if (!o.channelPresent) {
    // works whether juliaup was just installed (its shim is on PATH via the
    // installer's profile edit; the Task re-sources) or already present.
    steps.push({ label: `Add Julia ${o.minor}`, command: `juliaup add ${o.minor}` });
  }
  // Seed the pinned project, then instantiate through the channel. Quote paths
  // for spaces. Instantiate is idempotent + safe to re-run.
  steps.push({
    label: "Instantiate Piccolo project",
    command:
      `mkdir -p "${o.project}" && ` +
      `cp "${o.projectSrc}" "${o.project}/Project.toml" && ` +
      `cp "${o.manifestSrc}" "${o.project}/Manifest.toml" && ` +
      `julia +${o.minor} --project="${o.project}" -e 'using Pkg; Pkg.instantiate()'`,
  });
  return steps;
}
