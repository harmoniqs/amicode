// AMICODE SERVICE wiring (#451, M1) — boot the extension-host amicode service
// at activation, alongside the fork opencode server (the parallel-run harness:
// both serve the amicode route surface; consumers stay on the fork until the
// M3 cutover, while the contract tests + dogfood probes hold the port to
// parity).
//
// vscode-free on purpose (the log sink is a structural interface, mirroring
// the service's own discipline) so the boot/lifecycle logic is unit-testable.
//
// Lifecycle notes:
//  - The service is STATELESS across requests (every route reads state at call
//    time via env overrides — same contract as the fork's routes), so unlike
//    the opencode server it needs NO restart on solver-mode switches, config
//    re-preps, or telemetry flips. One boot per activation; dispose stops it.
//  - The password is the service's OWN per-boot mint (server_auth idiom) —
//    deliberately NOT the opencode server's: the two surfaces have separate
//    consumers, and a credential shared with the spawn env would let anything
//    that can read the terminal env hit the chat server's routes too.
import { createAmicodeService } from "./amicode_service";
import type { AmicodeServiceServer } from "./amicode_service/server";

/** What consumers (terminal env, future iframe auth, dogfood probes) need. */
export interface AmicodeServiceHandle {
  url: string;
  authHeader: string;
}

export interface AmicodeServiceBoot extends AmicodeServiceHandle {
  service: AmicodeServiceServer;
}

/**
 * Boot the amicode service on an ephemeral loopback port. Never throws past
 * activation wiring: a boot failure is logged and returns undefined — the
 * extension must keep working with the fork server alone (parallel-run means
 * the service is additive, never load-bearing, until the M3 cutover).
 */
export async function startAmicodeService(log: {
  appendLine(line: string): void;
}): Promise<AmicodeServiceBoot | undefined> {
  try {
    const service = createAmicodeService();
    const url = await service.start();
    log.appendLine(
      `[amicode-service] parallel-run: listening on ${url.toString()} (${service.routeCount} routes; auth: per-boot Basic)`,
    );
    return { service, url: url.toString().replace(/\/$/, ""), authHeader: service.authHeader };
  } catch (err) {
    log.appendLine(`[amicode-service] boot FAILED (continuing without it): ${err}`);
    return undefined;
  }
}

/** Dispose wiring for ctx.subscriptions. */
export function amicodeServiceDisposal(boot: AmicodeServiceBoot | undefined): { dispose(): void } {
  return {
    dispose() {
      void boot?.service.stop().catch(() => undefined);
    },
  };
}
