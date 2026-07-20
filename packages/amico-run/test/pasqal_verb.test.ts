// packages/amico-run/test/pasqal_verb.test.ts — the `amico pasqal` device path
// (issue #160). The safety-critical surface:
//   - it reads device list + connection status ONLY from the non-secret
//     connections cache ($AMICODE_CONNECTIONS_FILE), NEVER the token file;
//   - a NON-FREE (paid emulator / real QPU) submission is refused unless an
//     explicit --confirm matches the computed submission digest (AC5);
//   - no token ever appears in the digest, the JSON output, or the launcher
//     argv (AC3) — the verb spawns the amico-pasqal launcher as a subprocess,
//     so the verb process never even opens ~/.amico/pasqal.json.
// The launcher spawn is an injectable seam: no real Python / Pasqal cloud is
// ever touched here.
import { describe, it, expect } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpRoot } from "./helpers.js";
import {
  classifyDeviceTier,
  connectionsCacheFile,
  readDevicePathStatus,
  submissionDigest,
} from "../src/pasqal_devices.js";
import { pasqalVerb } from "../src/pasqal_verb.js";

const POISON_TOKEN = "tok-P0ison-must-never-appear-anywhere";
const PROJECT = "proj-11111111-2222-3333-4444-555555555555";

/** Write a connections.json cache with a pasqal-cloud entry. */
function cacheFile(dir: string, pasqal: Record<string, unknown> | null): string {
  const p = join(dir, "connections.json");
  const body: Record<string, unknown> = {};
  if (pasqal) body["pasqal-cloud"] = pasqal;
  writeFileSync(p, JSON.stringify(body, null, 2) + "\n");
  return p;
}

/** A poison token file the SELECTION surface must never read. */
function poisonTokenFile(dir: string): string {
  const p = join(dir, "pasqal.json");
  writeFileSync(p, JSON.stringify({ project_id: PROJECT, token: POISON_TOKEN }) + "\n");
  return p;
}

const FRESH = "2026-07-20T00:00:00Z";
const NOW = Date.parse("2026-07-20T01:00:00Z"); // 1h after FRESH → not stale
const STALE_VALIDATED = "2026-07-18T00:00:00Z"; // >24h before NOW → stale

/** A connected cache entry with a free + a non-free device. */
function connectedPasqal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    state: "connected",
    identity: PROJECT,
    validated_at: FRESH,
    devices: [{ name: "EMU_FREE" }, { name: "EMU_MPS" }, { name: "FRESNEL" }],
    ...overrides,
  };
}

/** Recording spawn seam — captures argv, never actually spawns. */
function recordingSpawn(code = 0): { calls: string[][]; spawn: (argv: string[]) => Promise<{ code: number }> } {
  const calls: string[][] = [];
  return {
    calls,
    spawn: async (argv: string[]) => {
      calls.push(argv);
      return { code };
    },
  };
}

function pulseFile(dir: string, body = "schema_version = 1\n"): string {
  const p = join(dir, "pulse.toml");
  writeFileSync(p, body);
  return p;
}

// ── classifyDeviceTier ────────────────────────────────────────────────────────
describe("classifyDeviceTier — default-deny", () => {
  it("only EMU_FREE is free; everything else is non-free (case-insensitive)", () => {
    expect(classifyDeviceTier("EMU_FREE")).toBe("free");
    expect(classifyDeviceTier("emu_free")).toBe("free");
    expect(classifyDeviceTier("EMU_MPS")).toBe("non-free");
    expect(classifyDeviceTier("EMU_TN")).toBe("non-free");
    expect(classifyDeviceTier("FRESNEL")).toBe("non-free");
    expect(classifyDeviceTier("SOME_FUTURE_DEVICE")).toBe("non-free");
    expect(classifyDeviceTier("")).toBe("non-free");
  });
});

// ── connectionsCacheFile ──────────────────────────────────────────────────────
describe("connectionsCacheFile", () => {
  it("honors $AMICODE_CONNECTIONS_FILE, else ~/.amico/connections.json", () => {
    expect(connectionsCacheFile({ AMICODE_CONNECTIONS_FILE: "/x/y.json" } as NodeJS.ProcessEnv)).toBe("/x/y.json");
    expect(connectionsCacheFile({} as NodeJS.ProcessEnv)).toMatch(/\.amico\/connections\.json$/);
  });
});

