// Workspace sync — opt-in, extension-host, user-focused.
// Keeps any git repo in the open workspace current with its remote.
// Pure helpers are unit-tested; VS Code wiring (prompt + channel) is thin.
//
// Design (grilled 2026-08-09, issue #314):
//   — single toggle amicode.sync.enabled (off by default, onboarding nudge)
//   — generic scope: any git repo found under workspace folders
//   — clean WIP auto-rebases onto freshly fast-forwarded main; dirty skips rebase
//   — conflicts abort cleanly (branch untouched); notifications only on attention-needed
//   — missed-nightly: if >20h since lastSyncAt, run within 2 min of activation
//   — manual: Amicode: Sync now (Command Palette)
//   — Julia env: check + nudge only (no auto-mutate) — stubbed for v1, wired later
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

// ── constants ──────────────────────────────────────────────────────────────
export const SYNC_ENABLED_KEY = "amicode.sync.enabled"; // VS Code setting
export const LAST_SYNC_KEY = "amicode.sync.lastSyncAt"; // globalState ISO string
export const SYNC_DISMISSED_KEY = "amicode.sync.dismissed"; // globalState boolean
export const SYNC_INTERVAL_MS = 20 * 60 * 60 * 1000; // 20h — "nightly" with startup grace
export const SYNC_DEBOUNCE_MS = 2 * 60 * 1000; // run within 2 min of activation if due

// ── injectable runner (healthcheck / julia_setup pattern) ────────────────
export type GitRunner = (args: string[], opts: { cwd: string }) => string;
export const defaultGitRunner: GitRunner = (args, opts) =>
  execFileSync("git", args, { encoding: "utf8", cwd: opts.cwd, timeout: 30_000 }).trim();

// ── pure helpers ───────────────────────────────────────────────────────────

/** Is `dir` a git repo (has .git)? Never throws. */
export function isGitRepo(dir: string): boolean {
  try {
    return fs.existsSync(path.join(dir, ".git"));
  } catch {
    return false;
  }
}

/** Find git repos under workspace folders:
 *  — if the folder itself is a repo, return it
 *  — otherwise scan immediate children for repos
 *  Never throws; skips unreadable entries. */
export function findWorkspaceRepos(workspaceFolders: string[]): string[] {
  const out: string[] = [];
  for (const root of workspaceFolders) {
    if (isGitRepo(root)) {
      out.push(root);
      continue;
    }
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const name of entries) {
      // skip hidden + common non-repo dirs
      if (name.startsWith(".")) continue;
      if (name === "node_modules" || name === "__pycache__" || name === "target") continue;
      const full = path.join(root, name);
      try {
        if (fs.statSync(full).isDirectory() && isGitRepo(full)) out.push(full);
      } catch {
        /* unreadable — skip */
      }
    }
  }
  return out;
}

/** Current branch name, or null if detached / error. */
export function currentBranch(repoPath: string, run: GitRunner = defaultGitRunner): string | null {
  try {
    const out = run(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoPath });
    if (!out || out === "HEAD") return null;
    return out;
  } catch {
    return null;
  }
}

