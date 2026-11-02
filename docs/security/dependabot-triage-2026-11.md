# Dependabot triage, 2026-11 (amicode#2075 / F2)

Scope: every **critical** and **high** Dependabot alert on `harmoniqs/amicode`. Medium and low are out of scope. Part of #2043, ADR 0039.

Every number below comes from a command run on 2026-11-02 against branch `opencode/issue-2075-dependabot`
(from `lane/0.4.1`). Raw alerts: `gh api "repos/harmoniqs/amicode/dependabot/alerts?state=open&per_page=100" --paginate`.

## Summary

| | Count | Source |
|---|---|---|
| Open alerts (all severities) | 128 | `gh api ...` (re-fetched; identical alert-number set to the director's snapshot) |
| Open critical | 13 | same |
| Open high | 54 | same |
| Critical + high alert numbers | 67 | same |
| Distinct (package, advisory) rows below | 62 | same, grouped case-insensitively by package + GHSA |
| Decision `fixed` | 58 rows | |
| Decision `dismiss` | 3 rows | |
| Decision `deferred` | 1 row | |

The issue body says "14 critical, 72 high"; the live API shows 13 critical, 54 high at triage time. The difference was
not investigated; this document triages what the API shows now.

Outcome: all 13 criticals are cleared by the changes in this branch, and 53 of the 54 highs are fixed or dismissed
with a reachability argument. **One high is deferred, not dismissed**: #7 (`@modelcontextprotocol/sdk`,
GHSA-6qxp-vccf-f47h), because the fix requires leaving the deliberately patched 1.29.0 engine pin (#2010).
Alert state itself is **not** changed by this branch; the director dismisses after review, and fixed alerts close when Dependabot rescans the merged lockfile.

## Triage table

| Package | Advisory | Sev | Alerts | Manifest(s) | Vulnerable | Patched | Decision | Change / reachability evidence |
|---|---|---|---|---|---|---|---|---|
| @azure/msal-node | GHSA-xcx6-jx8p-x3h5 | high | #186 | `pnpm-lock.yaml` | `>= 5.0.0-beta.0, < 7.1.0` | 7.1.0 | **fixed** | `@azure/identity` refreshed to 4.14.1 → msal-node 7.1.2 (via vsce) |
| @modelcontextprotocol/sdk | GHSA-22jm-h49p-29qw | high | #112 | `app-bundle/overlay/packages/opencode/package.json` | `>= 1.24.0, < 1.32.0` | 1.32.0 | **dismiss** | Only affects an HTTP server that passes `taskStore` to `McpServer`/`Server`. `grep -rIni taskStore packages/opencode/src` (engine fork) and the overlay returns nothing; the engine has no SDK server (see GHSA-46jr row). |
| @modelcontextprotocol/sdk | GHSA-46jr-4wx8-v453 | high | #115 | `app-bundle/overlay/packages/opencode/package.json` | `>= 1.3.0, < 1.32.0` | 1.32.0 | **dismiss** | Server-side only: advisory says "Am I affected? Yes, if clients you do not fully trust can reach your server over HTTP" (`McpServer`). The engine runs no SDK server: `grep -rIn "sdk/server" packages/opencode/src` in the engine fork checkout returns nothing; `sdk/server` is imported only by test fixtures (`test/mcp/*.test.ts`, `test/fixture/mcp-lifecycle-stdio.ts`, `test/tool/code-mode-integration.test.ts`), which are not shipped. The overlay `src/mcp/index.ts` imports only `client/*` and `types.js`. |
| @modelcontextprotocol/sdk | GHSA-6qxp-vccf-f47h | high | #7 | `app-bundle/overlay/packages/opencode/package.json` | `>= 1.12.0, < 1.31.0` | 1.31.0 | **deferred** | Client-side OAuth flaw: the engine **is** an MCP OAuth client (`src/mcp/index.ts` builds `McpOAuthProvider` as `authProvider` on `StreamableHTTPClientTransport`/`SSEClientTransport`), so this is reachable when a user connects to an untrusted MCP server while holding stored credentials for another authorization server. Cannot be dismissed. Fix is 1.31.0+, which requires leaving the deliberately patched 1.29.0 pin (brief rule 3); tracked by #2010 (port patch to 1.32.x, or move to `@modelcontextprotocol/client` 2.x). Exposure is limited to user-configured remote MCP servers with OAuth enabled. |
| @modelcontextprotocol/sdk | GHSA-f897-62hf-6gxq | high | #188 | `app-bundle/overlay/packages/opencode/package.json` | `>= 1.10.0, < 1.30.1` | 1.30.1 | **dismiss** | Server-side only: unbounded POST body / JSON-RPC batch on Streamable HTTP *servers*; "Servers that only use stdio are not affected". The engine has no SDK server in `src` (see GHSA-46jr row). The engine is a client of remote servers, which this advisory does not cover. |
| brace-expansion | GHSA-3jxr-9vmj-r5cp | high | #57 | `pnpm-lock.yaml` | `>= 3.0.0, < 5.0.7` | 5.0.7 | **fixed** | in-range lock refresh → 5.0.12 (via vsce → glob/minimatch) |
| brace-expansion | GHSA-6j4f-fj2g-mc7p | high | #95 | `pnpm-lock.yaml` | `>= 4.0.0, < 5.0.10` | 5.0.10 | **fixed** | in-range lock refresh → 5.0.12 (via vsce → glob/minimatch) |
| brace-expansion | GHSA-mh99-v99m-4gvg | high | #63 | `pnpm-lock.yaml` | `>= 4.0.0, < 5.0.8` | 5.0.8 | **fixed** | in-range lock refresh → 5.0.12 (via vsce → glob/minimatch) |
| brace-expansion | GHSA-qhr7-859c-m2p7 | high | #96 | `pnpm-lock.yaml` | `>= 4.0.0, < 5.0.11` | 5.0.11 | **fixed** | in-range lock refresh → 5.0.12 (via vsce → glob/minimatch) |
| brace-expansion | GHSA-rgw5-rvv9-x895 | high | #64 | `pnpm-lock.yaml` | `>= 4.0.0, < 5.0.9` | 5.0.9 | **fixed** | in-range lock refresh → 5.0.12 (via vsce → glob/minimatch) |
| certifi | GHSA-6q48-6c7w-9gw2 | critical | #187 | `requirements-freeze.txt` (pasqal-connector) | `>= 2019.03.09, < 2026.10.18` | 2026.10.18 | **fixed** | `requirements-freeze.txt` certifi 2026.7.22 → 2026.10.18 |
| happy-dom | GHSA-834v-8h66-3h79 | high | #174, #182 | `packages/extension/package.json`, `pnpm-lock.yaml` | `>= 17.0.0, <= 21.0.3` | 21.0.4 | **fixed** | extension `^20.11.1` → `^21.0.4` (locks 21.0.4) |
| happy-dom | GHSA-c8p4-j97h-3vg8 | high | #200 | `pnpm-lock.yaml` | `<= 20.14.6` | 21.0.0 | **fixed** | extension `^20.11.1` → `^21.0.4` (locks 21.0.4) |
| js-yaml | GHSA-2883-xcg3-v3hh | high | #82 | `pnpm-lock.yaml` | `>= 4.0.0, < 4.3.2` | 4.3.2 | **fixed** | in-range lock refresh → 4.3.2 (via vsce → secretlint) |
| js-yaml | GHSA-52cp-r559-cp3m | high | #58 | `pnpm-lock.yaml` | `>= 4.0.0, < 4.3.0` | 4.3.0 | **fixed** | in-range lock refresh → 4.3.2 (via vsce → secretlint) |
| js-yaml | GHSA-5p4m-2wfm-xmqj | high | #72 | `pnpm-lock.yaml` | `>= 4.0.0, < 4.3.1` | 4.3.1 | **fixed** | in-range lock refresh → 4.3.2 (via vsce → secretlint) |
| linkify-it | GHSA-v245-v573-v5vm | high | #60 | `pnpm-lock.yaml` | `<= 5.0.1` | 5.0.2 | **fixed** | in-range lock refresh → 5.0.2 (via markdown-it) |
| markdown-it | GHSA-gfr2-rv44-r23c | high | #135 | `pnpm-lock.yaml` | `>= 14.1.0, < 14.3.3` | 14.3.3 | **fixed** | in-range lock refresh → 14.3.3 (via vsce) |
| markdown-it | GHSA-r7fv-28h4-cvq7 | high | #126 | `pnpm-lock.yaml` | `< 14.3.2` | 14.3.2 | **fixed** | in-range lock refresh → 14.3.3 (via vsce) |
| nanoid | GHSA-28wg-ghj8-5hjv | high | #73 | `pnpm-lock.yaml` | `< 3.3.16` | 3.3.16 | **fixed** | vite bump + lock refresh → 3.3.20 (via postcss) |
| nanoid | GHSA-2v37-7h3g-55p8 | high | #74 | `pnpm-lock.yaml` | `< 3.3.18` | 3.3.18 | **fixed** | vite bump + lock refresh → 3.3.20 (via postcss) |
| Pillow | GHSA-22hg-r758-rrw9 | high | #143 | `requirements-freeze.txt` (pasqal-connector) | `>= 7.2.0, < 13.0.0` | 13.0.0 | **fixed** | `requirements-freeze.txt` pillow 12.3.0 → 13.0.0 |
| Pillow | GHSA-27h8-gf7j-v5hc | high | #141 | `requirements-freeze.txt` (pasqal-connector) | `<= 12.3.0` | 13.0.0 | **fixed** | `requirements-freeze.txt` pillow 12.3.0 → 13.0.0 |
| Pillow | GHSA-332p-7hrc-92wf | critical | #153 | `requirements-freeze.txt` (pasqal-connector) | `>= 2.0.0, < 13.0.0` | 13.0.0 | **fixed** | `requirements-freeze.txt` pillow 12.3.0 → 13.0.0 |
| Pillow | GHSA-3j72-p6qg-6xp7 | high | #168 | `requirements-freeze.txt` (pasqal-connector) | `< 13.0.0` | 13.0.0 | **fixed** | `requirements-freeze.txt` pillow 12.3.0 → 13.0.0 |
| Pillow | GHSA-58r4-6rv3-gfh8 | high | #125 | `requirements-freeze.txt` (pasqal-connector) | `<= 12.3.0` | 13.0.0 | **fixed** | `requirements-freeze.txt` pillow 12.3.0 → 13.0.0 |
| pillow | GHSA-5x8w-8jj5-q52h | critical | #176 | `requirements-freeze.txt` (pasqal-connector) | `<= 12.3.0` | 13.0.0 | **fixed** | `requirements-freeze.txt` pillow 12.3.0 → 13.0.0 |
| Pillow | GHSA-5xm2-6676-qcp9 | high | #150 | `requirements-freeze.txt` (pasqal-connector) | `>= 8.1.0, < 13.0.0` | 13.0.0 | **fixed** | `requirements-freeze.txt` pillow 12.3.0 → 13.0.0 |
| Pillow | GHSA-65qm-jvmh-6pqg | high | #124 | `requirements-freeze.txt` (pasqal-connector) | `>= 9.2.0, < 13.0.0` | 13.0.0 | **fixed** | `requirements-freeze.txt` pillow 12.3.0 → 13.0.0 |
| pillow | GHSA-78g4-xqwv-q3g8 | high | #172 | `requirements-freeze.txt` (pasqal-connector) | `>= 11.1.0, < 13.0.0` | 13.0.0 | **fixed** | `requirements-freeze.txt` pillow 12.3.0 → 13.0.0 |
| Pillow | GHSA-7mwm-ghpf-9vrm | high | #138 | `requirements-freeze.txt` (pasqal-connector) | `<= 12.3.0` | 13.0.0 | **fixed** | `requirements-freeze.txt` pillow 12.3.0 → 13.0.0 |
| Pillow | GHSA-8g5g-8vmr-9782 | critical | #117 | `requirements-freeze.txt` (pasqal-connector) | `<= 12.3.0` | 13.0.0 | **fixed** | `requirements-freeze.txt` pillow 12.3.0 → 13.0.0 |
| Pillow | GHSA-9v9v-9qvf-h2hj | high | #170 | `requirements-freeze.txt` (pasqal-connector) | `< 13.0.0` | 13.0.0 | **fixed** | `requirements-freeze.txt` pillow 12.3.0 → 13.0.0 |
| Pillow | GHSA-c6hw-5grf-ff96 | high | #118 | `requirements-freeze.txt` (pasqal-connector) | `>= 8.1.0, < 13.0.0` | 13.0.0 | **fixed** | `requirements-freeze.txt` pillow 12.3.0 → 13.0.0 |
| pillow | GHSA-cp9v-662q-vvx9 | high | #140 | `requirements-freeze.txt` (pasqal-connector) | `>= 12.0.0, < 13.0.0` | 13.0.0 | **fixed** | `requirements-freeze.txt` pillow 12.3.0 → 13.0.0 |
| Pillow | GHSA-f2g6-542v-9j58 | high | #151 | `requirements-freeze.txt` (pasqal-connector) | `>= 5.1.0, < 13.0.0` | 13.0.0 | **fixed** | `requirements-freeze.txt` pillow 12.3.0 → 13.0.0 |
| Pillow | GHSA-g4qv-2jxx-769h | high | #169 | `requirements-freeze.txt` (pasqal-connector) | `>= 11.0.0, < 13.0.0` | 13.0.0 | **fixed** | `requirements-freeze.txt` pillow 12.3.0 → 13.0.0 |
| Pillow | GHSA-g7cr-3p24-7wf7 | high | #171 | `requirements-freeze.txt` (pasqal-connector) | `>= 9.4.0, < 13.0.0` | 13.0.0 | **fixed** | `requirements-freeze.txt` pillow 12.3.0 → 13.0.0 |
| pillow | GHSA-g842-9rc4-69pw | high | #163 | `requirements-freeze.txt` (pasqal-connector) | `< 13.0.0` | 13.0.0 | **fixed** | `requirements-freeze.txt` pillow 12.3.0 → 13.0.0 |
| pillow | GHSA-gg2r-wvfm-q9rx | high | #149 | `requirements-freeze.txt` (pasqal-connector) | `>= 4.1.0, < 13.0.0` | 13.0.0 | **fixed** | `requirements-freeze.txt` pillow 12.3.0 → 13.0.0 |
| pillow | GHSA-j4m9-6w36-pw47 | high | #139 | `requirements-freeze.txt` (pasqal-connector) | `>= 10.0.0, < 13.0.0` | 13.0.0 | **fixed** | `requirements-freeze.txt` pillow 12.3.0 → 13.0.0 |
| Pillow | GHSA-jg86-v3jv-hrpm | high | #148 | `requirements-freeze.txt` (pasqal-connector) | `>= 5.1.0, < 13.0.0` | 13.0.0 | **fixed** | `requirements-freeze.txt` pillow 12.3.0 → 13.0.0 |
| Pillow | GHSA-mrfp-p49p-3hf2 | high | #166 | `requirements-freeze.txt` (pasqal-connector) | `>= 5.1.0, < 13.0.0` | 13.0.0 | **fixed** | `requirements-freeze.txt` pillow 12.3.0 → 13.0.0 |
| pillow | GHSA-p4wg-p73j-c528 | high | #120 | `requirements-freeze.txt` (pasqal-connector) | `>= 5.1.0, < 13.0.0` | 13.0.0 | **fixed** | `requirements-freeze.txt` pillow 12.3.0 → 13.0.0 |
| Pillow | GHSA-pchr-8j38-3x4p | high | #121 | `requirements-freeze.txt` (pasqal-connector) | `<= 12.3.0` | 13.0.0 | **fixed** | `requirements-freeze.txt` pillow 12.3.0 → 13.0.0 |
| Pillow | GHSA-q45j-58j2-45rg | high | #122 | `requirements-freeze.txt` (pasqal-connector) | `>= 5.3.0, < 13.0.0` | 13.0.0 | **fixed** | `requirements-freeze.txt` pillow 12.3.0 → 13.0.0 |
| Pillow | GHSA-v9pv-5gc8-w2m6 | critical | #165 | `requirements-freeze.txt` (pasqal-connector) | `>= 11.0.0, < 13.0.0` | 13.0.0 | **fixed** | `requirements-freeze.txt` pillow 12.3.0 → 13.0.0 |
| Pillow | GHSA-w889-685w-c8fh | critical | #136 | `requirements-freeze.txt` (pasqal-connector) | `>= 2.6.0, < 13.0.0` | 13.0.0 | **fixed** | `requirements-freeze.txt` pillow 12.3.0 → 13.0.0 |
| Pillow | GHSA-xvh5-g6gv-559v | high | #154 | `requirements-freeze.txt` (pasqal-connector) | `<= 12.3.0` | 13.0.0 | **fixed** | `requirements-freeze.txt` pillow 12.3.0 → 13.0.0 |
| postcss | GHSA-r28c-9q8g-f849 | high | #62 | `pnpm-lock.yaml` | `<= 8.5.17` | 8.5.18 | **fixed** | lock refresh → 8.5.32 (via vite) |
| source-map-js | GHSA-68fv-2mgg-jv7q | high | #106 | `pnpm-lock.yaml` | `>= 1.0.0, < 1.2.2` | 1.2.2 | **fixed** | lock refresh → 1.2.2 (via postcss) |
| tinypool | GHSA-5gmw-xhrv-c9v3 | critical | #104 | `pnpm-lock.yaml` | `<= 2.1.0` | 2.1.1 | **fixed** | vitest 4 no longer depends on tinypool; `grep -c tinypool pnpm-lock.yaml` = 0 |
| tinypool | GHSA-85c8-ppgw-ccpr | critical | #103 | `pnpm-lock.yaml` | `< 2.1.2` | 2.1.2 | **fixed** | vitest 4 no longer depends on tinypool; `grep -c tinypool pnpm-lock.yaml` = 0 |
| undici | GHSA-2m5v-pch6-74hx | high | #196 | `pnpm-lock.yaml` | `>= 7.0.0, < 7.30.1` | 7.30.1 | **fixed** | in-range lock refresh → 7.30.1 (via vsce → cheerio; dev tool) |
| undici | GHSA-4cwx-7wf7-3272 | high | #67 | `pnpm-lock.yaml` | `>= 7.0.0, < 7.29.0` | 7.29.0 | **fixed** | in-range lock refresh → 7.30.1 (via vsce → cheerio; dev tool) |
| undici | GHSA-4w7w-5xrc-9h26 | high | #197 | `pnpm-lock.yaml` | `>= 7.0.0, < 7.30.1` | 7.30.1 | **fixed** | in-range lock refresh → 7.30.1 (via vsce → cheerio; dev tool) |
| undici | GHSA-qrxm-fqhp-jwvm | high | #195 | `pnpm-lock.yaml` | `>= 7.0.0, < 7.30.1` | 7.30.1 | **fixed** | in-range lock refresh → 7.30.1 (via vsce → cheerio; dev tool) |
| undici | GHSA-rfgv-xxqx-mfg5 | high | #92 | `pnpm-lock.yaml` | `>= 7.0.0, < 7.29.1` | 7.29.1 | **fixed** | in-range lock refresh → 7.30.1 (via vsce → cheerio; dev tool) |
| undici | GHSA-w293-vg96-wgc3 | high | #88 | `pnpm-lock.yaml` | `>= 7.24.1, < 7.29.1` | 7.29.1 | **fixed** | in-range lock refresh → 7.30.1 (via vsce → cheerio; dev tool) |
| undici | GHSA-xjj6-f33q-929c | high | #185 | `pnpm-lock.yaml` | `>= 7.18.0, < 7.30.1` | 7.30.1 | **fixed** | in-range lock refresh → 7.30.1 (via vsce → cheerio; dev tool) |
| vite | GHSA-587h-7wmj-h5pm | high | #131 | `pnpm-lock.yaml` | `<= 6.4.3` | 6.4.4 | **fixed** | direct `vite ^6.4.5` devDependency (locks 6.4.5) |
| vitest | GHSA-5xrq-8626-4rwp | critical | #1, #48, #50, #54, #109 | `packages/amico-run/package.json`, `packages/companion/package.json`, `packages/extension/package.json`, `packages/schema/package.json`, `pnpm-lock.yaml` | `< 3.2.6` | 3.2.6 | **fixed** | vitest `^2.1.0` → `^4.1.12` in the four packages (locks 4.1.12) |

## What changed

- `packages/{amico-run,extension,schema,companion}/package.json`: `vitest ^2.1.0` → `^4.1.12`; added `vite ^6.4.5`
  (vitest 4 peers on vite 6/7/8, and the previously locked vite 5.4.21 is flagged GHSA-587h-7wmj-h5pm).
  This is a major bump that also removes `tinypool` from the tree (both critical tinypool advisories).
- `packages/extension/package.json`: `happy-dom ^20.11.1` → `^21.0.4`.
- `pnpm-lock.yaml`: in-range refresh of the transitive entries (`pnpm update -r --depth Infinity <pkgs>`), so no
  `pnpm.overrides` block was needed. Every flagged transitive package is reached only through `vitest`/`vite` or
  `@vscode/vsce` (dev tooling), and all had a patched version inside the existing semver range except
  `@azure/msal-node`, which moved with `@azure/identity` 4.14.1.
- `packages/extension/test/opencode_cli_link.test.ts`: one-line `vi.clearAllMocks()` in `beforeEach`. Vitest 4's
  `restoreAllMocks` no longer resets plain `vi.fn()` call history, so assertions leaked across tests.
- `packages/extension/scripts/pasqal-connector/requirements-freeze.txt`: `pillow 13.0.0`, `certifi 2026.10.18`.
  `requirements.txt` does not pin either, so it is unchanged.

## Not-shipped evidence (why the dev-tool rows are low-risk even before the fix)

- `packages/extension/.vscodeignore` excludes `node_modules/**`, `src/**`, `test/**` and `scripts/**` from the VSIX;
  the only pasqal-connector files re-included are `pasqal_validate.py`, `requirements.txt`, `submit.py`,
  `pulse_contract.py`, `translate_and_simulate.py` (`grep -n pasqal-connector packages/extension/.vscodeignore`).
  `requirements-freeze.txt` is therefore a dev/CI record, not a shipped artifact, but it is the manifest Dependabot reads and
  it documents the validated venv, so it was bumped rather than dismissed.
- `vitest`, `vite`, `happy-dom`, `@vscode/vsce` and everything beneath them are `devDependencies`; the extension
  packages with `vsce package --no-dependencies` (`packages/extension/package.json` `package` script).

## Gates

| Gate | Result |
|---|---|
| `pnpm audit --json` (all deps), before | low 5, moderate 32, high 26, critical 3 |
| `pnpm audit --json` (all deps), after | low 0, moderate 5, high 0, critical 0 (remaining: `qs` ×3, `minimatch`, `glob`: moderate, out of scope) |
| `pnpm audit --prod --json`, after | all zero |
| `pnpm audit --audit-level critical` / `high` / `high --prod` | no high or critical findings |
| pip-audit (temp venv, `-r requirements-freeze.txt --no-deps`), before | pillow 12.3.0: 39 advisories; certifi 2026.7.22: 2 |
| pip-audit, after | "No known vulnerabilities found" |
| `pnpm install --frozen-lockfile --ignore-scripts` on a `git archive HEAD` export | succeeds |
| `pnpm -r run typecheck` | clean |
| Tests (vitest, run locally with `--testTimeout=60000` because the host load average was above 30) | schema 379 passed; companion 136 passed; @amicode/amico-run 2480 passed / 2 skipped; extension 5825 passed / 53 skipped / **1 failed** |
| Pasqal connector tests (temp venv, `pytest tests --ignore=tests/slow_live.py`) | 72 passed, 5 subtests passed; `pip check` clean |

The one extension failure, `test/scores/skill_drift_lint.test.ts > ... hardware-loop regression ... scoped to Intonato`,
depends on the real fleet packages on this host and **fails identically on the pre-change tree** (verified by
stashing the changes, reinstalling the old lock and running it). Slow suites (`test:slow`) and the CI-only gates were not run here; CI is the arbiter.

## Needs a human

- **Dismiss decisions (director):** alerts #188, #115, #112 (server-side MCP SDK advisories, engine has no SDK server). No alert was dismissed or modified by this work.
- **Deferred:** alert #7 (GHSA-6qxp-vccf-f47h) stays open until #2010 lands (port the patch to SDK 1.32.x, or migrate to `@modelcontextprotocol/client` 2.x). Mitigation until then: only connect OAuth-enabled MCP servers you trust. If the director wants zero open highs before #2010, the only honest options are porting the patch or accepting a time-boxed documented exception.
- The engine reachability greps ran against the fork checkout at `/home/aaron/harmoniqs/opencode` (commit `b2143c450a`, branch `fix/digit-led-inline-math`), since the engine base is not vendored in this repo (only the overlay is). Re-run them against the engine ref pinned in `packages/app-bundle/manifest.json` before dismissing.
- Third acceptance criterion (lifecycle scripts disabled in the sandbox and release job) needs `.github/` workflow edits; it is out of this slice and untouched.
- Extension's own `@modelcontextprotocol/sdk ^1.32.2` is already patched (lock resolves 1.32.2, patched floor 1.32.0 for all six repo alerts, #113/#114 included). No action.
- The 53 medium and 8 low alerts remain open, out of scope.


## Director verification of the three dismiss candidates (#112, #115, #188) against the correct engine ref

The first pass searched a fork checkout at `b2143c450a`, **not** the engine tree the overlay actually builds from. Re-run on the right ref: upstream base `anomalyco/opencode@3104c1428e` (cached by the app-bundle) plus `packages/app-bundle/overlay/`:

```sh
grep -rlE "@modelcontextprotocol/sdk/server" --include=*.ts --include=*.tsx <base>/packages <overlay>/packages
```

Result: seven files, **all under `opencode/test/` (six `*.test.ts` and one `test/fixture/mcp-lifecycle-stdio.ts`)**; none in production source, in either the base or the overlay. The SDK subpaths imported by non-test source are client-side (`client/index`, `client/streamableHttp`, `client/auth`, `client/stdio`, `client/sse`, `types`, `shared/auth`). So the three advisories, which concern SDK **servers** (unbounded Streamable-HTTP bodies and batches, validation memory, `taskStore`), are not reachable from shipped engine code. They stay dismiss candidates, to be dismissed by a human with this evidence, "vulnerable code is not used".

**#7 (GHSA-6qxp-vccf-f47h, client-side OAuth credential leak) is NOT dismissed.** The engine is an MCP OAuth client (`client/auth`), so it is reachable; the fix needs SDK >= 1.31, which means leaving the deliberate 1.29.0 pin (#2010). It stays open and tracked there.

## Counting note

The open set returned by the Dependabot alerts API at triage time was 67 critical+high alert numbers (13 critical, 54 high) across 62 distinct (package, advisory) pairs. Earlier planning notes quoted "200 alerts, 14 critical, 72 high"; that was the repository-wide security banner, which counts differently. This document uses the API set, and every count above comes from a command.
