// Tests for boot-time attachment pointer recovery (#1410, ADR 0030 §D3).
// The module reads the on-disk attachment pointer at boot and, when valid,
// spins up the per-attachment transport so the D3 resolver routes to the
// attached device after a window reload.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recoverBootAttachment, type BootAttachmentRecoveryDeps } from "../src/boot_attachment_recovery";
import { writeAttachmentCredential } from "../src/amicode_service/attachment_credential";

function writePointer(file: string, pointer: Record<string, unknown>): void {
  writeFileSync(file, JSON.stringify(pointer));
}

function makeLog() {
  const lines: string[] = [];
  return { lines, appendLine: (line: string) => lines.push(line) };
}

function mockTransport(localUrl = "http://127.0.0.1:9999") {
  let stopped = false;
  const calls: Array<{ target: { sshAlias: string; transport: string; machine_id: string }; remotePort: number }> = [];
  return {
    calls,
    stopped: () => stopped,
    fn: async (opts: {
      target: { sshAlias: string; transport: string; machine_id: string };
      remotePort: number;
      readyTimeoutMs?: number;
    }) => {
      calls.push({ target: opts.target, remotePort: opts.remotePort });
      return { localUrl, stop: async () => { stopped = true; } };
    },
  };
}

describe("recoverBootAttachment — boot-time pointer recovery (#1410)", () => {
  let dir: string;
  let attachmentFile: string;
  let credentialFile: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "boot-attach-"));
    attachmentFile = join(dir, "attachment.json");
    credentialFile = join(dir, "attachment-credentials.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("valid pointer at boot → transport constructed with correct sshAlias/transport", async () => {
    writePointer(attachmentFile, { sshAlias: "mac-studio", transport: "ssh", machine_id: "peer-01" });
    const transport = mockTransport();
    const log = makeLog();
    const result = await recoverBootAttachment({
      attachmentFile,
      credentialFile,
      bringUpTransport: transport.fn,
      log,
    });
    expect(result).toBeDefined();
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0].target).toEqual({ sshAlias: "mac-studio", transport: "ssh", machine_id: "peer-01" });
    expect(transport.calls[0].remotePort).toBe(43117);
  });

  it("valid pointer → getUrl returns the transport's localUrl", async () => {
    writePointer(attachmentFile, { sshAlias: "mac-studio", transport: "ssh", machine_id: "peer-01" });
    const transport = mockTransport("http://127.0.0.1:12345");
    const result = await recoverBootAttachment({
      attachmentFile,
      credentialFile,
      bringUpTransport: transport.fn,
    });
    expect(result).toBeDefined();
    expect(result!.getUrl()).toBe("http://127.0.0.1:12345");
  });

  it("valid pointer → pointer is carried on the result", async () => {
    writePointer(attachmentFile, { sshAlias: "mac-studio", transport: "ssh", machine_id: "peer-01" });
    const transport = mockTransport();
    const result = await recoverBootAttachment({
      attachmentFile,
      credentialFile,
      bringUpTransport: transport.fn,
    });
    expect(result!.pointer).toEqual({ sshAlias: "mac-studio", transport: "ssh", machine_id: "peer-01" });
  });

  it("valid pointer → per-attachment credential used (NOT hub credential)", async () => {
    writePointer(attachmentFile, { sshAlias: "mac-studio", transport: "ssh", machine_id: "peer-01" });
    writeAttachmentCredential("peer-01", { baseUrl: "http://127.0.0.1:4096", token: "secret-tok" }, { credentialFile });
    const transport = mockTransport();
    const result = await recoverBootAttachment({
      attachmentFile,
      credentialFile,
      bringUpTransport: transport.fn,
    });
    expect(result).toBeDefined();
    expect(result!.credential()).toEqual({ baseUrl: "http://127.0.0.1:4096", token: "secret-tok" });
  });

  it("valid pointer + no stored credential → credential() returns null", async () => {
    writePointer(attachmentFile, { sshAlias: "mac-studio", transport: "ssh", machine_id: "peer-01" });
    const transport = mockTransport();
    const result = await recoverBootAttachment({
      attachmentFile,
      credentialFile,
      bringUpTransport: transport.fn,
    });
    expect(result!.credential()).toBeNull();
  });

  it("valid pointer + transport failure → no result, no throw, log line", async () => {
    writePointer(attachmentFile, { sshAlias: "mac-studio", transport: "ssh", machine_id: "peer-01" });
    const log = makeLog();
    const result = await recoverBootAttachment({
      attachmentFile,
      credentialFile,
      bringUpTransport: async () => { throw new Error("ssh forward timed out"); },
      log,
    });
    expect(result).toBeUndefined();
    expect(log.lines.some((l) => l.includes("transport failed"))).toBe(true);
  });

  it("empty pointer → no result, no transport attempt", async () => {
    // No pointer file written → absent = empty
    const transport = mockTransport();
    const result = await recoverBootAttachment({
      attachmentFile,
      credentialFile,
      bringUpTransport: transport.fn,
    });
    expect(result).toBeUndefined();
    expect(transport.calls).toHaveLength(0);
  });

  it("malformed pointer → no result, no throw, log line", async () => {
    writeFileSync(attachmentFile, "not-json");
    const log = makeLog();
    const result = await recoverBootAttachment({
      attachmentFile,
      credentialFile,
      bringUpTransport: mockTransport().fn,
      log,
    });
    expect(result).toBeUndefined();
    expect(log.lines.some((l) => l.includes("malformed"))).toBe(true);
  });

  it("no transport factory → no result, log line", async () => {
    writePointer(attachmentFile, { sshAlias: "mac-studio", transport: "ssh", machine_id: "peer-01" });
    const log = makeLog();
    const result = await recoverBootAttachment({
      attachmentFile,
      credentialFile,
      // bringUpTransport intentionally NOT provided
      log,
    });
    expect(result).toBeUndefined();
    expect(log.lines.some((l) => l.includes("no transport factory"))).toBe(true);
  });

  it("custom remotePort is forwarded to the transport", async () => {
    writePointer(attachmentFile, { sshAlias: "mac-studio", transport: "ssh", machine_id: "peer-01" });
    const transport = mockTransport();
    await recoverBootAttachment({
      attachmentFile,
      credentialFile,
      bringUpTransport: transport.fn,
      remotePort: 8888,
    });
    expect(transport.calls[0].remotePort).toBe(8888);
  });

  it("stop() tears down the transport", async () => {
    writePointer(attachmentFile, { sshAlias: "mac-studio", transport: "ssh", machine_id: "peer-01" });
    const transport = mockTransport();
    const result = await recoverBootAttachment({
      attachmentFile,
      credentialFile,
      bringUpTransport: transport.fn,
    });
    expect(transport.stopped()).toBe(false);
    await result!.stop();
    expect(transport.stopped()).toBe(true);
  });
});