/** True if `git status --porcelain` has any output. */
export function isDirty(repoPath: string, run: GitRunner = defaultGitRunner): boolean {
  try {
    const out = run(["status", "--porcelain"], { cwd: repoPath });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

/** Does origin/<branch> exist? */
export function hasOriginBranch(
  repoPath: string,
  branch: string,
  run: GitRunner = defaultGitRunner,
): boolean {
  try {
    run(["rev-parse", "--verify", `origin/${branch}`], { cwd: repoPath });
    return true;
  } catch {
    return false;
  }
}

/** Fetch origin quietly; true on success. */
export function fetchOrigin(repoPath: string, run: GitRunner = defaultGitRunner): boolean {
  try {
    run(["fetch", "origin", "--quiet"], { cwd: repoPath });
    return true;
  } catch {
    return false;
  }
}

// ── per-repo sync (the WIP-aware logic) ───────────────────────────────────

export type RepoSyncResult =
  | { repo: string; branch: string; status: "ok"; detail: string }
  | { repo: string; branch: string; status: "skipped"; detail: string }
  | { repo: string; branch: string; status: "failed"; detail: string };

/** Sync one repo. Never throws; always returns a result. */
export function syncOneRepo(
  repoPath: string,
  run: GitRunner = defaultGitRunner,
): RepoSyncResult {
  const repo = path.basename(repoPath);
  const branch = currentBranch(repoPath, run);
  if (!branch) return { repo, branch: "detached", status: "skipped", detail: "detached HEAD" };

  const dirty = isDirty(repoPath, run);

  // Dirty on main/master: skip entirely.
  if (dirty && (branch === "main" || branch === "master")) {
    return { repo, branch, status: "skipped", detail: "dirty on main" };
  }

  // Dirty on feature branch: fetch + force-update local main ref, skip rebase.
  if (dirty) {
    if (!fetchOrigin(repoPath, run)) {
      return { repo, branch, status: "failed", detail: "fetch failed" };
    }
    // Find which mainline to update (main preferred, then master).
    let mainBranch: string | null = null;
    if (hasOriginBranch(repoPath, "main", run)) mainBranch = "main";
    else if (hasOriginBranch(repoPath, "master", run)) mainBranch = "master";
    if (!mainBranch) {
      return { repo, branch, status: "skipped", detail: "dirty, no origin/main or origin/master" };
    }
    let hasLocalMain = false;
    try {
      run(["rev-parse", "--verify", mainBranch], { cwd: repoPath });
      hasLocalMain = true;
    } catch {
      hasLocalMain = false;
    }
    if (hasLocalMain) {
      // Only fast-forward if origin is ahead (ancestor check).
      let isAncestor = false;
      try {
        run(["merge-base", "--is-ancestor", mainBranch, `origin/${mainBranch}`], { cwd: repoPath });
        isAncestor = true;
      } catch {
        isAncestor = false;
      }
      if (!isAncestor) {
        return { repo, branch, status: "skipped", detail: "dirty, main diverged" };
      }
      let behind = 0;
      try {
        const out = run(["rev-list", "--count", `${mainBranch}..origin/${mainBranch}`], { cwd: repoPath });
        behind = parseInt(out, 10) || 0;
      } catch {
        behind = 0;
      }
      if (behind > 0) {
        try {
          run(["branch", "-f", mainBranch, `origin/${mainBranch}`], { cwd: repoPath });
          return { repo, branch, status: "skipped", detail: `dirty, main ff'd ${behind}` };
        } catch {
          return { repo, branch, status: "failed", detail: "dirty, main update failed" };
        }
      }
      return { repo, branch, status: "skipped", detail: "dirty, main up to date" };
    } else {
      try {
        run(["branch", mainBranch, `origin/${mainBranch}`], { cwd: repoPath });
        return { repo, branch, status: "skipped", detail: `dirty, main created at origin/${mainBranch}` };
      } catch {
        return { repo, branch, status: "failed", detail: "dirty, main create failed" };
      }
    }
  }

  // Clean repo: fetch + ff or rebase.
  if (!fetchOrigin(repoPath, run)) {
    return { repo, branch, status: "failed", detail: "fetch failed" };
  }

  // Main/master: fast-forward only.
  if (branch === "main" || branch === "master") {
    if (!hasOriginBranch(repoPath, branch, run)) {
      return { repo, branch, status: "skipped", detail: `no origin/${branch}` };
    }
    let isAncestor = false;
    try {
      run(["merge-base", "--is-ancestor", "HEAD", `origin/${branch}`], { cwd: repoPath });
      isAncestor = true;
    } catch {
      isAncestor = false;
    }
    if (!isAncestor) {
      return { repo, branch, status: "skipped", detail: "diverged — needs human" };
    }
    try {
      run(["merge", "--ff-only", `origin/${branch}`], { cwd: repoPath });
      return { repo, branch, status: "ok", detail: "fast-forwarded" };
    } catch {
      return { repo, branch, status: "skipped", detail: "ff-only failed" };
    }
  }

  // Feature branch, clean: rebase onto origin/<branch> if behind, then keep main fresh + rebase WIP onto main if needed.
  const hasTracked = hasOriginBranch(repoPath, branch, run);
  if (hasTracked) {
    let behind = 0;
    try {
      const out = run(["rev-list", "--count", `HEAD..origin/${branch}`], { cwd: repoPath });
      behind = parseInt(out, 10) || 0;
    } catch {
      behind = 0;
    }
    if (behind > 0) {
      try {
        run(["rebase", `origin/${branch}`], { cwd: repoPath });
        // Fall through to main sync below — rebase succeeded.
      } catch {
        try {
          run(["rebase", "--abort"], { cwd: repoPath });
        } catch {
          /* ignore */
        }
        return { repo, branch, status: "failed", detail: "rebase conflict (tracked branch)" };
      }
    }
  }

  // Keep local main fresh (even for clean feature branches) and auto-rebase WIP onto main if clean.
  let mainBranch: string | null = null;
  if (hasOriginBranch(repoPath, "main", run)) mainBranch = "main";
  else if (hasOriginBranch(repoPath, "master", run)) mainBranch = "master";

  if (mainBranch) {
    // Update local main ref if needed (fast-forward check).
    let hasLocalMain = false;
    try {
      run(["rev-parse", "--verify", mainBranch], { cwd: repoPath });
      hasLocalMain = true;
    } catch {
      hasLocalMain = false;
    }
    if (hasLocalMain) {
      let behindMain = 0;
      try {
        const out = run(["rev-list", "--count", `${mainBranch}..origin/${mainBranch}`], { cwd: repoPath });
        behindMain = parseInt(out, 10) || 0;
      } catch {
        behindMain = 0;
      }
      if (behindMain > 0) {
        let isAncestor = false;
        try {
          run(["merge-base", "--is-ancestor", mainBranch, `origin/${mainBranch}`], { cwd: repoPath });
          isAncestor = true;
        } catch {
          isAncestor = false;
        }
        if (isAncestor) {
          try {
            run(["branch", "-f", mainBranch, `origin/${mainBranch}`], { cwd: repoPath });
          } catch {
            // non-fatal — main update failed but feature rebase still attempted
          }
          // Clean WIP: auto-rebase feature branch onto updated main.
          // Only if the feature branch has commits ahead of main (i.e., real WIP).
          let aheadOfMain = 0;
          try {
            const out = run(["rev-list", "--count", `${mainBranch}..${branch}`], { cwd: repoPath });
            aheadOfMain = parseInt(out, 10) || 0;
          } catch {
            aheadOfMain = 0;
          }
          if (aheadOfMain > 0) {
            try {
              run(["rebase", mainBranch], { cwd: repoPath });
              return { repo, branch, status: "ok", detail: `main ff'd ${behindMain}, WIP rebased onto ${mainBranch}` };
            } catch {
              try {
                run(["rebase", "--abort"], { cwd: repoPath });
              } catch {
                /* ignore */
              }
              return { repo, branch, status: "failed", detail: `main ff'd ${behindMain}, WIP rebase conflict` };
            }
          }
          return { repo, branch, status: "ok", detail: `main ff'd ${behindMain}` };
        }
      }
    } else {
      // No local main — create it, then consider WIP rebase (rare).
      try {
        run(["branch", mainBranch, `origin/${mainBranch}`], { cwd: repoPath });
      } catch {
        /* ignore */
      }
    }
  }

  // No main update needed; report tracked rebase or up-to-date.
  if (hasTracked) {
    return { repo, branch, status: "ok", detail: "up to date" };
  }
  return { repo, branch, status: "skipped", detail: `no origin/${branch}` };
}

// ── timing helpers (pure) ──────────────────────────────────────────────────

export function isSyncDue(lastSyncAt: string | undefined, nowMs: number = Date.now()): boolean {
  if (!lastSyncAt) return true; // never synced — due
  const last = Date.parse(lastSyncAt);
  if (Number.isNaN(last)) return true;
  return nowMs - last > SYNC_INTERVAL_MS;
}
