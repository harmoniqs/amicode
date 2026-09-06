// FLEET STAGING (amicissimo#391 — the local-shell data plane, Slice A): the
// transport-side composition of the #394 resolver's dispatch
// (amicissimo/fleet_overlay/staging.py) — the entitlement gate the fleet
// mode may NEVER bypass.
//
// The dispatch invariants, mechanically mirrored:
//
// - **Without the entitlement: zero fleet surfaces.** The overlay source is
//   never even READ (the resolver's own rule — "no overlay is even loaded");
//   the receipt records entitlement:"absent" and staging lights nothing.
//   This is what makes the H3 byte-identity assertion structural, not
//   aspirational: no entitlement → nothing armed → client bytes identical
//   to the base service.
// - **With the entitlement, the fleet surfaces stage ONLY through a lawful
//   declaration**: the shipped data-plane overlay manifest
//   (fleet_overlay/overlays/fleet-data-plane.json in the amicissimo source
//   the mode-card overlay ladder resolves) must declare the
//   `data-plane-routing` surface under the freeze validator's fleet classes
//   ("data-plane routing"). ADR-0004 decision 3: staging merges, never
//   shadows; provenance stamps the base the overlay composes; an overlay
//   whose base stamp differs from the vendored pin carries a named skew
//   note (its fields were re-validated against the installed base by the
//   freeze validator amicissimo-side; this module enforces the envelope).
// - **Absence and rejection are NAMED, never silent, never a dead end**:
//   a missing overlay source / manifest, a malformed manifest, or a
//   manifest that declares no data-plane surface each stage NOTHING (base
//   stays complete) with the reason in the receipt.
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { readLocalEntitlements } from "../scores/entitlements";
import { PREMIUM_ENTITLEMENT, resolveOverlaySource } from "../mode_cards";

/** The transport's fleet-class surface id — the one the manifest must
 *  declare for the routing mode to arm. */
export const FLEET_DATA_PLANE_SURFACE_ID = "data-plane-routing";
/** The freeze validator's fleet class this surface declares (ADR-0004 d.3). */
export const FLEET_DATA_PLANE_CLASS = "data-plane routing";
/** The vendored base this transport composes (the #840 cutover pin). */
export const VENDORED_BASE_VERSION = "v1.18.29";
/** The overlay manifest's location under the resolved amicissimo source. */
export const FLEET_DATA_PLANE_MANIFEST_REL = join("fleet_overlay", "overlays", "fleet-data-plane.json");

export const FLEET_RECEIPT_VERSION = 1;

export type FleetStagingAbsenceReason =
  | "overlay-source-absent"
  | "manifest-absent"
  | "manifest-invalid"
  | "surface-not-declared";

export interface FleetStagingRejection {
  overlay_id: string;
  reason: string;
}

export interface FleetStagingReceipt {
  receipt_version: typeof FLEET_RECEIPT_VERSION;
  staged_at: string;
  entitlement: "present" | "absent";
  staged: boolean;
  /** Provenance (ADR-0003 decision 7): which overlay staged, against which
   *  base stamp — merge-record metadata, never a merged field. */
  overlay_id?: string;
  overlay_base_version?: string;
  /** Named skew: the overlay stamps a different base than the vendored pin. */
  skew?: string;
  rejections: FleetStagingRejection[];
  /** Why the fleet surfaces did not stage despite the entitlement — the
   *  honest-setup pointer (never a silent no-op). */
  absence_reason?: FleetStagingAbsenceReason;
}

export interface FleetStagingResult {
  staged: boolean;
  receipt: FleetStagingReceipt;
}

export interface StageFleetDataPlaneOptions {
  /** Resolved entitlement codes; null resolves the machine's real set
   *  (the mode-cards StageOptions semantics). */
  entitlements?: string[] | null;
  /** Directory holding entitlements.toml (default ~/.amico/amicode). */
  entitlementConfigDir?: string;
  /** Explicit overlay source root; null/undefined walks the resolution
   *  ladder (AMICO_OVERLAY_SOURCE → AMICISSIMO_ROOT → the known checkout). */
  overlaySource?: string | null;
  /** Clock injection (receipt timestamps); default real time. */
  now?: () => string;
}

function emptyReceipt(entitlement: "present" | "absent", staged: boolean, now: string): FleetStagingReceipt {
  return { receipt_version: FLEET_RECEIPT_VERSION, staged_at: now, entitlement, staged, rejections: [] };
}

/**
 * Stage the transport's fleet surfaces — the D1 routing mode, the D2 merged
 * projection, and the D5 hub credential are armed by the CALLER exactly when
 * this returns staged:true. Never throws: every failure collapses into a
 * not-staged result with a named reason (staging never dead-ends activation).
 */