// ── readDevicePathStatus (AC4) ────────────────────────────────────────────────
describe("readDevicePathStatus — AC4 distinct actionable states", () => {
  it("connected + fresh + devices → ok with classified device tiers", () => {
    const dir = tmpRoot();
    const file = cacheFile(dir, connectedPasqal());
    const status = readDevicePathStatus({ file, now: NOW });
    expect(status.ok).toBe(true);
    expect(status.block).toBeUndefined();
    expect(status.identity).toBe(PROJECT);
    const byId = Object.fromEntries(status.devices.map((d) => [d.id, d.tier]));
    expect(byId).toEqual({ EMU_FREE: "free", EMU_MPS: "non-free", FRESNEL: "non-free" });
  });

  it("no cache entry → not-connected (reconnect)", () => {
    const dir = tmpRoot();
    const file = cacheFile(dir, null);
    const status = readDevicePathStatus({ file, now: NOW });
    expect(status.ok).toBe(false);
    expect(status.block?.kind).toBe("not-connected");
    expect(status.block?.message.toLowerCase()).toContain("connect");
  });

  it("needs-key state → not-connected (reconnect)", () => {
    const dir = tmpRoot();
    const file = cacheFile(dir, { state: "needs-key" });
    const status = readDevicePathStatus({ file, now: NOW });
    expect(status.block?.kind).toBe("not-connected");
  });

  it("state expired → expired (reconnect/revalidate)", () => {
    const dir = tmpRoot();
    const file = cacheFile(dir, connectedPasqal({ state: "expired" }));
    const status = readDevicePathStatus({ file, now: NOW });
    expect(status.ok).toBe(false);
    expect(status.block?.kind).toBe("expired");
    expect(status.block?.message.toLowerCase()).toMatch(/reconnect|revalidate/);
  });

  it("connected but expires_at in the past → expired", () => {
    const dir = tmpRoot();
    const file = cacheFile(dir, connectedPasqal({ expires_at: "2020-01-01T00:00:00Z" }));
    const status = readDevicePathStatus({ file, now: NOW });
    expect(status.block?.kind).toBe("expired");
  });

  it("connected but empty device list → no-devices (revalidate)", () => {
    const dir = tmpRoot();
    const file = cacheFile(dir, connectedPasqal({ devices: [] }));
    const status = readDevicePathStatus({ file, now: NOW });
    expect(status.ok).toBe(false);
    expect(status.block?.kind).toBe("no-devices");
    expect(status.block?.message.toLowerCase()).toContain("reconnect");
  });

  it("connected + devices but stale validated_at → stale-devices (revalidate)", () => {
    const dir = tmpRoot();
    const file = cacheFile(dir, connectedPasqal({ validated_at: STALE_VALIDATED }));
    const status = readDevicePathStatus({ file, now: NOW });
    expect(status.ok).toBe(false);
    expect(status.block?.kind).toBe("stale-devices");
    expect(status.block?.message.toLowerCase()).toContain("revalidate");
  });

  it("a poison token key in the cache is never surfaced (whitelist read)", () => {
    const dir = tmpRoot();
    const file = cacheFile(dir, connectedPasqal({ token: POISON_TOKEN }));
    const status = readDevicePathStatus({ file, now: NOW });
    expect(JSON.stringify(status)).not.toContain(POISON_TOKEN);
  });
});

// ── submissionDigest (AC3/AC5) ────────────────────────────────────────────────
describe("submissionDigest — secret-free + binds to what is submitted", () => {
  it("carries no token and binds the confirm to device + pulse content", () => {
    const a = submissionDigest({ deviceId: "EMU_MPS", tier: "non-free", pulseSha256: "aaaa", projectId: PROJECT });
    const b = submissionDigest({ deviceId: "EMU_MPS", tier: "non-free", pulseSha256: "bbbb", projectId: PROJECT });
    const c = submissionDigest({ deviceId: "FRESNEL", tier: "non-free", pulseSha256: "aaaa", projectId: PROJECT });
    expect(a.confirm).not.toBe(b.confirm); // different pulse → different confirm
    expect(a.confirm).not.toBe(c.confirm); // different device → different confirm
    expect(a.text + a.confirm).not.toContain(POISON_TOKEN);
    expect(a.confirm).toMatch(/^[0-9a-f]{8,}$/);
  });
});

// ── pasqal devices verb ───────────────────────────────────────────────────────
describe("amico pasqal devices", () => {
  it("lists devices from the cache with tiers", async () => {
    const dir = tmpRoot();
    const env = { AMICODE_CONNECTIONS_FILE: cacheFile(dir, connectedPasqal()) } as NodeJS.ProcessEnv;
    const res = await pasqalVerb(["devices"], { env, now: NOW });
    expect(res.code).toBe(0);
    const j = res.json as { ok: boolean; devices: { id: string; tier: string }[] };
    expect(j.ok).toBe(true);
    expect(j.devices.map((d) => d.id)).toContain("EMU_FREE");
  });

  it("blocked connection surfaces the actionable block, code 64", async () => {
    const dir = tmpRoot();
    const env = { AMICODE_CONNECTIONS_FILE: cacheFile(dir, { state: "needs-key" }) } as NodeJS.ProcessEnv;
    const res = await pasqalVerb(["devices"], { env, now: NOW });
    expect(res.code).toBe(64);
    expect((res.json as { block: { kind: string } }).block.kind).toBe("not-connected");
  });
});

