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
  // must be among the resolved ones. When it isn't, this is a SOFT mismatch —
  // other providers ARE live, so the chat can still work (opencode falls back or
  // the in-app picker overrides). Blocking the panel on a stale model field
  // (e.g. onboarding wrote "anthropic/..." but the user later connected
  // amazon-bedrock) is worse than letting them in with a heads-up.
  if (typeof model === "string" && model.includes("/")) {
    const want = model.split("/")[0];
    const hit = list.find((p) => p.id === want);
    if (!hit) {
      const first = list[0];
      return {
        ok: true,
        provider: first.id,
        source: first.source,
        warning: `opencode model provider "${want}" has no resolved credentials (resolved: ${list.map((p) => p.id).join(", ")}) — falling back to ${first.id}`,
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
  const arr = providersJson && Array.isArray(providersJson.providers) ? providersJson.providers : [];
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
 * without a live server. `headers` carries the Basic credential for the
 * per-boot server password (#163) — without it both probes 401 once route
 * auth is armed.
 */
export async function fetchProviderSignal(baseUrl, { fetchImpl = fetch, timeoutMs = 4000, headers } = {}) {
  const base = String(baseUrl).replace(/\/$/, "");
  const getJson = async (path) => {
    const r = await fetchImpl(`${base}${path}`, { signal: AbortSignal.timeout(timeoutMs), headers });
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

/**
 * The live provider ID list (S3 model routing, amicode#860): query a running
 * opencode server's /config/providers and return the KEY-FREE provider ids
 * the engine resolves — the credential snapshot's input (the resolver's
 * uniform credential gate). Same no-leak boundary as stripProviders: only
 * ids cross. A failed query yields undefined (UNKNOWN — the resolver fails
 * safe to the default tier; it never reads unknown as "no credentials").
 */
export async function fetchProviderIds(baseUrl, { fetchImpl = fetch, timeoutMs = 4000, headers } = {}) {
  const base = String(baseUrl).replace(/\/$/, "");
  try {
    const r = await fetchImpl(`${base}/config/providers`, { signal: AbortSignal.timeout(timeoutMs), headers });
    if (!r.ok) return undefined;
    return stripProviders(await r.json()).map((p) => p.id);
  } catch {
    return undefined;
  }
}

/**
 * The live provider → model-id catalog (#1985, the model-reachability cache's
 * probe list): the same /config/providers query, stripped at the parse
 * boundary to provider ids and their model KEYS only (never a model's
 * options, never a provider key). A failed query yields undefined (UNKNOWN —
 * never an empty catalog).
 */
export async function fetchProviderModels(baseUrl, { fetchImpl = fetch, timeoutMs = 4000, headers } = {}) {
  const base = String(baseUrl).replace(/\/$/, "");
  try {
    const r = await fetchImpl(`${base}/config/providers`, { signal: AbortSignal.timeout(timeoutMs), headers });
    if (!r.ok) return undefined;
    const json = await r.json();
    const arr = json && Array.isArray(json.providers) ? json.providers : undefined;
    if (!arr) return undefined;
    const out = {};
    for (const p of arr) {
      if (!p || typeof p.id !== "string" || p.id.length === 0) continue;
      const models = p.models && typeof p.models === "object" && !Array.isArray(p.models) ? Object.keys(p.models) : [];
      out[p.id] = models.filter((m) => typeof m === "string" && m.length > 0);
    }
    return out;
  } catch {
    return undefined;
  }
}

/**
 * The FULL provider catalog (#2000, model arrivals): the engine's GET /provider
 * — every listed provider (connected or not) with its model ids and the
 * non-secret price (USD/Mtok) + context meta, plus the connected provider ids.
 * Stripped at the parse boundary to ids and those numbers only (never options,
 * never a key). A failed query yields undefined (UNKNOWN — never empty).
 */
export async function fetchProviderCatalog(baseUrl, { fetchImpl = fetch, timeoutMs = 6000, headers } = {}) {
  const base = String(baseUrl).replace(/\/$/, "");
  const finite = (n) => (typeof n === "number" && Number.isFinite(n) ? n : undefined);
  try {
    const r = await fetchImpl(`${base}/provider`, { signal: AbortSignal.timeout(timeoutMs), headers });
    if (!r.ok) return undefined;
    const json = await r.json();
    const all = json && Array.isArray(json.all) ? json.all : undefined;
    if (!all || !json || !Array.isArray(json.connected)) return undefined;
    const providers = {};
    for (const p of all) {
      if (!p || typeof p.id !== "string" || p.id.length === 0) continue;
      const models = {};
      const src = p.models && typeof p.models === "object" && !Array.isArray(p.models) ? p.models : {};
      for (const [id, m] of Object.entries(src)) {
        if (id.length === 0) continue;
        const meta = {};
        const input = finite(m?.cost?.input);
        const output = finite(m?.cost?.output);
        const context = finite(m?.limit?.context);
        if (input !== undefined) meta.input = input;
        if (output !== undefined) meta.output = output;
        if (context !== undefined) meta.context = context;
        models[id] = meta;
      }
      providers[p.id] = models;
    }
    return { connected: json.connected.filter((c) => typeof c === "string" && c.length > 0), providers };
  } catch {
    return undefined;
  }
}

/**
 * The engine's one-token reachability probe (#1984, POST /provider/probe):
 * the engine sends 1 token per model through its OWN credentials and returns
 * a named status per model — no secret crosses. The probe is bounded inside
 * the engine (10s per model, concurrency 4), so the client budget scales with
 * the batch. Failure (unreachable / non-2xx / malformed) → undefined.
 */
export async function probeProviderModels(baseUrl, providerID, modelIDs, { fetchImpl = fetch, timeoutMs, headers } = {}) {
  const base = String(baseUrl).replace(/\/$/, "");
  const budget = timeoutMs ?? Math.ceil(Math.max(1, modelIDs.length) / 4) * 10_000 + 15_000;
  try {
    const r = await fetchImpl(`${base}/provider/probe`, {
      method: "POST",
      signal: AbortSignal.timeout(budget),
      headers: { ...(headers ?? {}), "content-type": "application/json" },
      body: JSON.stringify({ providerID, modelIDs }),
    });
    if (!r.ok) return undefined;
    const json = await r.json();
    if (!json || !Array.isArray(json.results)) return undefined;
    return json;
  } catch {
    return undefined;
  }
}
