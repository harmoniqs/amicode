import * as fs from "node:fs";
import * as path from "node:path";

/** Where a run executed, for display. A run dir is the authority: `remote.json`
 *  (task_id + base_url) is written by RemoteExecutor and by nothing else, so its
 *  presence IS the cloud signal. Deliberately not a new run.toml field —
 *  run.schema.json is additionalProperties:false, which is why the remote
 *  executor put task_id in this sidecar in the first place. */
export function isCloudRun(runDir: string): boolean {
  try {
    return fs.existsSync(path.join(runDir, "remote.json"));
  } catch {
    return false;
  }
}
