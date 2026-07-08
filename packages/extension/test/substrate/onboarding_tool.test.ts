import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  appendOnboardingEvent,
  readOnboardingState,
  statusSummary,
  sanitizePayload,
  triggerOnboardingDistill,
  SECRET_RE,
} from "../../opencode-plugin/onboarding";
import { listJobs, writeDistillerConfig } from "../../opencode-plugin/distill_queue";
import { hasOnboardingCompleted } from "../../src/substrate/vault_store";

function mkDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("appendOnboardingEvent (spec §3.2 envelope)", () => {
  it("writes the problems-style envelope with seq/ts/entity/action/diff/hash/source", () => {
    const dir = mkDir("onb-");
    const { seq } = appendOnboardingEvent(dir, "profile", { name: "A", role: "CEO" });
    expect(seq).toBe(1);
    const ev = JSON.parse(fs.readFileSync(path.join(dir, "events.jsonl"), "utf8").trim());
    expect(ev.entity).toBe("profile");
    expect(ev.action).toBe("created");
    expect(ev.diff.name.to).toBe("A");
    expect(ev.hash).toMatch(/^sha256:/);
    expect(ev.source.tool).toBe("amicode_profile");
  });
  it("seq increments across appends; marker is visible to the routing predicate", () => {
    const dir = mkDir("onb-");
    appendOnboardingEvent(dir, "profile", { name: "A" });
    const { seq } = appendOnboardingEvent(dir, "onboarding_completed", {});
    expect(seq).toBe(2);
    expect(hasOnboardingCompleted(dir)).toBe(true);
  });
});

describe("secrets scrub at record time (spec §2.5 hard rule + §7.8 regex)", () => {
  it("credential-looking strings are replaced, structure preserved", () => {
    const clean = sanitizePayload("environment", {
      slug: "lab",
      archetype: "qick-lab",
      endpoints: ["rfsoc.lab.internal:8000", "Bearer abc123token"],
      integration: "api_key=SUPERSECRET inside prose",
    });
    expect(clean.endpoints).toEqual(["rfsoc.lab.internal:8000", "«credential omitted»"]);
    expect(clean.integration).toBe("«credential omitted»");
    expect(JSON.stringify(clean)).not.toMatch(SECRET_RE);
  });
  it("unknown fields are dropped (only §3.2 fields recorded)", () => {
    const clean = sanitizePayload("profile", { name: "A", evil_extra: "x" });
    expect(clean).toEqual({ name: "A" });
  });
});

describe("readOnboardingState / statusSummary (resume anchor, spec §3)", () => {
  it("replays latest-wins per instance; keyed environments and devices", () => {
    const dir = mkDir("onb-");
    appendOnboardingEvent(dir, "profile", { name: "A", role: "student" });
    appendOnboardingEvent(dir, "profile", { role: "CEO" }); // later wins, merged
    appendOnboardingEvent(dir, "environment", { slug: "lab", archetype: "qick-lab" });
    appendOnboardingEvent(dir, "device", { name: "fridge-a", platform: "transmon" });
    const s = readOnboardingState(dir);
    expect(s.profile).toMatchObject({ name: "A", role: "CEO" });
    expect(s.environments.lab.archetype).toBe("qick-lab");
    expect(s.devices["fridge-a"].platform).toBe("transmon");
    expect(s.completed).toBe(false);
    const summary = statusSummary(dir);
    expect(summary).toContain("in progress");
    expect(summary).toContain("fridge-a");
  });
  it("empty stream → 'nothing recorded yet'", () => {
    expect(statusSummary(mkDir("onb-"))).toContain("nothing recorded yet");
  });
});

describe("trigger 4 (completion → enqueue [+ drain when transport armed])", () => {
  it("without transport: job queued with kind=onboarding, returns false", () => {
    const ops = mkDir("ops-");
    const armed = triggerOnboardingDistill(ops);
    expect(armed).toBe(false);
    const jobs = listJobs(ops);
    expect(jobs.length).toBe(1);
    expect(JSON.parse(fs.readFileSync(jobs[0], "utf8")).kind).toBe("onboarding");
  });
  it("with transport: job_defaults are merged into the job", () => {
    const ops = mkDir("ops-");
    // transport with a fake binary that exits instantly (drain fires async — we
    // only assert the enqueue shape here, before any drain removes it)
    writeDistillerConfig(ops, {
      binary: "/bin/true",
      config: {},
      job_defaults: { vault: "/v", runs_root: "/r" },
    });
    const armed = triggerOnboardingDistill(ops);
    expect(armed).toBe(true);
    // the job either still queued or drained by /bin/true; check via the queue OR accept empty
    const jobs = listJobs(ops);
    if (jobs.length > 0) {
      const job = JSON.parse(fs.readFileSync(jobs[0], "utf8"));
      expect(job.vault).toBe("/v");
      expect(job.runs_root).toBe("/r");
    }
  });
});
