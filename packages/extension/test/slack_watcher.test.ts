// Unit tests for the Slack credential watcher (#1037 v2).
//
// The watcher fires an `onChange` callback with `{ exists: boolean }` whenever
// the credential file is created, deleted, or modified — letting the consumer
// decide whether to add or remove the MCP server dynamically.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { watchSlackCredential } from "../src/slack_watcher";

describe("watchSlackCredential", () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "slack-watcher-test-"));
    filePath = join(dir, "slack.json");
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    // Clean up test file if it exists
    try {
      if (existsSync(filePath)) unlinkSync(filePath);
    } catch {
      /* ignore */
    }
  });

  it("fires with { exists: true } when the credential file is created", async () => {
    const onChange = vi.fn<[{ exists: boolean }]>();
    const watcher = watchSlackCredential(onChange, filePath, 50, 10);

    // Create the file
    writeFileSync(filePath, JSON.stringify({ token: "xoxp-test" }));

    // Advance past poll + debounce
    await vi.advanceTimersByTimeAsync(200);

    expect(onChange).toHaveBeenCalledWith({ exists: true });
    watcher.dispose();
  });

  it("fires with { exists: false } when the credential file is deleted", async () => {
    // Start with file present
    writeFileSync(filePath, JSON.stringify({ token: "xoxp-test" }));
    const onChange = vi.fn<[{ exists: boolean }]>();
    const watcher = watchSlackCredential(onChange, filePath, 50, 10);

    // Let the watcher see the initial state
    await vi.advanceTimersByTimeAsync(200);
    onChange.mockClear();

    // Delete the file
    unlinkSync(filePath);

    // Advance past poll + debounce
    await vi.advanceTimersByTimeAsync(200);

    expect(onChange).toHaveBeenCalledWith({ exists: false });
    watcher.dispose();
  });

  it("is idempotent — no callback when file state hasn't changed", async () => {
    const onChange = vi.fn<[{ exists: boolean }]>();
    const watcher = watchSlackCredential(onChange, filePath, 50, 10);

    // File doesn't exist — steady state
    await vi.advanceTimersByTimeAsync(500);

    expect(onChange).not.toHaveBeenCalled();
    watcher.dispose();
  });

  it("dispose stops polling", async () => {
    const onChange = vi.fn<[{ exists: boolean }]>();
    const watcher = watchSlackCredential(onChange, filePath, 50, 10);
    watcher.dispose();

    // Create the file after dispose
    writeFileSync(filePath, JSON.stringify({ token: "xoxp-test" }));
    await vi.advanceTimersByTimeAsync(500);

    expect(onChange).not.toHaveBeenCalled();
  });
});
