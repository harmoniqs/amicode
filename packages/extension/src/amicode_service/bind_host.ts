// AMICODE SERVICE (#451): the loopback gate shared by the vault-browser and
// credentials surfaces. isLoopbackHostname is ported VERBATIM from the fork's
// connections.ts @ v1.18.10-amicode.11 (same 127/8 + v4-mapped families); the
// bind hostname is stamped by the service at listen time (the extension-host
// service binds 127.0.0.1 by construction — the seam exists so a future
// non-loopback bind keeps the fail-closed law honest).

let bindHostname: string | undefined;

/** Stamp the bind hostname (call once, at listen). */
export function setBindHostname(host: string | undefined): void {
  bindHostname = host;
}

/** The current bind hostname — shared with the vault-browser routes, whose
 *  loopback gate rides the same signal as the credential-mutation guard. */
export function getBindHostname(): string | undefined {
  return bindHostname;
}

/** Same loopback family the mdns gate recognizes (server.ts), widened to the
 *  whole 127/8 block and the v4-mapped form. undefined = in-process handler. */
export function isLoopbackHostname(hostname: string | undefined): boolean {
  if (hostname === undefined) return true;
  const host = hostname.toLowerCase();
  if (host === "localhost" || host === "::1") return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (host.startsWith("::ffff:127.")) return true;
  return false;
}
