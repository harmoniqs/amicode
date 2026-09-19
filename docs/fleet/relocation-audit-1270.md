# Relocation audit — Remote-SSH host-side attach to the durable hub (#1270)

> **STATUS: TEMPLATE — awaiting live results.** This is the HITL review artifact for
> issue #1270 (ADR 0025). It is a checklist to be **filled by a human** running a real
> VS Code Remote-SSH window onto a live durable-hub host. **No result below is filled
> in.** Every checkbox is unchecked by construction — checking one is a claim about an
> observed live run, and this document contains none yet. Do not mark a box PASS from
> reasoning; mark it only from the observed output of the stated manual check.

- **Issue:** #1270 — "Attach the editor to the durable hub over Remote-SSH — host-side
  adoption, never-fork at the handshake seam" (part of #1268).
- **Design of record:** ADR 0025 (Remote-SSH default posture; thin client as lifeboat) —
  invariants 1 (loopback-only bind), 2 (never-fork; adopt the durable hub), 5 (no silent
  fallback). Also ADR 0005 (managed fleet / never-fork), ADR 0020 (standalone server
  survives reload — the adopt-or-spawn machinery), ADR 0023 (one topology reader).
- **What automated tests already prove (so the live audit can focus on runtime):**
  `packages/extension/test/adopt_live_server.test.ts` → `#1270 host-side relocation`
  composes the three seams and pins, against a live loopback survivor, that the
  host-side path **adopts** a live durable-hub engine at the handshake (no second
  engine/store) and **surfaces** an unadoptable handshake as `foreign-error` (never a
  silent cold-spawn). The live audit below is the part a unit test **cannot** reach: a
  real Remote-SSH window, real host activation, and the real surfaces.

## Preconditions for the live run

Record the environment so a BROKEN result is reproducible.

