// packages/amico-run/test/slow/remote_live_smoke.test.ts
// ⛔ SKIP-UNTIL-DEPLOYED — the ONLY non-hermetic Δ8 test. Gate:
//   aws-infra#166 + aws-infra#167 merged, Δ4 deployed on STAGING, then run:
//   AMICO_CLOUD_SMOKE=1 AMICO_CLOUD_URL=<staging> AMICO_CLOUD_TOKEN=<cred> \
//     pnpm exec vitest run test/slow/remote_live_smoke.test.ts
// Purpose: validate the SHAPE-ONLY assumptions the fakes encode (frames
// response encoding, liveness field values, abort route) against the real
// service. Any mismatch → fix FakeCloud first, then the client, keeping the
// hermetic suite the source of truth.
import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteExecutor } from "../../src/remote_executor.js";

const gated =
  process.env.AMICO_CLOUD_SMOKE === "1" && !!process.env.AMICO_CLOUD_URL && !!process.env.AMICO_CLOUD_TOKEN;

describe.skipIf(!gated)("remote live smoke — STAGING", () => {
  it(
    "submits a trivial script, polls to a REAL terminal, mirror conforms",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "smoke-"));
      const script = join(root, "smoke.jl");
      writeFileSync(script, 'println("AMICODE_ITER iter=1 f=1.0e-3 inf_pr=1e-9 inf_du=1e-7")\n');
      const h = await new RemoteExecutor({ pollMs: 5000 }).submit(script, { runsRoot: join(root, "runs") });
      const fin = await h.finished; // staging wall time: minutes (cold EC2), not ms
      expect(["completed", "failed"]).toContain(fin.status); // a real terminal — never a hang
      expect(existsSync(join(h.runDir, "FINISHED"))).toBe(true);
      expect(existsSync(join(h.runDir, "remote.json"))).toBe(true);
    },
    20 * 60 * 1000, // 20-min vitest timeout: covers the 15-min warming budget
  );
});
