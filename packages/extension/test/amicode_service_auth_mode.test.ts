// Amicode-service auth mode (#955, the hub cutover): the fork hub serves
// ANONYMOUS on the tunnel/LAN boundary — the canonical /session answers 200
// anonymous, the SSH mesh IS the security boundary, and the fleet clients
// ride tunnels without credentials. The service replacing it must match that
// posture or the fleet panel 401s at the shelf. THIS file pins the
// auth-optional mode: `AMICODE_SERVICE_AUTH=open` (or the `authMode` opt)
// stops REQUIRING a credential on every path — while a PRESENT mint (the
// framed app's engine credential) keeps working untouched. Default stays
// `credential`: zero behavior change for every existing caller.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import { createAmicodeService, type AmicodeServiceServer } from "../src/amicode_service";
import { serverAuthToken } from "../src/server_auth";

/** The mock engine (the bootstrap-auth test's harness shape): /session answers JSON. */
async function startMockEngine(): Promise<{ url: string; stop(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url?.startsWith("/session")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, engine: true }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "not found" }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, stop: () => new Promise<void>((r) => server.close(() => r())) };
}

/** Boot a service, run one request against it, stop — authMode is fixed at
 *  construction, so per-case boots keep each assertion self-contained. */
async function withService<T>(
  opts: Parameters<typeof createAmicodeService>[0],
  engineUrl: string,
  fn: (service: AmicodeServiceServer, base: string) => Promise<T>,
): Promise<T> {
  // The helper's late-bound engine getter merges with (never clobbers) the
  // case's own engine opts — a case may arm the engine mint beside it.
  const service = createAmicodeService({
    ...opts,
    engine: { getUrl: () => engineUrl, ...opts.engine },
  });
  const base = (await service.start()).toString().replace(/\/$/, "");
  try {
    return await fn(service, base);
  } finally {
    await service.stop();
  }
}

describe("amicode service — auth mode (#955, the open-boundary posture)", () => {
  let engine: Awaited<ReturnType<typeof startMockEngine>>;
  let engineToken: string;

  beforeAll(async () => {
    engine = await startMockEngine();
    engineToken = serverAuthToken("engine-mint-password");
  });

  afterAll(async () => {
    await engine.stop();
  });

  describe("open mode (the tunnel/LAN posture)", () => {
    // The deployment fact #955's audit pinned: the fork hub's canonical
    // /session answers 200 ANONYMOUS behind the tunnel. The service must too.
    it("an anonymous GET /session proxies 200 (the canonical anonymous answer)", async () => {
      await withService({ authMode: "open" }, engine.url, async (_s, base) => {
        const r = await fetch(`${base}/session`);
        expect(r.status).toBe(200);
        expect(((await r.json()) as { engine?: boolean }).engine).toBe(true);
      });
    });

    it("an anonymous GET on a protected /amicode/* route answers 200", async () => {
      await withService({ authMode: "open" }, engine.url, async (_s, base) => {
        const r = await fetch(`${base}/amicode/profile`);
        expect(r.status).toBe(200);
        expect(((await r.json()) as { ok?: boolean }).ok).toBe(true);
      });
    });

    it("an unmatched /amicode/* path answers the route-table 404 — open covers ALL paths, never a 401", async () => {
      await withService({ authMode: "open" }, engine.url, async (_s, base) => {
        const r = await fetch(`${base}/amicode/no-such-route`);
        expect(r.status).toBe(404);
      });
    });

    it("a PRESENT mint keeps working: the engine Basic credential rides open mode untouched", async () => {
      await withService(
        { authMode: "open", engine: { password: "engine-mint-password" } },
        engine.url,
        async (_s, base) => {
          const r = await fetch(`${base}/session`, {
            headers: { Authorization: `Basic ${engineToken}` },
          });
          expect(r.status).toBe(200);
          expect(((await r.json()) as { engine?: boolean }).engine).toBe(true);
        },
      );
    });
  });

  describe("credential mode (the default — zero behavior change)", () => {
    it("the default is credential: an anonymous protected GET 401s with no authMode opt and no env", async () => {
      const prev = process.env.AMICODE_SERVICE_AUTH;
      delete process.env.AMICODE_SERVICE_AUTH;
      try {
        await withService({}, engine.url, async (_s, base) => {
          const r = await fetch(`${base}/amicode/profile`);
          expect(r.status).toBe(401);
        });
      } finally {
        if (prev !== undefined) process.env.AMICODE_SERVICE_AUTH = prev;
      }
    });

    it("an explicit authMode: \"credential\" behaves identically (401 anonymous)", async () => {
      await withService({ authMode: "credential" }, engine.url, async (_s, base) => {
        const r = await fetch(`${base}/amicode/profile`);
        expect(r.status).toBe(401);
      });
    });

    it("credential mode still accepts the engine mint (the framed app's path)", async () => {
      await withService(
        { authMode: "credential", engine: { password: "engine-mint-password" } },
        engine.url,
        async (_s, base) => {
          const r = await fetch(`${base}/session`, {
            headers: { Authorization: `Basic ${engineToken}` },
          });
          expect(r.status).toBe(200);
        },
      );
    });
  });

  describe("the AMICODE_SERVICE_AUTH env (the runner's passthrough surface)", () => {
    it("AMICODE_SERVICE_AUTH=open boots the service open (anonymous 200)", async () => {
      const prev = process.env.AMICODE_SERVICE_AUTH;
      process.env.AMICODE_SERVICE_AUTH = "open";
      try {
        await withService({}, engine.url, async (_s, base) => {
          const r = await fetch(`${base}/amicode/profile`);
          expect(r.status).toBe(200);
        });
      } finally {
        if (prev !== undefined) process.env.AMICODE_SERVICE_AUTH = prev;
        else delete process.env.AMICODE_SERVICE_AUTH;
      }
    });

    it("any other env value is the credential default (fail closed, 401 anonymous)", async () => {
      const prev = process.env.AMICODE_SERVICE_AUTH;
      process.env.AMICODE_SERVICE_AUTH = "off";
      try {
        await withService({}, engine.url, async (_s, base) => {
          const r = await fetch(`${base}/amicode/profile`);
          expect(r.status).toBe(401);
        });
      } finally {
        if (prev !== undefined) process.env.AMICODE_SERVICE_AUTH = prev;
        else delete process.env.AMICODE_SERVICE_AUTH;
      }
    });

    it("an explicit opts.authMode wins over the env (the caller's explicit choice)", async () => {
      const prev = process.env.AMICODE_SERVICE_AUTH;
      process.env.AMICODE_SERVICE_AUTH = "open";
      try {
        await withService({ authMode: "credential" }, engine.url, async (_s, base) => {
          const r = await fetch(`${base}/amicode/profile`);
          expect(r.status).toBe(401);
        });
      } finally {
        if (prev !== undefined) process.env.AMICODE_SERVICE_AUTH = prev;
        else delete process.env.AMICODE_SERVICE_AUTH;
      }
    });
  });

  describe("the boot log records the mode", () => {
    it("authMode is exposed for the wiring's log line", async () => {
      await withService({ authMode: "open" }, engine.url, async (service) => {
        expect(service.authMode).toBe("open");
      });
      await withService({}, engine.url, async (service) => {
        expect(service.authMode).toBe("credential");
      });
    });
  });
});
