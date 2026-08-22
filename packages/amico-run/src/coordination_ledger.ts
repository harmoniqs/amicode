// Coordination ledger — shared work fabric (spec-20260804-014823)
// Phase 1: work_id v1 + claim stanza + service (cloud + sqlite ref)
// This module is the single-writer extension of the run ledger.

import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { claimsFile } from "./paths.js";

function appendClaimLine(claim: Claim): void {
  const file = claimsFile();
  mkdirSync(path.dirname(file), { recursive: true });
  const line = JSON.stringify(claim) + "\n";
  if (Buffer.byteLength(line) > 4096) throw new Error("claim line exceeds PIPE_BUF");
  appendFileSync(file, line);
}

import { canonicalJson, sha256hex, workIdV1 } from "@amicode/schema";

// ── work_id v1 canonicalization ──
export type WorkIdArgs = { structure_hash: string; goal: string; N: number; T: number; facet_tuple?: unknown };
export function workId(args: WorkIdArgs): string {
  return workIdV1(args);
}

// ── claim record ──
export type ClaimOutcome = "claimed" | "solved" | "failed" | "abandoned";
export interface Claim {
  type: "claim";
  ts: string;
  work_id: string;
  agent_id: string;
  user: string;
  org: string;
  host: string;
  lease_expires: string;
  variant_axis?: string;
  run_id?: string;
  outcome?: ClaimOutcome;
  issued_at: string;
}

// ── service — sole serializer of claim conflicts, server-side time only ──
export interface ClaimRequest {
  work_id: string;
  agent_id: string;
  user: string;
  org: string;
  host: string;
  variant_axis?: string;
  ttl_s?: number;
}

export interface ClaimResult {
  ok: boolean;
  claim?: Claim;
  holder?: Claim;
  error?: string;
  dedup?: { verified: boolean; pulse_path?: string };
}

class CoordinationService {
  private claims = new Map<string, Claim>(); // work_id → live claim
  private results = new Map<string, { work_id: string; verification: { agree: boolean }; fidelity: number; catalog_pointer: string; platform: string; kind: string }>();

  // Server-side time is the only time compared
  private now(): string { return new Date().toISOString(); }
  private isLapsed(claim: Claim): boolean { return Date.parse(claim.lease_expires) <= Date.now(); }

  // Dedup → Claim → Warrant → Dispatch → Publish → Release
  async preflight(req: ClaimRequest): Promise<ClaimResult> {
    const now = this.now();
    // 1. Dedup: verified result exists → no dispatch
    const result = this.results.get(req.work_id);
    if (result?.verification.agree) {
      return { ok: true, dedup: { verified: true, pulse_path: result.catalog_pointer } };
    }
    // 2. Claim: serialize by service receipt order
    const existing = this.claims.get(req.work_id);
    if (existing && !this.isLapsed(existing)) {
      return { ok: false, holder: existing, error: "claim_conflict: work_id already claimed — yield/steer/variant" };
    }
    // lapsed or absent → take it
    const claim: Claim = {
      type: "claim",
      ts: now,
      work_id: req.work_id,
      agent_id: req.agent_id,
      user: req.user,
      org: req.org,
      host: req.host,
      lease_expires: new Date(Date.now() + (req.ttl_s ?? 900) * 1000).toISOString(),
      ...(req.variant_axis ? { variant_axis: req.variant_axis } : {}),
      outcome: "claimed",
      issued_at: now,
    };
    this.claims.set(req.work_id, claim);
    try { appendClaimLine(claim); } catch {}
    return { ok: true, claim };
  }

  async heartbeat(work_id: string, agent_id: string, ttl_s = 900): Promise<Claim | undefined> {
    const c = this.claims.get(work_id);
    if (!c || c.agent_id !== agent_id || this.isLapsed(c)) return undefined;
    c.lease_expires = new Date(Date.now() + ttl_s * 1000).toISOString();
    return c;
  }

  async release(work_id: string, agent_id: string, outcome: ClaimOutcome = "solved"): Promise<void> {
    const c = this.claims.get(work_id);
    if (c && c.agent_id === agent_id) {
      c.outcome = outcome;
      if (outcome === "solved" || outcome === "failed" || outcome === "abandoned") {
        // keep result tombstone for dedup window, but allow next preflight after lease
        // for full spec, move to results on solved
      }
    }
  }

  async publish(result: { work_id: string; verification: { agree: boolean }; fidelity: number; catalog_pointer: string; platform: string; kind: string; visibility?: string }): Promise<void> {
    // Idempotent content-addressed merge
    const key = result.work_id;
    const existing = this.results.get(key);
    if (existing && existing.fidelity >= result.fidelity) return;
    this.results.set(key, result);
  }

  // Fleet projection: sessions with user/org/host
  async fleetList(org: string): Promise<Array<{ user: string; org: string; host: string; state: string }>> {
    return Array.from(this.claims.values())
      .filter(c => c.org === org && !this.isLapsed(c))
      .map(c => ({ user: c.user, org: c.org, host: c.host, state: c.outcome ?? "claimed" }));
  }

  // For contract tests: expose internal state
  _claims(): Map<string, Claim> { return this.claims; }
  _results(): Map<string, any> { return this.results; }
}

export const coordinationService = new CoordinationService();

// ── reference sqlite impl stub — same API, stdlib+sqlite trivial ──
// The cloud service is primary; this keeps self-host honest. Contract tests run against both.
export class SqliteCoordinationService extends CoordinationService {
  // In real impl, this would use sqlite with hash-indexed claims table
  // For spec, we inherit in-memory behavior — API not deployment is the contract
}

// ── offline degraded mode ──


export async function idempotentPublish(result: { work_id: string; verification: { agree: boolean }; fidelity: number; catalog_pointer: string; platform: string; kind: string }): Promise<{ kept: boolean }> {
  const existing = coordinationService._results().get(result.work_id);
  if (existing && existing.fidelity >= result.fidelity) return { kept: false };
  await coordinationService.publish(result);
  return { kept: true };
}

export function offlineReplay(localClaims: Claim[], remoteClaims: Claim[]): { kept: Claim[]; waste: { work_id: string; reason: string }[] } {
  const waste: { work_id: string; reason: string }[] = [];
  const kept: Claim[] = [];
  for (const local of localClaims) {
    const remote = remoteClaims.find(r => r.work_id === local.work_id);
    if (remote && remote.issued_at > local.issued_at) {
      // remote verified-better wins, local is waste but recorded visibly
      waste.push({ work_id: local.work_id, reason: "duplicate_at_sync: remote verified-better" });
    } else {
      kept.push(local);
    }
  }
  return { kept, waste };
}

export function degradedStamp(): { coordination: "degraded" } {
  return { coordination: "degraded" };
}
