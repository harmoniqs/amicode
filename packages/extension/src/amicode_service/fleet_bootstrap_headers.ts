// FLEET BOOTSTRAP HEADER CARRIERS (#1480, ADR 0034).
//
// The #1475 trust audit found the #1438 enrollment nonce URL-carried — a
// bootstrap secret in a query string leaks into access logs, the Referer
// header, browser history, and error/telemetry strings that echo a URL. The
// fix for the Observe bootstrap path is to move the nonce (and the requesting
// identity_key it is bound to) OFF the URL and onto REQUEST HEADERS, which are
// not part of the logged request-line and are not carried by Referer.
//
// A tiny standalone module so BOTH the accept-set boundary (server.ts, which
// reads the headers to authenticate the bound mint endpoint) and the mint
// handler (fleet_mint_route.ts, which reads them to consume the bound nonce)
// name the SAME header keys with no circular import between them.

/** The header carrying the single-use bound enrollment nonce (AC1: off-URL). */
export const BOUND_NONCE_HEADER = "x-amico-enrollment-nonce";

/** The header carrying the requesting peer's stable identity_key fingerprint
 *  (#1477) — the nonce is bound to (target, this identity), so a nonce
 *  presented with a different identity is refused (AC2). */
export const BOUND_IDENTITY_HEADER = "x-amico-identity-key";
