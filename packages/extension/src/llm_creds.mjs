// ============================================================================
// 0.3 — the LLM-provider SIGNAL: the one configured / missing / which-provider
// determination shared by the healthcheck and the chat-not-ready gate (Q129).
//
// amico does NOT store or inject the credential. opencode owns the secret
// (its own env / ~/.config/opencode / auth.json); amico only asks opencode —
// via its live GET /config/providers — whether a provider resolves in the
// environment the server actually booted with. A live query is authoritative
// per-environment: the chat gate hits the running extension server (VS Code's
// env), the healthcheck hits its own boot (shell env), each correct for its
// context. (We will own the credential when we replace opencode — noted seam
// D-future; not built now. If GUI-launch env fragility is ever demonstrated, a
// thin SecretStorage→env shim slots in here — but only then.)
//
// SECURITY: opencode's /config/providers includes the plaintext provider key
// for env-sourced providers. `stripProviders` discards everything but
// {id, source} at the parse boundary, and nothing downstream returns or logs a
// key — so the secret never enters amico's surfaces (no run-dir leak possible:
// amico never holds the value).
// ============================================================================

/**
 * PURE signal. `providers` = the stripped /config/providers entries
 * (`[{id, source}, …]`, key-free); `model` = opencode's configured model
 * ("provider/id") or undefined.
 *   ok:  { ok:true, provider, source }
 *   not: { ok:false, reason, fix }   (one explicit signal — never a silent hang)
 */
export function resolveLlmCreds({ providers, model }) {
  const list = Array.isArray(providers) ? providers.filter((p) => p && p.id) : [];
  if (list.length === 0) {
    return {
      ok: false,
      reason: "LLM creds not configured (opencode resolves no provider)",
      fix: "give opencode a provider credential — a provider API key in the env (e.g. ANTHROPIC_API_KEY) or via ~/.config/opencode (RUNBOOK §4)",
    };
  }
  // A configured model selects which provider chat uses; if set, that provider
  // must be among the resolved ones (else chat picks an unresolved provider and
  // fails at the box — the mismatch case).
  if (typeof model === "string" && model.includes("/")) {
    const want = model.split("/")[0];
    const hit = list.find((p) => p.id === want);
    if (!hit) {
      return {
        ok: false,
        reason: `opencode model provider "${want}" has no resolved credentials (resolved: ${list.map((p) => p.id).join(", ")})`,
        fix: "set creds for that provider, or point the opencode model at a resolved one (RUNBOOK §4)",
      };
    }
    return { ok: true, provider: hit.id, source: hit.source };
  }
  const first = list[0];
  return { ok: true, provider: first.id, source: first.source };
}

/**
 * Strip the raw /config/providers JSON to the key-free {id, source} list the
 * signal needs. THE no-leak boundary — the only place the raw response (which
 * carries provider keys) is touched; nothing but {id, source} escapes.
 */
export function stripProviders(providersJson) {
  const arr =
    providersJson && Array.isArray(providersJson.providers) ? providersJson.providers : [];
  return arr
    .map((p) => ({ id: p && p.id, source: p && p.source }))
    .filter((p) => typeof p.id === "string" && p.id.length > 0);
}

/**
 * Async: query a RUNNING opencode server for the provider signal. Fetches
 * /config/providers (stripped) + /config (model), then the pure resolveLlmCreds.
 * Used by the chat-not-ready gate (the live extension server) and the boot
 * probe. A fetch failure yields a not-ok signal (server unreachable) rather
 * than throwing. `fetchImpl` is injectable so the signal is unit-testable
 * without a live server.
 */
export async function fetchProviderSignal(baseUrl, { fetchImpl = fetch, timeoutMs = 4000 } = {}) {
  const base = String(baseUrl).replace(/\/$/, "");
  const getJson = async (path) => {
    const r = await fetchImpl(`${base}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) throw new Error(`${path} → ${r.status}`);
    return await r.json();
  };
  let providers;
  try {
    providers = stripProviders(await getJson("/config/providers"));
  } catch (e) {
    return {
      ok: false,
      reason: `could not query opencode /config/providers (${String((e && e.message) || e).slice(0, 60)})`,
      fix: "check the opencode server is up (see the 'Amicode — opencode' output channel)",
    };
  }
  let model;
  try {
    const cfg = await getJson("/config");
    model = typeof cfg.model === "string" ? cfg.model : undefined;
  } catch {
    model = undefined; // model is optional — absence just skips the mismatch check
  }
  return resolveLlmCreds({ providers, model });
}
