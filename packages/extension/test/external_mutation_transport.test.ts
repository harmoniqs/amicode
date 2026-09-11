import { describe, expect, it, vi } from "vitest";
import { runTrackedMutation } from "../src/external_mutation";
import { ExternalMutationTransport } from "../src/external_mutation_transport";

describe("ExternalMutationTransport", () => {
  it("prepares a versioned reservation over the authenticated session route", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        version: 1,
        reservation: {
          id: "group-1",
          expiresAt: 1234,
          endpoints: [{ reference: "external_1", capability: "cap-1", revision: 0 }],
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    const transport = new ExternalMutationTransport({
      url: "http://127.0.0.1:43117",
      authorization: "Basic test",
      fetch,
    });

    await expect(transport.prepare("ses_1", ["/outside/one.txt"])) .resolves.toEqual({
      id: "group-1",
      expiresAt: 1234,
      endpoints: [{ reference: "external_1", capability: "cap-1", revision: 0 }],
    });
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:43117/session/ses_1/external-diff/reservations/prepare",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Basic test" },
        body: JSON.stringify({ version: 1, files: ["/outside/one.txt"] }),
      }),
    );
  });

  it("reads assessed detail at the authenticated no-store session route", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      version: 1,
      revision: 4,
      assessments: [{ reference: "external_1", file: "/outside/one.txt", state: "changed" }],
    }), { status: 200 }));
    const transport = new ExternalMutationTransport({
      url: "http://127.0.0.1:43117",
      authorization: "Basic test",
      fetch,
    });

    await expect(transport.assessed("ses_1")).resolves.toEqual({
      revision: 4,
      assessments: [{ reference: "external_1", file: "/outside/one.txt" }],
    });
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:43117/session/ses_1/diff/assessed?patch=false",
      { headers: { Authorization: "Basic test" } },
    );
  });
});

describe("runTrackedMutation", () => {
  const reservation = {
    id: "group-1",
    expiresAt: 1234,
    endpoints: [
      { reference: "external_source", capability: "source-cap", revision: 0 },
      { reference: "external_destination", capability: "destination-cap", revision: 0 },
    ],
  };

  it("prepares a two-endpoint group before mutation and commits it afterwards", async () => {
    const order: string[] = [];
    const tracking = {
      sessionID: "ses_last_focused",
      transport: {
        prepare: vi.fn(async (_sessionID, files) => {
          order.push(`prepare:${files.join(",")}`);
          return reservation;
        }),
        commit: vi.fn(async () => {
          order.push("commit");
          return true;
        }),
        abort: vi.fn(),
      },
    };

    await runTrackedMutation({
      tracking,
      files: ["/outside/source.txt", "/outside/destination.txt"],
      mutate: async () => { order.push("mutate"); },
    });

    expect(order).toEqual([
      "prepare:/outside/source.txt,/outside/destination.txt",
      "mutate",
      "commit",
    ]);
    expect(tracking.transport.commit).toHaveBeenCalledWith("ses_last_focused", reservation);
  });

  it("aborts the prepared group when filesystem work fails", async () => {
    const tracking = {
      sessionID: "ses_last_focused",
      transport: {
        prepare: vi.fn(async () => reservation),
        commit: vi.fn(async () => true),
        abort: vi.fn(async () => true),
      },
    };

    await expect(runTrackedMutation({
      tracking,
      files: ["/outside/source.txt"],
      mutate: async () => { throw new Error("disk failed"); },
    })).rejects.toThrow("disk failed");

    expect(tracking.transport.abort).toHaveBeenCalledWith("ses_last_focused", reservation);
    expect(tracking.transport.commit).not.toHaveBeenCalled();
  });

  it("keeps a successful filesystem operation when prepare is rejected", async () => {
    const mutate = vi.fn(async () => "written");
    const tracking = {
      sessionID: "ses_focused",
      transport: {
        prepare: vi.fn(async () => undefined),
        commit: vi.fn(),
        abort: vi.fn(),
      },
    };

    await expect(runTrackedMutation({ tracking, files: ["/outside/file.txt"], mutate })).resolves.toBe("written");
    expect(mutate).toHaveBeenCalledOnce();
    expect(tracking.transport.commit).not.toHaveBeenCalled();
    expect(tracking.transport.abort).not.toHaveBeenCalled();
  });

  it("retries the same group once and aborts best-effort without undoing a successful mutation", async () => {
    const tracking = {
      sessionID: "ses_focused",
      transport: {
        prepare: vi.fn(async () => reservation),
        commit: vi.fn(async () => false),
        abort: vi.fn(async () => true),
      },
    };

    await expect(runTrackedMutation({
      tracking,
      files: ["/outside/source.txt", "/outside/destination.txt"],
      mutate: async () => "moved",
    })).resolves.toBe("moved");

    expect(tracking.transport.commit).toHaveBeenCalledTimes(2);
    expect(tracking.transport.commit).toHaveBeenNthCalledWith(1, "ses_focused", reservation);
    expect(tracking.transport.commit).toHaveBeenNthCalledWith(2, "ses_focused", reservation);
    expect(tracking.transport.abort).toHaveBeenCalledWith("ses_focused", reservation);
  });
});
