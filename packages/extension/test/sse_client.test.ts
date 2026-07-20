import { describe, it, expect, vi } from "vitest";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { OpencodeEventClient } from "../src/sse_client";
import { mintServerPassword, serverAuthHeader, serverAuthToken } from "../src/server_auth";

// ============================================================================
// #163: with the per-boot server password armed, the fork 401s /event without
// the Basic credential — the SSE channel would silently retry-loop forever
// (its reconnect policy swallows errors by design). These tests pin that the
// client authenticates, against a REAL local http server capturing the request
// headers, and that the credential never reaches the output channel (AC3).
// ============================================================================

function captureChannel() {
  const lines: string[] = [];
  return {
    lines,
    channel: { appendLine: (l: string) => lines.push(l), append: (l: string) => lines.push(l) } as never,
  };
}

function sseServer() {
  const requests: { url?: string; authorization?: string }[] = [];
  const srv = http.createServer((req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"type":"session.idle"}\n\n'); // held open — the client keeps streaming
  });
  return { srv, requests };
}

describe("OpencodeEventClient — authenticated /event subscription (#163)", () => {
  it("carries the per-boot Basic credential on the /event request (AC2) and never logs it (AC3)", async () => {
    const { srv, requests } = sseServer();
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as AddressInfo).port;
    const password = mintServerPassword();
    const { lines, channel } = captureChannel();
    const client = new OpencodeEventClient({ channel, authorization: serverAuthHeader(password) });
    try {
      client.connect(new URL(`http://127.0.0.1:${port}`));
      await vi.waitFor(() => expect(requests.length).toBeGreaterThan(0));
      expect(requests[0].url).toBe("/event");
      // the SAME credential the spawn env arms — one boot, one password
      expect(requests[0].authorization).toBe(serverAuthHeader(password));
      await vi.waitFor(() => expect(lines.join("\n")).toContain("[sse] connected"));
      // AC3: the password reaches the wire, never the output channel — in no
      // encoding the channel could carry it.
      const text = lines.join("\n");
      expect(text).not.toContain(password);
      expect(text).not.toContain(serverAuthToken(password));
    } finally {
      client.dispose();
      srv.close();
    }
  });

  it("omits the header when no credential is configured (no-password dev path unchanged)", async () => {
    const { srv, requests } = sseServer();
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const { channel } = captureChannel();
    const client = new OpencodeEventClient({ channel });
    try {
      client.connect(new URL(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`));
      await vi.waitFor(() => expect(requests.length).toBeGreaterThan(0));
      expect(requests[0].authorization).toBeUndefined();
    } finally {
      client.dispose();
      srv.close();
    }
  });
});
