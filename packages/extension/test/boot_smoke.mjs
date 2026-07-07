#!/usr/bin/env node
// β.2 boot-smoke gate (spec §5): the VENDORED opencode binary must serve
// GET /event as an SSE stream (HTTP 200, text/event-stream) against a
// synthesized project, with no LLM creds. Exit 0 = pass.
//
// SCOPE (see #25): this is the binary-liveness gate only — it deliberately does
// NOT set OPENCODE_CONFIG_CONTENT, so it can't (and doesn't claim to) catch a
// regression in the instructions/permission injection or the config merge. That
// injection + merge is asserted against the REAL binary + the REAL
// buildOpencodeConfigContent in test/opencode_config.test.ts ("opencode config
// injection + merge"), which can import the TS builder (this .mjs can't, so
// re-deriving the config here would just risk drift).
//
// Boot + probe logic lives in scripts/opencode_probe.mjs (shared with the
// healthcheck, which derives BOTH the /event gate and the provider signal from a
// single boot); this script asserts the /event gate and exits.
import { bootOpencodeAndProbe, vendoredOpencodeBin } from "../scripts/opencode_probe.mjs";

const fail = (msg, code = 1) => {
  console.error(`[smoke] FAIL: ${msg}`);
  process.exit(code);
};

const boot = await bootOpencodeAndProbe({ timeoutMs: 30_000 });
if (boot.binMissing)
  fail(`vendored binary missing at ${vendoredOpencodeBin()} — run \`pnpm --filter amicode-v2 fetch:opencode\``, 10);
if (!boot.up) fail(`server not up within 30s\n--- server output ---\n${boot.log}`);
console.log(`[smoke] GET /event → ${boot.eventStatus} (${boot.eventCtype})`);
if (boot.eventStatus !== 200) fail(`/event status ${boot.eventStatus}, want 200\n--- server output ---\n${boot.log}`);
if (!(boot.eventCtype ?? "").includes("text/event-stream"))
  fail(`/event content-type "${boot.eventCtype}", want text/event-stream`);
console.log("[smoke] PASS");
process.exit(0);
