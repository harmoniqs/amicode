// The distill live smoke (amicode #1680, brain flywheel slice 1) — the ONE
// non-hermetic distill test, mirroring the notturno parity discipline: run
// the real verb against the REAL chat DB (read-only — the verb never writes a
// byte to the store) with the REAL jev key, distilling real substantive
// sessions into a TEMP candidate area + TEMP state stamp + TEMP dashboards
// journal — never the live vault, never the live ops dir.
//
// Gate (the remote_live_smoke pattern): AMICO_DISTILL_SMOKE=1 AND the real
// chat DB AND the real jev key present. CI (github-hosted) has neither → the
// suite skips honestly; the fleet server (the nightly job's home surface)
// runs it real:
//   AMICO_DISTILL_SMOKE=1 pnpm --filter @amicode/amico-run test:slow distill
import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import { distillVerb } from "../../src/distill_verb.js";
import { jevKeyFile } from "../../src/jev_client.js";
import type { DistillStamp } from "../../src/distill.js";

const realDb = join(homedir(), ".local", "share", "opencode", "opencode.db");
const gated = process.env.AMICO_DISTILL_SMOKE === "1" && existsSync(realDb) && existsSync(jevKeyFile());

describe.skipIf(!gated)("distill live smoke — the real chat DB, the real jev key", () => {
  it(
    "distills real substantive sessions into a temp candidate area; every evidence pointer resolves against the real DB",
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), "amico-distill-smoke-"));
      try {
        const candidates = join(tmp, "claims", "candidates");
        const state = join(tmp, "distill-state.json");
        const dashboards = join(tmp, "dashboards");
        // a fixture registry with the distill job registered (the amicissimo
        // registry itself is deny-listed instance data — the real nightly job
        // composes its receipt through the private runner; this smoke uses a
        // public one so the receipt path runs for real)
        const registry = join(tmp, "registry.toml");
        writeFileSync(
          registry,
          [
            "[job.distill]",
            'workflow = "notturno-distill.yml"',
            'cadence  = "0 4 * * *"',
            'surface  = "mini"',
            'warrant  = "stage"',
            'delivers = ["vault-commit"]',
            'record   = "always"',
            "enabled  = true",
            "",
          ].join("\n"),
        );

        // --limit 3: the three most-recent eligible substantive sessions
        // (the newest first worklist). Real sessions, real Jev Choices.
        const r = await distillVerb(
          ["--db", realDb, "--apply", "--candidates", candidates, "--state", state, "--limit", "3", "--registry", registry, "--dashboards", dashboards],
          { ...process.env },
        );
        expect(r.code).toBe(0);
        const json = r.json as Record<string, unknown>;
        expect(json.status).toBe("ran");
        expect(json.dry_run).toBe(false);
        expect(json.consulted).toBeGreaterThan(0);
        expect(json.substantive).toBeGreaterThan(0);
        expect((json as { junk: number }).junk).toBeGreaterThanOrEqual(0);

        // at least one real substantive session distilled through the real
        // middle layer — the artery moved real blood
        expect(json.distilled).toBeGreaterThanOrEqual(1);

        // every emitted note resolves into the real substrate (AC: evidence
        // pointers must resolve — checked against the REAL DB, read-only)
        const notes = (json.notes as string[]) ?? [];
        const messageIds: string[] = [];
        const sessionIds: string[] = [];
        for (const notePath of notes) {
          const raw = readFileSync(notePath, "utf8");
          expect(raw.startsWith("---\n")).toBe(true);
          const fm = parseYaml(raw.split("\n---")[0]!.replace(/^---\n/, "")) as Record<string, unknown>;
          expect(fm.type).toBe("claim-candidate");
          expect(fm.distill_job).toBe("distill");
          expect(String(fm.source_db)).toBe(realDb);
          for (const p of fm.evidence as string[]) {
            if (p.startsWith("chat-session/")) sessionIds.push(p.slice("chat-session/".length));
            if (p.startsWith("chat-message/")) messageIds.push(p.slice("chat-message/".length));
          }
        }
        if (sessionIds.length + messageIds.length > 0) {
          const probe = execFileSync(
            process.env.AMICO_PYTHON && process.env.AMICO_PYTHON.trim() !== "" ? process.env.AMICO_PYTHON : "python3",
            [
              "-c",
              `
import json, sqlite3, sys
con = sqlite3.connect("file:" + sys.argv[1] + "?mode=ro", uri=True, timeout=5)
sessions = [s for s in sys.argv[2].split(",") if s and con.execute("SELECT 1 FROM session WHERE id = ?", (s,)).fetchone()]
messages = [m for m in sys.argv[3].split(",") if m and con.execute("SELECT 1 FROM message WHERE id = ?", (m,)).fetchone()]
print(json.dumps({"sessions": sessions, "messages": messages}))
          `,
              realDb,
              sessionIds.join(","),
              messageIds.join(","),
            ],
            { encoding: "utf8" },
          );
          const resolved = JSON.parse(probe) as { sessions: string[]; messages: string[] };
          expect(resolved.sessions.sort()).toEqual([...new Set(sessionIds)].sort());
          expect(resolved.messages.sort()).toEqual([...new Set(messageIds)].sort());
        }

        // the receipt filed for real: job name, counts, duration in the journal
        expect((json.receipt as Record<string, unknown>).filed).toBe(true);
        const journal = readFileSync(join(dashboards, "scheduled-passes.md"), "utf8");
        expect(journal).toMatch(/## Pass \d{4}-\d{2}-\d{2} — distill — ok/);
        expect(journal).toMatch(/- duration: \d+s/);

        // the state stamp makes a re-run a no-op for an already-distilled
        // session (the backlog's next sessions are DIFFERENT work — so prove
        // the no-op against a session the first run actually stamped)
        const stamp = JSON.parse(readFileSync(state, "utf8")) as { entries: Record<string, DistillStamp> };
        const stampedIds = Object.keys(stamp.entries);
        expect(stampedIds.length).toBeGreaterThanOrEqual(1);
        const second = await distillVerb(
          ["--db", realDb, "--apply", "--candidates", candidates, "--state", state, "--session", stampedIds[0]!],
          { ...process.env },
        );
        expect(second.code).toBe(0);
        expect(second.json).toMatchObject({ consulted: 0, distilled: 0, already_distilled: 1 });
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