export function stageFleetDataPlane(opts: StageFleetDataPlaneOptions = {}): FleetStagingResult {
  const nowIso = opts.now ?? (() => new Date().toISOString());

  // The entitlement gate FIRST — the resolver's rule is that without the
  // entitlement the overlay is never even loaded. No fs reads below this
  // point until the gate passes.
  const configDir = opts.entitlementConfigDir ?? join(homedir(), ".amico", "amicode");
  const entitlements = opts.entitlements ?? readLocalEntitlements(configDir).entitlements;
  const entitled = entitlements.includes(PREMIUM_ENTITLEMENT);
  if (!entitled) {
    return { staged: false, receipt: emptyReceipt("absent", false, nowIso()) };
  }

  const receipt = emptyReceipt("present", false, nowIso());

  // Overlay source ladder (the mode-cards precedent): explicit config → env
  // overrides → known checkout location. Absent source = named absence.
  const source = resolveOverlaySource(opts.overlaySource);
  if (!source || !existsSync(source)) {
    receipt.absence_reason = "overlay-source-absent";
    return { staged: false, receipt };
  }

  const manifestPath = join(source, FLEET_DATA_PLANE_MANIFEST_REL);
  if (!existsSync(manifestPath)) {
    receipt.absence_reason = "manifest-absent";
    return { staged: false, receipt };
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (e) {
    receipt.rejections.push({
      overlay_id: FLEET_DATA_PLANE_MANIFEST_REL,
      reason: `malformed overlay manifest: ${e instanceof Error ? e.message : String(e)}`,
    });
    receipt.absence_reason = "manifest-invalid";
    return { staged: false, receipt };
  }

  // The envelope the freeze validator enforces amicissimo-side, mirrored
  // here so a manifest that could not pass it never arms transport surfaces.
  if (typeof manifest !== "object" || manifest === null) {
    receipt.rejections.push({ overlay_id: "<unnamed>", reason: "overlay manifest is not a JSON object" });
    receipt.absence_reason = "manifest-invalid";
    return { staged: false, receipt };
  }
  const m = manifest as Record<string, unknown>;
  const overlayId = typeof m.overlay_id === "string" && m.overlay_id !== "" ? m.overlay_id : null;
  const overlayBaseVersion = typeof m.base_version === "string" && m.base_version !== "" ? m.base_version : null;
  if (overlayId === null || overlayBaseVersion === null || m.overlay_version !== 1) {
    receipt.rejections.push({
      overlay_id: overlayId ?? "<unnamed>",
      reason: "overlay envelope incomplete (overlay_id / overlay_version=1 / base_version stamp)",
    });
    receipt.absence_reason = "manifest-invalid";
    return { staged: false, receipt };
  }

  const surfaces = Array.isArray(m.surfaces) ? m.surfaces : [];
  const dataPlane = surfaces.find(
    (s): s is Record<string, unknown> =>
      typeof s === "object" &&
      s !== null &&
      (s as Record<string, unknown>).surface_id === FLEET_DATA_PLANE_SURFACE_ID &&
      (s as Record<string, unknown>).fleet_class === FLEET_DATA_PLANE_CLASS,
  );
  if (!dataPlane) {
    receipt.rejections.push({
      overlay_id: overlayId,
      reason: `manifest declares no ${FLEET_DATA_PLANE_SURFACE_ID} surface under the ${FLEET_DATA_PLANE_CLASS!} fleet class`,
    });
    receipt.absence_reason = "surface-not-declared";
    return { staged: false, receipt };
  }

  // Provenance: which overlay staged, against which base stamp — and the
  // named skew note when the overlay's stamp differs from the vendored pin.
  receipt.overlay_id = overlayId;
  receipt.overlay_base_version = overlayBaseVersion;
  if (overlayBaseVersion !== VENDORED_BASE_VERSION) {
    receipt.skew =
      `overlay stamped base ${overlayBaseVersion}, vendored base ${VENDORED_BASE_VERSION} — ` +
      "fields re-validated against the installed base by the freeze validator at staging";
  }
  receipt.staged = true;
  return { staged: true, receipt };
}

/** Convenience for logging/boot lines: a one-line staging summary. */
export function fleetStagingSummary(result: FleetStagingResult): string {
  if (result.receipt.entitlement === "absent") return "fleet staging: entitlement absent — zero fleet surfaces";
  if (!result.staged) {
    const why = result.receipt.absence_reason ?? result.receipt.rejections[0]?.reason ?? "unknown";
    return `fleet staging: not staged (${why}) — base complete`;
  }
  const parts = [
    `fleet staging: staged via ${result.receipt.overlay_id}`,
    `base ${result.receipt.overlay_base_version}`,
  ];
  if (result.receipt.skew) parts.push("(skew noted)");
  return parts.join(" ");
}

/** Used by tests to pin that the receipt is content-addressable metadata —
 *  provenance never rides a merged field. */
export function receiptFingerprint(receipt: FleetStagingReceipt): string {
  return createHash("sha256").update(JSON.stringify(receipt)).digest("hex");
}
