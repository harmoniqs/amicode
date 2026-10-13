import { describe, it, expect, vi } from "vitest";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { OpencodeEventClient } from "../src/sse_client";
import { mintServerPassword, serverAuthHeader, serverAuthToken } from "../src/server_auth";
import { FollowedSessionWatcher } from "../src/followed_session_watcher";

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

// ============================================================================
// #1788 (S3) — the observe-only event hook: every posture's extension host
// holds ONE SSE connection; the followed-session watcher rides it. These
// tests pin the seam against a REAL local http server: the observer sees the
// parsed events on the SAME /event connection (no new connection is opened),
// a throwing observer cannot break the stream loop, and the live
// question.asked → notification path works end-to-end through the wire.
// ============================================================================

function eventServer() {
  const requests: string[] = [];
  const live: http.ServerResponse[] = [];
  const srv = http.createServer((req, res) => {
    requests.push(req.url ?? "");
    live.push(res);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"type":"session.idle"}\n\n'); // held open — the client keeps streaming
  });
  return {
    srv,
    requests,
    /** Push one raw SSE frame over every held-open connection (the test
     * drives the wire exactly as the engine would mid-stream). */
    push(frame: string) {
      for (const res of live) res.write(frame);
    },
  };
}

describe("OpencodeEventClient — the #1788 observe-only event hook", () => {
  it("delivers every parsed event to the observer on the SAME connection (AC6: no new connection)", async () => {
    const { srv, requests } = eventServer();
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const { channel } = captureChannel();
    const seen: string[] = [];
    const client = new OpencodeEventClient({
      channel,
      onEvent: (e) => seen.push(e.type ?? ""),
    });
    try {
      client.connect(new URL(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`));
      await vi.waitFor(() => expect(seen).toEqual(["session.idle"]));
      // The observer is a SINK on the one /event request — never a second
      // connection, and never a mutation of the stream.
      expect(requests).toEqual(["/event"]);
    } finally {
      client.dispose();
      srv.close();
    }
  });

  it("a throwing observer is contained — the stream loop is never broken (shared-infrastructure guard)", async () => {
    const { srv } = eventServer();
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const { lines, channel } = captureChannel();
    const client = new OpencodeEventClient({
      channel,
      onEvent: () => {
        throw new Error("observer bug");
      },
    });
    try {
      client.connect(new URL(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`));
      // The stream still connected (its own routing survived the observer).
      await vi.waitFor(() => expect(lines.join("\n")).toContain("[sse] connected"));
      expect(lines.join("\n")).toContain("observer error");
    } finally {
      client.dispose();
      srv.close();
    }
  });

  it("live path — a question.asked frame on the wire raises the followed-session notification through the existing stream (headless host assertion)", async () => {
    const { srv, requests, push } = eventServer();
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const { channel } = captureChannel();
    const showInformationMessage = vi.fn().mockResolvedValue(undefined);
    const watcher = new FollowedSessionWatcher({
      followedSessions: () => new Set(["ses_hub_1"]),
      isSessionFocused: () => false,
      showInformationMessage,
      onFocusSession: vi.fn(),
      now: () => 0,
    });
    const client = new OpencodeEventClient({
      channel,
      onEvent: (e) => watcher.observe(e),
    });
    try {
      client.connect(new URL(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`));
      await vi.waitFor(() => expect(requests).toEqual(["/event"]));

      // The hub streams the question while the panel is unfocused elsewhere —
      // over the SAME /event connection the client already holds (AC6).
      push(
        'data: {"type":"session.updated","properties":{"info":{"id":"ses_hub_1","title":"Attach e2e"}}}\n\n' +
          'data: {"type":"question.asked","properties":{"id":"req_live","sessionID":"ses_hub_1","questions":[{"header":"Which build?"}]}}\n\n',
      );

      await vi.waitFor(() => expect(showInformationMessage).toHaveBeenCalledOnce());
      const [msg, action] = showInformationMessage.mock.calls[0];
      expect(msg).toContain("Attach e2e");
      expect(msg).toContain("Which build?");
      expect(action).toBe("View");
      // One connection, still — the watcher never opened anything.
      expect(requests).toEqual(["/event"]);
    } finally {
      client.dispose();
      watcher.dispose();
      srv.close();
    }
  });
});