- [ ] Durable-hub host is an SSH target with key trust (the fleet `ssh` transport's
      existing host + key — **no new credential handling**; #782 is out of scope).
- [ ] The host runs the durable-hub service (#1258): `amico fleet status` on the host
      shows role **server**, and the launchd/systemd-user unit is loaded (RunAtLoad +
      KeepAlive).
- [ ] The host's engine is live on the canonical port bound to loopback:
      `lsof -nP -iTCP:43117 -sTCP:LISTEN` shows the opencode server on `127.0.0.1:43117`.
- [ ] The host's adoption handshake exists: `~/.amico/ops/server/standalone.json` is
      present and readable (mode 0600), recording that server's port/pid/password.
- [ ] Fill in: hub host = `__________`, client OS = `__________`, extension version =
      `__________`, `vscode.env.remoteName` observed in the window = `__________`
      (expected to start with `ssh-remote`).

## Surface-by-surface audit

Each surface: the **host-correct** expectation, the **exact manual check**, and one
box. `PASS` = the check's stated output was observed; `BROKEN` = it was not (write what
happened instead in Notes).

### 1. Extension activation host-side  — **AC1 (runtime / HITL — not unit-testable)**

- **Host-correct:** opening a Remote-SSH window onto the hub host activates the Amicode
  extension **on the host** (`extensionKind: ["workspace"]` puts the extension host on
  the far side), not on the client.
- **Manual check:** open the Remote-SSH window onto the hub → Command Palette →
  "Amicode: Open Amicode Terminal" resolves, and the Output → Amicode channel shows boot
  lines. Confirm host-side execution: in that terminal `hostname` returns the **hub's**
  hostname, and the extension's boot log is being written on the host
  (`~/.amico/ops/server/server.log` grows on the host).
- [ ] PASS  [ ] BROKEN — Notes: `__________`

### 2. Engine — adopt vs spawn  — **AC2 (adopt; no second engine, no second store)**

- **Host-correct:** the host-side activation **adopts** the running durable-hub engine
  at the canonical handshake — it spawns **no** second engine and opens **no** second
  store. The Amicode channel prints `[boot] ADOPTED surviving server on port 43117 …`
  (never `[boot] … cold-spawning`).
- **Manual check (one canonical writer):**
  - Amicode channel shows the `ADOPTED` line above (not a cold-spawn line).
  - `lsof -nP -iTCP:43117 -sTCP:LISTEN` still shows **exactly one** listener, and its PID
    equals the pid in `~/.amico/ops/server/standalone.json` (the pre-existing hub, not a
    new one).
  - `pgrep -af "opencode.*serve"` on the host shows **exactly one** engine process.
  - The chat DB / store has a single writer: no second SQLite file opened, no
    `database is locked` errors in `server.log`.
- [ ] PASS  [ ] BROKEN — Notes: `__________`

### 3. Engine — unadoptable handshake is surfaced  — **AC3 (surfaced, not silent cold-spawn)**

- **Host-correct:** if the running hub does **not** present an adoptable handshake
  (stale/foreign recorded password, or protocol mismatch), the failure is **surfaced**
  (an error notification + an Amicode-channel line naming the port/pid conflict) and the
  extension spawns **no** rival engine on the occupied port.
- **Manual check (destructive — do on a scratch hub, then restore):** with the hub live
  on 43117, corrupt the recorded password in `~/.amico/ops/server/standalone.json` (or
  point it at a foreign occupant), reload the Remote-SSH window, and confirm: a VS Code
  error notification appears ("Amicode: …occupied…"), the Amicode channel logs the same,
  and `pgrep -af "opencode.*serve"` still shows **one** process (no rival spawned).
  Restore the handshake afterward.
- [ ] PASS  [ ] BROKEN — Notes: `__________`

### 4. Durable-hub service  — the #1258 runner it adopts

- **Host-correct:** the adopted engine **is** the durable-hub service's engine; adoption
  did not orphan or duplicate the service. After the window attaches, the service is
  still the process holding 43117 (KeepAlive did not restart a fight).
- **Manual check:** `launchctl list | grep amico` (macOS) or
  `systemctl --user status <hub-unit>` (Linux) on the host shows the hub unit running
  with the **same** PID as the 43117 listener; the service log shows no restart storm
  coinciding with the window attach.
- [ ] PASS  [ ] BROKEN — Notes: `__________`

### 5. Native Explorer  — host files (the reported split, closed natively)

- **Host-correct:** under Remote-SSH the native VS Code Explorer shows the **host's**
  files via real `file:` (not the `amico-host://` lifeboat FSP, which is the thin-client
  bridge). Opening/editing/saving a host file works with full tooling.
- **Manual check:** the Explorer root is a host path; open a host file, edit, save →
  the change lands on the host (`stat`/`git status` on the host reflects it). Confirm the
  scheme is `file:` (not `amico-host:`) via the editor's file URI.
- [ ] PASS  [ ] BROKEN — Notes: `__________`

### 6. Integrated terminal  — on the host

- **Host-correct:** the integrated terminal is a shell **on the host**; `amico` /
  `amico-run` resolve, and it talks to the same adopted engine.
- **Manual check:** open the integrated terminal → `hostname` = the hub; `which amico`
  resolves on the host; `amico fleet status` shows role server; `pnpm sync --check` runs
  against the host checkout.
- [ ] PASS  [ ] BROKEN — Notes: `__________`

### 7. Runs  — the host's run artifacts

- **Host-correct:** the Run Inspector and `~/.amico/runs/…` resolve to the **host's**
  runs (one canonical runs root, the adopted engine's), not an empty client-side root.
- **Manual check:** the Run Inspector lists the host's existing runs; a new solve writes
  under the host's `~/.amico/runs/default/<runId>/` (verify the dir appears on the host).
- [ ] PASS  [ ] BROKEN — Notes: `__________`

### 8. Chat / sessions / event stream  — host-owned, continuous

- **Host-correct:** chat sessions and the `/amicode/*` event stream are the **host's**
  (host-owns-all-state, #1262); a session opened on the host is visible in the
  Remote-SSH window, and turns stream from the adopted engine.
- **Manual check:** the Sessions list shows the host's sessions; send a message and
  confirm the turn streams; confirm the session persists in the host's chat DB (survives
  a window reload — the adopt-on-reload path, ADR 0020).
- [ ] PASS  [ ] BROKEN — Notes: `__________`

## Invariant spot-checks (ADR 0025)

- [ ] **Loopback-only bind (inv. 1):** the engine binds `127.0.0.1:43117` on the host;
      Remote-SSH is the transport, not a non-loopback bind. Verify: `lsof` shows
      `127.0.0.1`, never `0.0.0.0`/`*`.
- [ ] **Never-fork (inv. 2):** exactly one engine and one store across the whole attach
      (covered by surfaces 2 + 4).
- [ ] **No silent fallback (inv. 5):** any degradation (unreachable hub, unadoptable
      handshake) is a **surfaced** transition, never a silent reroute or cold-spawn
      (covered by surface 3).

## Verdict (fill after the live run)

- Surfaces host-correct: `__ / 8`.  Invariants held: `__ / 3`.
- Overall: [ ] host-correct (ready to seed S2/S3)  [ ] broken (file follow-ups; list
  the broken surfaces and their issue numbers here: `__________`).
- Auditor: `__________`   Date: `__________`   Commit/branch under test: `__________`.
