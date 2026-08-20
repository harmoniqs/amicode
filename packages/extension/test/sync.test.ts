import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  findWorkspaceRepos,
  isSyncDue,
  syncOneRepo,
  isGitRepo,
  SYNC_INTERVAL_MS,
  type GitRunner,
} from "../src/substrate/sync";

// ── isSyncDue ──────────────────────────────────────────────────────────────
describe("isSyncDue", () => {
  it("due when never synced", () => {
    expect(isSyncDue(undefined)).toBe(true);
    expect(isSyncDue("")).toBe(true);
    expect(isSyncDue("not-a-date")).toBe(true);
  });
  it("not due within interval", () => {
    const now = Date.now();
    const recent = new Date(now - 60_000).toISOString();
    expect(isSyncDue(recent, now)).toBe(false);
  });
  it("due after interval", () => {
    const now = Date.now();
    const old = new Date(now - SYNC_INTERVAL_MS - 1000).toISOString();
    expect(isSyncDue(old, now)).toBe(true);
  });
  it("due exactly at interval boundary", () => {
    const now = Date.now();
    const at = new Date(now - SYNC_INTERVAL_MS - 1).toISOString();
    expect(isSyncDue(at, now)).toBe(true);
  });
});

// ── findWorkspaceRepos ────────────────────────────────────────────────────
describe("findWorkspaceRepos", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "amicode-sync-test-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("finds direct repo folder", () => {
    fs.mkdirSync(path.join(tmp, ".git"));
    expect(findWorkspaceRepos([tmp])).toEqual([tmp]);
  });
  it("finds child repos when root is not a repo", () => {
    const a = path.join(tmp, "proj-a");
    const b = path.join(tmp, "proj-b");
    fs.mkdirSync(a);
    fs.mkdirSync(path.join(a, ".git"));
    fs.mkdirSync(b);
    // no .git in b
    const repos = findWorkspaceRepos([tmp]);
    expect(repos).toEqual([a]);
  });
  it("skips hidden and node_modules", () => {
    const hidden = path.join(tmp, ".hidden");
    const nm = path.join(tmp, "node_modules");
    fs.mkdirSync(hidden);
    fs.mkdirSync(path.join(hidden, ".git"));
    fs.mkdirSync(nm);
    fs.mkdirSync(path.join(nm, ".git"));
    expect(findWorkspaceRepos([tmp])).toEqual([]);
  });
  it("handles multiple roots", () => {
    const r1 = path.join(tmp, "r1");
    const r2 = path.join(tmp, "r2");
    fs.mkdirSync(r1);
    fs.mkdirSync(path.join(r1, ".git"));
    fs.mkdirSync(r2);
    fs.mkdirSync(path.join(r2, ".git"));
    expect(findWorkspaceRepos([r1, r2]).sort()).toEqual([r1, r2].sort());
  });
  it("empty roots returns empty", () => {
    expect(findWorkspaceRepos([])).toEqual([]);
  });
});

// ── syncOneRepo with mocked git ──────────────────────────────────────────
function makeRunner(map: Record<string, string | Error>): GitRunner {
  return (args, _opts) => {
    const key = args.join(" ");
    const v = map[key];
    if (v instanceof Error) throw v;
    if (v !== undefined) return v;
    // default: echo empty (success)
    return "";
  };
}

