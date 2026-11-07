# The gateway shared secret runbook (amicode #1760 P1 — one door)

The engines' API ports (127.0.0.1:4094/4194/4294) are open to every
loopback-local client today. P1 closes them: once armed, an engine requires
`x-amicode-gateway-secret: <secret>` on **every** API route — 401 JSON without
it — and the frontdoor is the only stamper. Every client (panel, extension,
fleet sessions, CLI, probes) must go through the door, so every routing fix
becomes universal instead of per-door.

## The moving parts

| Piece | Role |
| --- | --- |
| `engine-gateway-secret.sh` | generates the secret ONCE; `print`/`path` serve it |
| `~/.amico/server/engine-gateway-secret.env` | `AMICODE_ENGINE_SHARED_SECRET=<64-hex>`, mode 600 — the single authority |
| `amicode-server.sh` | sources the env file at boot → every shard's ENGINE inherits the secret |
| frontdoor unit drop-in | `EnvironmentFile=` → the frontdoor stamps the header on every engine-facing connection |
| `rss-watchdog.sh` | probes engines WITH the header (reads the file fresh per probe — no restart) |
| engine middleware (`gateway-secret.ts`) | env set → every route requires the header; env unset → today's open behavior |

**Env UNSET = compat mode.** Every component degrades to exactly today's
behavior when `AMICODE_ENGINE_SHARED_SECRET` is absent: the engines are open,
the frontdoor stamps nothing, the watchdog probes bare. This is the safety
valve for both rollout and rollback.

## Arming (the one-restart-cycle ritual)

> **ROLLOUT HAZARD — read this twice.** The secret must be live on the
> **frontdoor AND all engines in ONE restart cycle**. A half-rolled state is a
> fleet outage: engines armed + frontdoor not → every request 401s (the
> frontdoor logs `GATEWAY-SECRET 401 from …` and serves 503s); frontdoor
> armed + engines not → likewise (the engines 401 the stamped dials). The
> compat window exists so phase 1 (deploy code) and phase 2 (arm) can be
> SEPARATE, verified steps — never arm and deploy in the same motion.

Phase 1 — deploy the code (engines stay OPEN, compat mode):

1. Build + deploy the new engine binary (the overlay's `gateway-secret.ts`
   middleware ships inside it) and the updated hub scripts
   (`rsync -a ops/hub/ ~/.amico/server/` per the deploy ritual).
2. Restart through `ops/hub-restart.sh`; run `hub-upgrade-smoke.sh`.
3. Verify compat: `bash ~/.amico/server/../..` — concretely:
   `curl -s http://127.0.0.1:4094/config?directory=%2Fhome%2Faaron%2Fharmoniqs%2Fopencode`
   answers 200 with NO header (open), and the frontdoor log shows no
   `GATEWAY-SECRET` lines.

Phase 2 — arm (ONE cycle):

1. `bash ~/.amico/server/engine-gateway-secret.sh ensure` (idempotent; never
   rotates — rotation repeats phase 2 as a whole).
2. Add the frontdoor drop-in (once):
   ```bash
   systemctl --user edit co.harmoniqs.amicode-frontdoor.service
   # in the editor:
   [Service]
   EnvironmentFile=%h/.amico/server/engine-gateway-secret.env
   ```
3. Restart EVERYTHING in one motion — frontdoor + all shard units — through
   `ops/hub-restart.sh` (never an inline `systemctl restart` from an
   agent hosted on the hub).
4. Watch the frontdoor log (`~/.amico/server/frontdoor.log`) for
   `GATEWAY-SECRET 401` lines for a few minutes — none should appear.

Rollback: delete the env file, drop the drop-in, restart everything.
Compat mode is instantly restored.

## Why the direct-engine population is forced, not broken

The campaign sessions that hit engines directly (the rd-framework question
replies on 4094/4194/4294 with zero frontdoor log lines) get a 401 JSON —
loud and immediate, not silence. The fix for them is to point their client at
the door (127.0.0.1:4096/4097), never at the engine port. The 401 body says
`missing or invalid x-amicode-gateway-secret` so the misrouting is
self-describing in the client's own error surface.

## Post-deploy multi-client matrix (the issue's verification gate)

Mechanical legs — run on the hub (erlich) unless noted:

```bash
SECRET_FILE="$HOME/.amico/server/engine-gateway-secret.env"
SECRET="$(cut -d= -f2- "$SECRET_FILE")"
DIRQ="/config?directory=%2Fhome%2Faaron%2Fharmoniqs%2Fopencode"

# 1. engines are CLOSED to bare dials (each shard):
for p in 4094 4194 4294; do
  test "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$p$DIRQ")" = 401 \
    && echo "shard $p closed: OK" || echo "shard $p closed: FAIL"
  test "$(curl -s -o /dev/null -w '%{http_code}' -H "X-Amicode-Gateway-Secret: $SECRET" "http://127.0.0.1:$p$DIRQ")" = 200 \
    && echo "shard $p stamped: OK" || echo "shard $p stamped: FAIL"
done

# 2. the door serves everything WITHOUT the client carrying any secret:
test "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:4096$DIRQ")" = 200 \
  && echo "door: OK" || echo "door: FAIL"

# 3. SSE-404-JSON guard: an SSE request on an unrouted path gets 404 JSON
#    (never index.html) at both the door and the engine:
curl -s -H "Accept: text/event-stream" http://127.0.0.1:4096/event-bogus | head -c 120

# 4. no 401 noise: the frontdoor's own dials all pass
! grep -q "GATEWAY-SECRET 401" ~/.amico/server/frontdoor.log \
  && echo "frontdoor clean: OK" || echo "frontdoor clean: FAIL"
```

Panel client (through the door, on macbook — the headless harness):

```bash
ssh -o BatchMode=yes macbook \
  '/opt/homebrew/bin/node /tmp/opencode/panel-probe/question.mjs'
# expect: the question card renders and the Red reply submits — the full
# ask/answer round trip through 127.0.0.1:4097 (the door's second origin).

ssh -o BatchMode=yes macbook \
  '/opt/homebrew/bin/node /tmp/opencode/panel-probe/probe.mjs'
# expect: the panel boots, root children > 0, no requestfailed storm.
```

Fleet-session + CLI legs: answer the same question from a fleet session on
erlich and from the CLI, both pointed at the door (4096/4097 — the client's
server URL must never be the engine port). The proof is in the frontdoor's
log — the exact evidence the #1760 diagnosis used ("zero reply POSTs in the
frontdoor's full log"):

```bash
# while the session/CLI answers, the door must CARRY the reply:
tail -f ~/.amico/server/frontdoor.log | grep -E "question/.*/(reply|reject)"
# and the engine log must show NO bare-dial 401 from that client:
grep -c "missing or invalid x-amicode-gateway-secret" \
  ~/.local/share/opencode/log/opencode.log || true
```

A direct-engine probe that still 200s after arming means an engine is running
an old binary (phase 1 not landed on that shard) — the `?directory=`-probe leg
above catches it per shard.
