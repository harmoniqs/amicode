---
status: proposed
date: 2026-10-27
deciders: Aaron Trowbridge
tags: [security, fleet, armonia, tailscale, lab-deployment]
supersedes: []
related: ["#1872", "#1874", "#1879", "#1887", "#1956", "#1957", "spec-20261026-101500-rd-system-v2-1 (A15, A16)", "amicissimo ADR-0007 (C2 signed artifacts)"]
---

# ADR 0037: Armonia trust boundaries (Tailscale transport, sovereign clients, sandboxed agents)

## Context

Armonia deployments put a shared hub next to personal machines. The hub is a lab computer or a Modal container. It runs unattended agents and sits in front of instruments. Students, PIs, and outside collaborators attach laptops to it. The lab wants that system to be secure by design. The people using it want install to be one command and one click.

A capability audit of the hub-client posture (2026-10-27) found:

**Already sound:**
- In hub-client posture the laptop runs no server and opens no port.
- The tunnel is forward-only and has no `-R`.
- The agent tool server runs on the hub.
- Link resolution previews only vault roots.
- Widget iframes are sandboxed.

**Unsafe:**
- **Hub-served code runs on the laptop.** The chat panel's JavaScript is served by the hub from a directory the agents' OS user can write. It runs inside the laptop's VS Code and can send about 40 kinds of bridge message to the extension. Some of those:
  - run processes without consent: `dev-tools-rebuild` and `dev-tools-build-vsix` run git and `pnpm install` in any path;
  - read the clipboard silently;
  - change settings;
  - push workspace paths;
  - watch arbitrary files;
  - send typed credentials to the hub.
- **The frontdoor listened unauthenticated on `0.0.0.0`.** It was reachable from the LAN as well as the tailnet. Fixed by #1957 (loopback by default).
- **Remote access ran over hand-built SSH tunnels on per-machine ports.** Settings Sync carried one machine's port to another and hung its boot (#1956).
- **Agents run as the same OS user as everything else on the hub:** the UI it serves, the gates, the charter.

## Decision

### 1. Tailscale is the transport and the identity bootstrap
- The frontdoor listens on loopback only. It is published to the tailnet with `tailscale serve`, giving HTTPS at `https://<hub>.<tailnet>.ts.net` with Tailscale-issued certificates.
- Nothing is exposed on a LAN or to the public internet. SSH tunnels survive only as a fallback.
- The frontdoor maps the verified `Tailscale-User-Login` / `Tailscale-User-Name` headers that `serve` injects to #1874's person principal. These headers are trusted only on the loopback hop from `tailscaled`.
- The principal model stays transport-independent: an OIDC login can produce the same principal later.
- **Tailnet policy encodes the boundary**, shipped as a reviewed snippet:
  - `tag:armonia-hub` accepts traffic from lab members;
  - `tag:armonia-site` and `tag:lab-instrument` accept traffic only from the hub;
  - **no rule permits connections to personal devices.**
- Execution sites (lab PCs, Modal sandboxes, cluster login nodes) join with short-lived, pre-approved tagged auth keys. They are identities by tag, never by person.
- **Tailscale is transport; Armonia is authorization.** Being reachable grants nothing. Membership, campaigns, charters, and Strumento decide.
- Labs that cannot use the hosted control plane run **Headscale** (the Enterprise profile), which gives the same model. Where neither is permitted, the fallback is plain WireGuard managed by `armonia init`.

### 2. The client is sovereign: the hub sends data, never code
- In hub-client posture, the panel loads its UI from the **installed, signed extension**, not from the hub.
- If a deployment opts into hub-served UI, the client loads it only when its bundle signature verifies against the pinned root set (the amicissimo C2 channel). An agent editing the hub's dist then changes nothing on any laptop.
- **The bridge is a capability table.** Every message kind is classed per posture:
  - **view:** no side effects;
  - **consented:** a native VS Code prompt naming the hub and the action, optionally remembered per hub;
  - **forbidden in hub-client posture:** `dev-tools-*`, `data-storage-update`, `skill-providers-autodiscover`/`add`, arbitrary `watch-files`.
- **Clipboard** reads happen only from a real user paste in the webview. There is no read-on-request path.
- **Share nothing by default.** Workspace paths are not pushed to the hub. Opening, watching, and previewing local files is limited to folders the user has explicitly shared with that hub, listed and revocable in a "Shared with <hub>" view.
- **Personal credentials stay on the laptop.** Hub-side features use deployment or service credentials. A form that would store a user's key on a hub says so before submit.
- **The laptop keeps its own audit log** of every request the hub made and how it was answered.

### 3. Agents are sandboxed apart from what users run
- On the hub, agents run as a separate OS user (or in a container, gVisor, or Modal Sandbox per #1879).
- That user cannot write:
  - the served UI;
  - the gate scripts;
  - the charter;
  - the deployment config;
  - other principals' worktrees.
- Credentials reachable by agents are short-lived and bound to a principal (A15 mint records; Bedrock via identity tokens per #1887, not keys).

### 4. Install is one command and one click
- **Hub:** `armonia init --lab "<name>"`. It runs these steps:
  1. host checks;
  2. creates the agent user and sandbox runtime;
  3. joins the tailnet and tags the machine;
  4. emits the ACL snippet (or applies it through the API);
  5. mints the lab starter vault and signs the conservative charter;
  6. installs services that update from the signed channel;
  7. prints a join link and QR code.
- **Laptop:** install the extension, then open the join link.
  - The Tailscale login, via the institution's SSO, admits the device.
  - MagicDNS locates the hub.
  - A "share folders?" screen opens with nothing selected.
  - No ports, keys, or settings files are involved.
- **Instrument or site machine:** `armonia site join --kind lab` with a one-time tagged key. Outbound only.
- **`armonia doctor`** reports tailnet membership, identity, hub reachability, version skew, signatures, and charter state. Each result is a named outcome with its remedy.

## Consequences

- Port drift, tunnel daemons, and the `fleet.repair` port migration stop being necessary once clients use the MagicDNS URL. #1956's machine-scoped settings remain, as defense in depth.
- A compromised hub, or an agent on it, can no longer run code, read the clipboard, or browse files on a laptop. The worst case reduces to what the user shared or explicitly consented to.
- Tailscale becomes a deployment dependency for the Lab and Harmoniqs profiles. The Open profile (local only) is unaffected. Headscale or WireGuard cover labs that cannot use it.
- The capability table and signed UI bundle are new extension work. Hub-served UI stops being the default update path for laptops: UI updates ride the signed extension or a signed bundle.

## Slices

1. **#1957** frontdoor loopback bind (done and live).
2. `tailscale serve` publishing plus identity-header principal mapping in the frontdoor. Clients use the MagicDNS URL. The tunnel becomes a fallback.
3. The bridge capability table: forbid or consent per posture, clipboard on paste only, `open-file`/`watch-files` scoped to shared folders, no automatic workspace push.
4. The panel loads UI from the extension in hub-client posture; signed hub bundle opt-in.
5. Separate agent OS user on the hub with read-only served UI, gates, and charter (with #1879).
6. Tailnet ACL/grants snippet plus tagged site auth keys; `armonia site join`.
7. `armonia init` and `armonia doctor`.
8. The "Shared with <hub>" view and the laptop-side audit log.