describe("syncOneRepo", () => {
  it("dirty on main → skipped", () => {
    const run: GitRunner = (args) => {
      const k = args.join(" ");
      if (k === "rev-parse --abbrev-ref HEAD") return "main";
      if (k === "status --porcelain") return " M foo.ts\n";
      throw new Error(`unexpected ${k}`);
    };
    const r = syncOneRepo("/tmp/fake", run);
    expect(r.status).toBe("skipped");
    expect(r.detail).toMatch(/dirty on main/);
  });

  it("dirty on feature branch → updates main ref", () => {
    const run: GitRunner = (args) => {
      const k = args.join(" ");
      if (k === "rev-parse --abbrev-ref HEAD") return "my-feature";
      if (k === "status --porcelain") return " M foo.ts\n";
      if (k === "fetch origin --quiet") return "";
      if (k === "rev-parse --verify origin/main") return "abc";
      if (k === "rev-parse --verify main") return "abc";
      if (k === "merge-base --is-ancestor main origin/main") return "";
      if (k === "rev-list --count main..origin/main") return "3";
      if (k === "branch -f main origin/main") return "";
      throw new Error(`unexpected ${k}`);
    };
    const r = syncOneRepo("/tmp/fake-proj", run);
    expect(r.status).toBe("skipped");
    expect(r.detail).toMatch(/main ff'd 3/);
  });

  it("clean on main → fast-forwards", () => {
    const run: GitRunner = (args) => {
      const k = args.join(" ");
      if (k === "rev-parse --abbrev-ref HEAD") return "main";
      if (k === "status --porcelain") return "";
      if (k === "fetch origin --quiet") return "";
      if (k === "rev-parse --verify origin/main") return "abc";
      if (k === "merge-base --is-ancestor HEAD origin/main") return "";
      if (k === "merge --ff-only origin/main") return "";
      throw new Error(`unexpected ${k}`);
    };
    const r = syncOneRepo("/tmp/fake", run);
    expect(r.status).toBe("ok");
    expect(r.detail).toMatch(/fast-forward/);
  });

  it("clean main diverged → skipped", () => {
    const run: GitRunner = (args) => {
      const k = args.join(" ");
      if (k === "rev-parse --abbrev-ref HEAD") return "main";
      if (k === "status --porcelain") return "";
      if (k === "fetch origin --quiet") return "";
      if (k === "rev-parse --verify origin/main") return "abc";
      if (k === "merge-base --is-ancestor HEAD origin/main") throw new Error("not ancestor");
      throw new Error(`unexpected ${k}`);
    };
    const r = syncOneRepo("/tmp/fake", run);
    expect(r.status).toBe("skipped");
    expect(r.detail).toMatch(/diverged/);
  });

  it("fetch failure → failed", () => {
    const run: GitRunner = (args) => {
      const k = args.join(" ");
      if (k === "rev-parse --abbrev-ref HEAD") return "main";
      if (k === "status --porcelain") return "";
      if (k === "fetch origin --quiet") throw new Error("network down");
      throw new Error(`unexpected ${k}`);
    };
    const r = syncOneRepo("/tmp/fake", run);
    expect(r.status).toBe("failed");
    expect(r.detail).toMatch(/fetch failed/);
  });

  it("detached HEAD → skipped", () => {
    const run: GitRunner = (args) => {
      const k = args.join(" ");
      if (k === "rev-parse --abbrev-ref HEAD") return "HEAD";
      throw new Error(`unexpected ${k}`);
    };
    const r = syncOneRepo("/tmp/fake", run);
    expect(r.status).toBe("skipped");
    expect(r.detail).toMatch(/detached/);
  });

  it("clean feature branch rebase conflict → failed and aborted", () => {
    let aborted = false;
    const run: GitRunner = (args) => {
      const k = args.join(" ");
      if (k === "rev-parse --abbrev-ref HEAD") return "feat";
      if (k === "status --porcelain") return "";
      if (k === "fetch origin --quiet") return "";
      if (k === "rev-parse --verify origin/feat") return "abc";
      if (k === "rev-list --count HEAD..origin/feat") return "2";
      if (k === "rebase origin/feat") throw new Error("conflict");
      if (k === "rebase --abort") {
        aborted = true;
        return "";
      }
      if (k === "rev-parse --verify origin/main") throw new Error("no main");
      if (k === "rev-parse --verify origin/master") throw new Error("no master");
      throw new Error(`unexpected ${k}`);
    };
    const r = syncOneRepo("/tmp/fake", run);
    expect(r.status).toBe("failed");
    expect(aborted).toBe(true);
  });

  it("clean feature branch with WIP auto-rebases onto updated main", () => {
    const run: GitRunner = (args) => {
      const k = args.join(" ");
      if (k === "rev-parse --abbrev-ref HEAD") return "feat";
      if (k === "status --porcelain") return "";
      if (k === "fetch origin --quiet") return "";
      if (k === "rev-parse --verify origin/feat") return "abc";
      if (k === "rev-list --count HEAD..origin/feat") return "0";
      if (k === "rev-parse --verify origin/main") return "abc";
      if (k === "rev-parse --verify main") return "abc";
      if (k === "rev-list --count main..origin/main") return "2";
      if (k === "merge-base --is-ancestor main origin/main") return "";
      if (k === "branch -f main origin/main") return "";
      if (k === "rev-list --count main..feat") return "1";
      if (k === "rebase main") return "";
      throw new Error(`unexpected ${k}`);
    };
    const r = syncOneRepo("/tmp/fake", run);
    expect(r.status).toBe("ok");
    expect(r.detail).toMatch(/WIP rebased/);
  });
});