// ── pasqal submit — gate + wiring ─────────────────────────────────────────────
describe("amico pasqal submit — free path", () => {
  it("FREE device submits through the launcher with no --confirm and no --yes", async () => {
    const dir = tmpRoot();
    const pulse = pulseFile(dir);
    const rec = recordingSpawn(0);
    const env = {
      AMICODE_CONNECTIONS_FILE: cacheFile(dir, connectedPasqal()),
      AMICO_PASQAL_CONNECTOR: join(dir, "submit.py"),
    } as NodeJS.ProcessEnv;
    writeFileSync(join(dir, "submit.py"), "# connector\n");
    const res = await pasqalVerb(["submit", "--device", "EMU_FREE", "--artifact", pulse], {
      env,
      now: NOW,
      spawn: rec.spawn,
    });
    expect(res.code).toBe(0);
    expect(rec.calls.length).toBe(1);
    const argv = rec.calls[0];
    expect(argv).toContain("--device");
    expect(argv).toContain("EMU_FREE");
    expect(argv).not.toContain("--yes"); // free needs no ack
  });

  it("requires --device and --artifact (never auto-selects)", async () => {
    const dir = tmpRoot();
    const rec = recordingSpawn();
    const env = { AMICODE_CONNECTIONS_FILE: cacheFile(dir, connectedPasqal()) } as NodeJS.ProcessEnv;
    const res = await pasqalVerb(["submit", "--artifact", pulseFile(dir)], { env, now: NOW, spawn: rec.spawn });
    expect(res.code).toBe(64);
    expect(rec.calls.length).toBe(0);
  });
});

