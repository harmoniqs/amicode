// test/setup_hermetic_env.ts — vitest per-file setup (harmoniqs/amicode).
//
// Neutralize ambient dev-shell environment so `pnpm --filter amicode test`
// behaves like CI's CLEAN environment, regardless of the developer's shell.
//
// The Amicode integrated terminal (and any shell spawned from a live Amicode /
// opencode session) exports operational env vars — AMICODE_SERVICE_AUTH=open,
// AMICO_FLEET_MULTIPLEX=1, AMICODE_ENGINE_UNARMED=1, AMICODE_SERVICE_PORT,
// AMICODE_APP_DIST, OPENCODE_DB, OPENCODE_CONFIG_CONTENT, … — that the extension
// unit tests do NOT expect: they flip the service's auth mode (open ⇒ anonymous
// requests are served, so the auth tests' 401 assertions see 200), the fleet
// data-plane routing (the single-pointer e2e is diverted into the empty-owner-map
// multiplexer ⇒ local ⇒ 503), the app-shelf boot shape, and the terminal env
// injection. CI has none of these set, so the suite is green there and red only
// on a developer's machine. That divergence is the bug this setup closes.
//
// Contract: snapshot + delete every AMICO*/AMICODE*/OPENCODE* var at file load
// (before any test or beforeAll runs), and restore on teardown. A test that
// needs a specific value sets it explicitly in its own beforeAll/beforeEach,
// which runs AFTER this and therefore wins — hermetic by construction, never a
// muzzle on a test that legitimately drives one of these vars.
import { afterAll } from "vitest";

const CLEAR_PREFIXES = ["AMICODE_", "AMICO_", "OPENCODE_"];
const CLEAR_EXACT = new Set(["OPENCODE"]);

const saved: Record<string, string | undefined> = {};
for (const key of Object.keys(process.env)) {
  if (CLEAR_EXACT.has(key) || CLEAR_PREFIXES.some((p) => key.startsWith(p))) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
}

// Per-file workers exit after the file, so restoration is belt-and-suspenders;
// it keeps the invariant honest if a future pool reuses a worker across files.
afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
