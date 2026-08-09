---
name: amico-linkedin
description: Publish Amicode public announcements to the Harmoniqs LinkedIn Company Page — draft→preview→post via the LinkedIn API, plus no-auth share-offsite fallback. Internal tool.
agents: [researcher, pulse-designer, librarian]
surface: public
cli_tool: ~/.local/bin/amico-linkedin
---

# LinkedIn Publishing Skill (`amico-linkedin`)

Internal tool to advertise Amicode public wins from within Amicode. First flight: Amicode launch announcement (Kimi K3 × `[[625,50,3]]` $g=0.72$, Pasqal + Microsoft hackathon, Unitary Foundation QEC Challenge). Mirrors `amico-slack` (Python CLI + `~/.amico/linkedin/token.json`, `--confirm` gate).

## When to use

- Drafting or posting a Harmoniqs Company Page announcement from Amicode.
- Sharing a QEC Challenge code / research note / vault note to LinkedIn.
- Checking LinkedIn org auth status before a campaign.

## Core Rules

1. **No silent posts.** `post` requires `--confirm` and an explicit org URN check. Drafts are local vault notes until confirmed.
2. **Honest claims.** `[[625,50,3]]` $d$ is `upper_bound` (witness-backed, CryptoMiniSat cert), $g$ inherits it, novelty not audited, seeded torics not raced — caveat in thread comment.
3. **LaTeX → Unicode.** LinkedIn has no LaTeX — flatten math the same way `amico-slack` does (`$\times$`→`×`, `$g=0.72$`→`g = 0.72`, `$r=\sqrt{2}$`→`r = √2`).
4. **Links are bare URLs** on LinkedIn (no Slack `<url|text>`). Convert `[text](url)` → `text (url)` or bare `url`.
5. **Token is secret.** `~/.amico/linkedin/token.json` is gitignored, never echoed. Refresh every ~60 days; `status` warns at 7 days.

## CLI Reference

| Task | Command |
|---|---|
| Share as self (no auth, works today) | `amico-linkedin share --url <url> [--text <msg>]` |
| Start OAuth as Super Admin | `amico-linkedin auth --client-id <id> --client-secret <secret> [--redirect http://localhost:8080/callback]` |
| Check org + token expiry | `amico-linkedin status` |
| Draft from vault note / URL | `amico-linkedin draft --from-note <path> --url <url> [--image <path>] [--out <draft-path>]` |
| Preview (char count, image) | `amico-linkedin preview <draft>` |
| Post as Harmoniqs (gated) | `amico-linkedin post <draft> --confirm` |
| Delete test post | `amico-linkedin delete <urn>` |

## Draft → Post flow (V1)

```bash
# 0. No-auth path — works today (posts as YOU, not as Harmoniqs)
amico-linkedin share --url https://unitaryfoundation.github.io/qldpc-challenge/codes/625-50-3.html

# 1. One-time auth as Super Admin (Aaron) — stores ~/.amico/linkedin/token.json
amico-linkedin auth --client-id $LINKEDIN_CLIENT_ID --client-secret $LINKEDIN_CLIENT_SECRET

# 2. Verify
amico-linkedin status

# 3. Draft from vault note + QEC URL
amico-linkedin draft --from-note ~/armonia/data/vaults/vault-aaron/notes/linkedin-amicode-launch.md \
  --url https://unitaryfoundation.github.io/qldpc-challenge/codes/625-50-3.html \
  --out /tmp/linkedin-draft.md

# 4. Preview
amico-linkedin preview /tmp/linkedin-draft.md

# 5. Post as Harmoniqs (confirm gate)
amico-linkedin post /tmp/linkedin-draft.md --confirm
```

## First post — Amicode launch framing

This is the first public announcement of **Amicode** on the Harmoniqs LinkedIn page. Frame Amicode as the tool for *many* things (pulse design, QEC code search, Pasqal cloud compilation, multi-platform optimal control), not a single-code brag. Lead with Amicode, then proof points:

- **Amicode** — Kimi K3-class agentic harness for quantum design (Piccolo/Piccolissimo + vault + catalog).
- **Pasqal + Microsoft hackathon (2026-07-29)** — Amicode × cloud-pasqal tutorials, pulser emulator → hardware, joint GTM.
- **Unitary Foundation QEC Challenge** — `[[625,50,3]]` holey rotated surface code, $g=0.72$ at $r=\sqrt{2}$ packing floor (top submitted geometric efficiency, $w\le4$ 2D-local single), verifier-passed, `L=13/19/25` family $0.533\to0.648\to0.720$ — proof Amicode + Kimi K3 ships verifiable research artifacts.

Assets: verifier layout (r=√2 hero) + g progression chart. CTA: challenge page + research note. Honest caveat in first comment.

## LinkedIn API notes (for `auth`/`post`)

- OAuth: `https://www.linkedin.com/oauth/v2/authorization` + `accessToken`, scopes `w_organization_social r_organization_social` (and `w_member_social` for share fallback if needed).
- Posts (new): `POST https://api.linkedin.com/rest/posts` with headers `X-Restli-Protocol-Version: 2.0.0`, `LinkedIn-Version: 202401` (or latest), `Authorization: Bearer <token>`. Body: `author: urn:li:organization:{id}`, `lifecycleState: PUBLISHED`, `visibility: PUBLIC`, `commentary` (text) + optional `content.media`.
- Org lookup: `GET https://api.linkedin.com/rest/organizations/{id}` or `GET /rest/organizationAcls?q=roleAssignee` to resolve URN from authenticated member.
- Token at `~/.amico/linkedin/token.json`: `{access_token, expires_at, refresh_token, org_urn, client_id}`. Never commit.

## Vault contract

Drafts reuse `notes/` as `type: note` with `tags: [announcement, linkedin]` + frontmatter `linkedin: {org, url, draft_id, image}`. No new folder for V1 (avoids `vault_contract` churn); promote to `team` via `visibility: team` + dream-promote PR when needed. If a typed `announcement` note type is added later, update `amico-vault` frontmatter in same PR (lint `tests/lint_vault_contract.sh` enforces both directions).