describe("amico pasqal submit — NON-FREE confirm gate (AC5)", () => {
  it("refuses a non-free submission WITHOUT --confirm and does NOT spawn", async () => {
    const dir = tmpRoot();
    const pulse = pulseFile(dir);
    const rec = recordingSpawn();
    const env = {
      AMICODE_CONNECTIONS_FILE: cacheFile(dir, connectedPasqal()),
      AMICO_PASQAL_CONNECTOR: join(dir, "submit.py"),
    } as NodeJS.ProcessEnv;
    writeFileSync(join(dir, "submit.py"), "# connector\n");
    const res = await pasqalVerb(["submit", "--device", "EMU_MPS", "--artifact", pulse], {
      env,
      now: NOW,
      spawn: rec.spawn,
    });
    expect(res.code).toBe(64);
    expect(rec.calls.length).toBe(0); // NOTHING spawned
    const j = res.json as { confirm_required: boolean; digest: { confirm: string; text: string } };
    expect(j.confirm_required).toBe(true);
    expect(j.digest.confirm).toMatch(/^[0-9a-f]{8,}$/);
  });

  it("refuses a non-free submission with a WRONG --confirm and does NOT spawn", async () => {
    const dir = tmpRoot();
    const pulse = pulseFile(dir);
    const rec = recordingSpawn();
    const env = {
      AMICODE_CONNECTIONS_FILE: cacheFile(dir, connectedPasqal()),
      AMICO_PASQAL_CONNECTOR: join(dir, "submit.py"),
    } as NodeJS.ProcessEnv;
    writeFileSync(join(dir, "submit.py"), "# connector\n");
    const res = await pasqalVerb(["submit", "--device", "EMU_MPS", "--artifact", pulse, "--confirm", "deadbeef"], {
      env,
      now: NOW,
      spawn: rec.spawn,
    });
    expect(res.code).toBe(64);
    expect(rec.calls.length).toBe(0);
  });

  it("proceeds only with the CORRECT --confirm, spawning with --yes", async () => {
    const dir = tmpRoot();
    const pulse = pulseFile(dir);
    const rec = recordingSpawn(0);
    const env = {
      AMICODE_CONNECTIONS_FILE: cacheFile(dir, connectedPasqal()),
      AMICO_PASQAL_CONNECTOR: join(dir, "submit.py"),
    } as NodeJS.ProcessEnv;
    writeFileSync(join(dir, "submit.py"), "# connector\n");
    // First call: obtain the digest.
    const first = await pasqalVerb(["submit", "--device", "EMU_MPS", "--artifact", pulse], {
      env,
      now: NOW,
      spawn: rec.spawn,
    });
    const confirm = (first.json as { digest: { confirm: string } }).digest.confirm;
    // Second call: echo it back.
    const res = await pasqalVerb(["submit", "--device", "EMU_MPS", "--artifact", pulse, "--confirm", confirm], {
      env,
      now: NOW,
      spawn: rec.spawn,
    });
    expect(res.code).toBe(0);
    expect(rec.calls.length).toBe(1); // only the confirmed submit spawned
    expect(rec.calls[0]).toContain("--yes");
    expect(rec.calls[0]).toContain("EMU_MPS");
  });

  it("--dry-run never bypasses the non-free gate", async () => {
    const dir = tmpRoot();
    const pulse = pulseFile(dir);
    const rec = recordingSpawn();
    const env = {
      AMICODE_CONNECTIONS_FILE: cacheFile(dir, connectedPasqal()),
      AMICO_PASQAL_CONNECTOR: join(dir, "submit.py"),
    } as NodeJS.ProcessEnv;
    writeFileSync(join(dir, "submit.py"), "# connector\n");
    const res = await pasqalVerb(["submit", "--device", "FRESNEL", "--artifact", pulse, "--dry-run"], {
      env,
      now: NOW,
      spawn: rec.spawn,
    });
    expect(res.code).toBe(64); // gate first
    expect(rec.calls.length).toBe(0);
  });

  it("a blocked connection refuses submit before any gate/spawn (AC4)", async () => {
    const dir = tmpRoot();
    const pulse = pulseFile(dir);
    const rec = recordingSpawn();
    const env = {
      AMICODE_CONNECTIONS_FILE: cacheFile(dir, connectedPasqal({ state: "expired" })),
    } as NodeJS.ProcessEnv;
    const res = await pasqalVerb(["submit", "--device", "EMU_FREE", "--artifact", pulse], {
      env,
      now: NOW,
      spawn: rec.spawn,
    });
    expect(res.code).toBe(64);
    expect(rec.calls.length).toBe(0);
    expect((res.json as { block: { kind: string } }).block.kind).toBe("expired");
  });

  it("a device not in the connection's list is refused (no spawn)", async () => {
    const dir = tmpRoot();
    const pulse = pulseFile(dir);
    const rec = recordingSpawn();
    const env = { AMICODE_CONNECTIONS_FILE: cacheFile(dir, connectedPasqal()) } as NodeJS.ProcessEnv;
    const res = await pasqalVerb(["submit", "--device", "NOT_A_DEVICE", "--artifact", pulse], {
      env,
      now: NOW,
      spawn: rec.spawn,
    });
    expect(res.code).toBe(64);
    expect(rec.calls.length).toBe(0);
  });

  it("a missing pulse file is refused (no spawn)", async () => {
    const dir = tmpRoot();
    const rec = recordingSpawn();
    const env = { AMICODE_CONNECTIONS_FILE: cacheFile(dir, connectedPasqal()) } as NodeJS.ProcessEnv;
    const res = await pasqalVerb(["submit", "--device", "EMU_FREE", "--artifact", join(dir, "nope.toml")], {
      env,
      now: NOW,
      spawn: rec.spawn,
    });
    expect(res.code).toBe(64);
    expect(rec.calls.length).toBe(0);
  });
});

// ── AC3 token safety across the whole surface ─────────────────────────────────
describe("amico pasqal — token safety (AC3)", () => {
  it("never reads the token file, and no token appears in output or launcher argv", async () => {
    const dir = tmpRoot();
    const pulse = pulseFile(dir);
    const rec = recordingSpawn(0);
    // Plant a poison token file that the selection surface must NEVER open.
    const tokenFile = poisonTokenFile(dir);
    writeFileSync(join(dir, "submit.py"), "# connector\n");
    const env = {
      AMICODE_CONNECTIONS_FILE: cacheFile(dir, connectedPasqal({ token: POISON_TOKEN })),
      AMICO_PASQAL_FILE: tokenFile, // the launcher would read this; the verb must not
      AMICO_PASQAL_CONNECTOR: join(dir, "submit.py"),
    } as NodeJS.ProcessEnv;

    const devices = await pasqalVerb(["devices"], { env, now: NOW });
    expect(JSON.stringify(devices.json)).not.toContain(POISON_TOKEN);

    // Free submit: it spawns the launcher; the argv must carry no token.
    const free = await pasqalVerb(["submit", "--device", "EMU_FREE", "--artifact", pulse], {
      env,
      now: NOW,
      spawn: rec.spawn,
    });
    expect(free.code).toBe(0);
    expect(JSON.stringify(free.json)).not.toContain(POISON_TOKEN);
    expect(JSON.stringify(rec.calls)).not.toContain(POISON_TOKEN);

    // Non-free digest: the digest the user must confirm carries no token.
    const nonfree = await pasqalVerb(["submit", "--device", "EMU_MPS", "--artifact", pulse], {
      env,
      now: NOW,
      spawn: rec.spawn,
    });
    expect(JSON.stringify(nonfree.json)).not.toContain(POISON_TOKEN);
  });
});
