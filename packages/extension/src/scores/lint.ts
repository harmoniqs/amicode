import * as fs from "node:fs";
import * as path from "node:path";
import { RepertoireLoad } from "./loader";

// Repertoire-wide contract lint — spec §3. Entity/gate/version/schema_version rules are
// already enforced by validateScoreManifest at load time; this covers the cross-file rules.
export function lintRepertoire(load: RepertoireLoad, memoryRoot: string, knownEntitlements: string[]): string[] {
  const errs: string[] = [];
  for (const e of load.errors) errs.push(`${e.path}: ${e.errors.join("; ")}`);
  const ids = new Set(load.scores.map((s) => s.manifest.id));
  for (const score of load.scores) {
    const label = score.manifest.id;
    for (const stage of score.manifest.stages) {
      if (stage.template && !fs.existsSync(path.join(score.dir, stage.template)))
        errs.push(`${label}: stage ${stage.id}: template does not resolve: ${stage.template}`);
      for (const q of stage.questions ?? [])
        for (const hook of q.memory_hooks ?? [])
          if (!fs.existsSync(path.join(memoryRoot, `${hook}.md`)))
            errs.push(`${label}: stage ${stage.id}: question ${q.id}: memory hook does not resolve: ${hook}`);
    }
    const from = score.manifest.derived_from;
    if (from && !ids.has(from)) errs.push(`${label}: derived_from names an unknown score id: ${from}`);
    for (const ent of score.manifest.entitlements ?? [])
      if (!knownEntitlements.includes(ent)) errs.push(`${label}: unregistered entitlement id: ${ent}`);
  }
  return errs;
}
