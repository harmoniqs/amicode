import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { parseGitHead, resolveWorkspaceRepoRef, mintTelemetrySession } from "../src/telemetry";

// ============================================================================
// Run-corpus telemetry glue (feat/telemetry-env-injection). The consent gate +
// contract encoding are tested in server_auth.test.ts (pure). Here we cover how
// the extension SOURCES the resource attributes: repo + git ref off the active
// workspace, and the per-activation session id.
// ============================================================================

function setWorkspaceFolders(folders: unknown[]): void {
  (vscode.workspace as unknown as { workspaceFolders: unknown[] }).workspaceFolders = folders;
}

describe("parseGitHead — branch name or detached short SHA from .git/HEAD", () => {
  it("extracts the branch from a symbolic ref", () => {
    expect(parseGitHead("ref: refs/heads/main\n")).toBe("main");
  });
  it("keeps the slashes in a namespaced branch", () => {
    expect(parseGitHead("ref: refs/heads/feat/telemetry-env-injection\n")).toBe("feat/telemetry-env-injection");
  });
  it("shortens a detached-HEAD sha to 12 chars", () => {
    expect(parseGitHead("1234567890abcdef1234567890abcdef12345678\n")).toBe("1234567890ab");
  });
  it("returns '' for anything unparseable (never throws downstream)", () => {
    expect(parseGitHead("")).toBe("");
    expect(parseGitHead("not a ref\n")).toBe("");
  });
});

describe("mintTelemetrySession — per-activation correlation id (stub)", () => {
  it("mints a fresh id each call", () => {
    expect(mintTelemetrySession()).not.toBe(mintTelemetrySession());
  });
});

describe("resolveWorkspaceRepoRef — repo + git ref from the active workspace", () => {
  it("no workspace folder → empty repo + ref (attributes ride empty; never throws)", () => {
    setWorkspaceFolders([]);
    expect(resolveWorkspaceRepoRef()).toEqual({ repo: "", gitRef: "" });
  });
  it("repo = folder basename, ref = branch from <folder>/.git/HEAD", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amicode-tele-"));
    const repoDir = path.join(dir, "my-repo");
    fs.mkdirSync(path.join(repoDir, ".git"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, ".git", "HEAD"), "ref: refs/heads/main\n");
    setWorkspaceFolders([{ uri: { fsPath: repoDir } }]);
    try {
      expect(resolveWorkspaceRepoRef()).toEqual({ repo: "my-repo", gitRef: "main" });
    } finally {
      setWorkspaceFolders([]);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it("follows a linked-worktree gitdir: pointer to find HEAD", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amicode-tele-"));
    const realGit = path.join(dir, "gitdir", "worktrees", "wt");
    fs.mkdirSync(realGit, { recursive: true });
    fs.writeFileSync(path.join(realGit, "HEAD"), "ref: refs/heads/feature/x\n");
    const repoDir = path.join(dir, "wt");
    fs.mkdirSync(repoDir, { recursive: true });
    fs.writeFileSync(path.join(repoDir, ".git"), `gitdir: ${realGit}\n`);
    setWorkspaceFolders([{ uri: { fsPath: repoDir } }]);
    try {
      expect(resolveWorkspaceRepoRef()).toEqual({ repo: "wt", gitRef: "feature/x" });
    } finally {
      setWorkspaceFolders([]);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it("no .git → repo resolves, ref stays '' (degrade, don't crash)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amicode-tele-"));
    const repoDir = path.join(dir, "plain-dir");
    fs.mkdirSync(repoDir, { recursive: true });
    setWorkspaceFolders([{ uri: { fsPath: repoDir } }]);
    try {
      expect(resolveWorkspaceRepoRef()).toEqual({ repo: "plain-dir", gitRef: "" });
    } finally {
      setWorkspaceFolders([]);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
