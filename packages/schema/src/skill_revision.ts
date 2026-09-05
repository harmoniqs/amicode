// skill_revision.ts — the typed revision contract for the public workflow
// skills (spec-20260905-063000 D2, issue #807). The five dev-workflow skills
// (director-core, develop, implement-issue, write-an-issue,
// break-into-subissues) ship as in-repo CANONICAL copies with frontmatter
// `source` + `revision` (a monotonic integer; a missing revision reads as 0).
// Staging selection is typed, not vibes:
//
//   - equal revisions → the in-repo canonical copy wins;
//   - a STRICTLY NEWER vault revision supersedes — but only after validation;
//   - a superseding revision is validated against the CONSUMER FLOOR (a copy
//     may declare `consumer_floor:` — the skill-stager contract version it
//     requires; a build below it must not stage content it cannot interpret)
//     AND the GENERATED-REGION PARITY (the canonical copy's AMICO-GENERATED
//     regions must classify ok in the superseding copy too) BEFORE it
//     supersedes;
//   - a mismatch on either DECLINES to canonical with disclosure — a
//     generated-region mismatch reads a NAMED generator-mismatch failure,
//     never a staged divergent discovery rule.
//
// Precedence of record, stated once: canonical wins at equal revision; a
// newer vault revision wins for what stages; the in-repo copy remains what
// the vsix ships and the tests pin.
//
// This module lives beside the registry's generated-region machinery
// (mode_registry.ts) and shares it: classifyLedgerDiscoveryRegion is the one
// region validator, imported here and by the extension's skill resolver.
import {
  compareModeVersions,
  classifyLedgerDiscoveryRegion,
  LEDGER_DISCOVERY_RULE_REGION_NAME,
  MODE_GENERATOR_VERSION,
} from "./mode_registry.js";

/** The skill-stager contract version THIS build's consumers support. A
 *  superseding vault copy whose `consumer_floor` exceeds it declines to
 *  canonical with a named version-gap (mirrors the mode bundles'
 *  checkConsumerFloor, one consumer kind: the skill stager). */
export const SUPPORTED_SKILL_CONTRACT_VERSION = "1";

/** A superseding revision may carry frontmatter a future contract defines;
 *  this build knows the ledger-discovery-rule region only. An unknown
 *  generated region in a superseding copy is a generator-mismatch decline —
 *  never stage a generated region this build's generator cannot verify. */
export const KNOWN_GENERATED_REGIONS = [LEDGER_DISCOVERY_RULE_REGION_NAME];

export interface SkillRevisionFrontmatter {
  /** The copy's revision; a missing or malformed value reads as 0. */
  revision: number;
  /** The consumer-floor this copy requires (a version string); absent → "0". */
  consumer_floor: string;
  /** The copy's declared source label; absent → null. */
  source: string | null;
}

/** Extract the frontmatter block (the leading `---` fence) from a SKILL.md. */
function frontmatterBlock(text: string): string {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  return m?.[1] ?? "";
}

function frontmatterValue(fm: string, key: string): string | null {
  const m = fm.match(new RegExp(`^${key}:\\s*(.*?)\\s*$`, "m"));
  if (m === null || m[1] === undefined || m[1] === "") return null;
  return m[1].replace(/^["']|["']$/g, "");
}

/** Parse a SKILL.md's revision frontmatter: `revision` (monotonic integer,
 *  missing = 0 per D2; a malformed value is a defective copy and reads as 0 —
 *  the resolver's skip+warn philosophy, never a throw), `consumer_floor`
 *  (version string, absent = "0"), `source` (label, absent = null). */
export function parseSkillRevisionFrontmatter(text: string): SkillRevisionFrontmatter {
  const fm = frontmatterBlock(text);
  const rawRevision = frontmatterValue(fm, "revision");
  let revision = 0;
  if (rawRevision !== null && /^\d+$/.test(rawRevision)) revision = Number(rawRevision);
  const floor = frontmatterValue(fm, "consumer_floor") ?? "0";
  const source = frontmatterValue(fm, "source");
  return { revision, consumer_floor: floor, source };
}

export type SupersedingSkillDeclineKind = "version-gap" | "generator-mismatch";

export interface SupersedingSkillRevisionCheck {
  /** True iff the superseding copy may stage over the canonical one. */
  ok: boolean;
  /** The NAMED failure kind on a decline (the disclosure names it). */
  kind?: SupersedingSkillDeclineKind;
  /** One-line human reason — the disclosure, never a pass authorization. */
  detail: string;
}

/** Validate a STRICTLY NEWER superseding copy BEFORE it supersedes: the
 *  consumer floor AND generated-region parity, both ahead of the stage. A
 *  mismatch on either declines to canonical; a generated-region mismatch
 *  reads a named generator-mismatch failure. */
export function validateSupersedingSkillRevision(
  canonicalText: string,
  supersedingText: string,
  consumerVersion: string = SUPPORTED_SKILL_CONTRACT_VERSION,
): SupersedingSkillRevisionCheck {
  const fm = parseSkillRevisionFrontmatter(supersedingText);
  // (1) the consumer floor: this build's skill-stager contract must meet the
  // copy's declared floor, else it cannot honestly interpret the copy.
  if (compareModeVersions(consumerVersion, fm.consumer_floor) < 0) {
    return {
      ok: false,
      kind: "version-gap",
      detail: `version-gap: superseding revision ${fm.revision} requires skill-stager contract ≥ ${fm.consumer_floor}; this build supports ${consumerVersion} — declined to canonical with disclosure`,
    };
  }
  // (2) generated-region parity. The canonical copy's regions must classify ok
  // in the superseding copy too (regenerate-and-compare, the same detection
  // the mode bundles use); a region present-but-bad, or absent where the
  // canonical carries one, is a NAMED generator-mismatch.
  const canon = classifyLedgerDiscoveryRegion(canonicalText);
  const over = classifyLedgerDiscoveryRegion(supersedingText);
  if (canon.status === "ok" && over.status !== "ok") {
    return {
      ok: false,
      kind: "generator-mismatch",
      detail: `generator-mismatch: the canonical copy carries the ledger-discovery-rule region (generator ${MODE_GENERATOR_VERSION}) but the superseding revision ${fm.revision} carries a ${over.status} region — ${over.detail}`,
    };
  }
  if (over.status === "outdated-stamp" || over.status === "divergent") {
    return {
      ok: false,
      kind: "generator-mismatch",
      detail: `generator-mismatch: the superseding revision ${fm.revision} carries a ${over.status} ledger-discovery-rule region — ${over.detail}`,
    };
  }
  // (3) unknown generated regions: a copy carrying a region this build's
  // generator does not know can never be verified here — decline, named.
  const regionRe = /AMICO-GENERATED: region=(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = regionRe.exec(supersedingText)) !== null) {
    if (!KNOWN_GENERATED_REGIONS.includes(m[1]!)) {
      return {
        ok: false,
        kind: "generator-mismatch",
        detail: `generator-mismatch: the superseding revision ${fm.revision} carries a generated region "${m[1]}" this build's generator cannot verify (known: ${KNOWN_GENERATED_REGIONS.join(", ")})`,
      };
    }
  }
  return { ok: true, detail: `superseding revision ${fm.revision} passes the consumer floor (${consumerVersion}) and generated-region parity` };
}
