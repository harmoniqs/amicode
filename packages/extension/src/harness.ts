// harness.ts — the adapter seam (ADR-0011, #659): harness selection lives in
// ONE place — a descriptor registry behind the server spawn. A descriptor
// resolves the launch binary and owns availability, capabilities, and the
// (future) entitlement requirement; the server manager itself is untouched —
// both built-in harnesses launch as `<binary> serve --port=N` with the same
// per-boot Basic-auth env mint, so the seam is binary resolution + gating,
// not a protocol change. Harness identity lives in settings and product copy,
// never in wire-protocol strings (the protocol blocklist rule).
//
// THE BYTE-IDENTITY GUARANTEE: with `amicode.harness` unset (the default, the
// opencode descriptor), resolution delegates to resolveOpencodeBinary with the
// same inputs — today's behavior, unchanged by construction.

import { resolveOpencodeBinary, OpencodeMissingError } from "./opencode_binary";

export type HarnessId = "opencode" | "telaio";

export interface HarnessAvailability {
  state: "ready" | "needs-setup";
  /** Honest detail for the picker: what it is, or what to do about it. */
  detail: string;
}

export interface HarnessDescriptor {
  id: HarnessId;
  displayName: string;
  /** Does this harness consume the opencode config-content env build
   *  (instructions merge, permissions, plugin path)? False = the spawn sites
   *  skip it (the harness authors its own config — ADR-0011's configAuthor). */
  consumesOpencodeConfig: boolean;
  /** Subscription gate — carried type-complete here; the read-side enforces
   *  it when it lands. Undefined = no entitlement required. */
  requiredEntitlement?: string;
  /** Honest availability for the picker, from the settings that matter. */
  availability(deps: { opencodeBinary: string; telaioBinary: string }): HarnessAvailability;
  /** Resolve the launch binary. Throws an actionable error when the harness
   *  is selected but unlaunchable (the caller surfaces it, boot-style). */
  resolveBinary(deps: { extensionPath: string; opencodeBinary: string; telaioBinary: string }): string;
}

const TELAIO_SETUP_DETAIL =
  "Requires the telaio harness binary. Build or install Telaio.jl's serve daemon, then set `amicode.telaioBinary` to its path. Sessions are harness-local — switching harnesses switches session history.";

export const opencodeDescriptor: HarnessDescriptor = {
  id: "opencode",
  displayName: "opencode (default)",
  consumesOpencodeConfig: true,
  availability(_deps): HarnessAvailability {
    return { state: "ready", detail: "The default harness — vendored binary, full amicode tool surface." };
  },
  resolveBinary(deps): string {
    // Delegation IS the byte-identity guarantee: the same resolver, the same
    // inputs, the same errors (OpencodeMissingError surfaces boot's toast).
    return resolveOpencodeBinary(deps.extensionPath, deps.opencodeBinary).path;
  },
};

export const telaioDescriptor: HarnessDescriptor = {
  id: "telaio",
  displayName: "telaio (subscription)",
  consumesOpencodeConfig: false,
  // The read-side lands with the entitlement work; the field is carried now
  // so gating is a one-line change, not a schema change.
  requiredEntitlement: "harness.telaio",
  availability(deps): HarnessAvailability {
    if (deps.telaioBinary.trim() !== "") {
      return { state: "ready", detail: "Serves the Harness Contract v1 surface. Sessions are harness-local." };
    }
    return { state: "needs-setup", detail: TELAIO_SETUP_DETAIL };
  },
  resolveBinary(deps): string {
    const bin = deps.telaioBinary.trim();
    if (bin === "") {
      throw new Error(
        "telaio harness selected but amicode.telaioBinary is empty — set it to the telaio binary path (see the select-harness picker for guidance)",
      );
    }
    return bin;
  },
};

/** The registry — insertion order is the picker's order. The default first. */
export const HARNESS_REGISTRY: readonly HarnessDescriptor[] = [opencodeDescriptor, telaioDescriptor];

export function resolveHarness(id: string): HarnessDescriptor | undefined {
  return HARNESS_REGISTRY.find((d) => d.id === id);
}

export interface SelectedLaunch {
  descriptor: HarnessDescriptor;
  binary: string;
  /** true = the selected harness couldn't launch and we fell back to the
   *  default (a hand-edited setting bypassing the picker's guidance). The
   *  caller logs the fallback — never silent. */
  fellBack: boolean;
}

/**
 * resolveSelectedLaunch — the ONE resolution the spawn sites call. Reads the
 * selected harness from settings-shaped inputs; an unlaunchable selection
 * (telaio without its binary) falls back to the opencode descriptor with
 * `fellBack: true` so the caller can warn honestly. The opencode descriptor's
 * resolution errors propagate (missing vendored binary is boot's toast path,
 * unchanged).
 */
export function resolveSelectedLaunch(deps: {
  harnessId: string;
  opencodeBinary: string;
  telaioBinary: string;
  extensionPath: string;
}): SelectedLaunch {
  // An unset setting ("") is the default, not a fallback — no warning. An
  // UNKNOWN id is a hand-edited setting: same warn-flagged fallback as an
  // unlaunchable selection — the default serves, the log says why.
  const requested = resolveHarness(deps.harnessId === "" ? "opencode" : deps.harnessId);
  const selected = requested ?? opencodeDescriptor;
  if (requested === undefined) {
    return {
      descriptor: opencodeDescriptor,
      binary: resolveOpencodeBinary(deps.extensionPath, deps.opencodeBinary).path,
      fellBack: true,
    };
  }
  if (selected.id !== "opencode" &&
      selected.availability({ opencodeBinary: deps.opencodeBinary, telaioBinary: deps.telaioBinary })
        .state === "needs-setup") {
    return {
      descriptor: opencodeDescriptor,
      binary: resolveOpencodeBinary(deps.extensionPath, deps.opencodeBinary).path,
      fellBack: true,
    };
  }
  return { descriptor: selected, binary: selected.resolveBinary(deps), fellBack: false };
}

export { OpencodeMissingError };
