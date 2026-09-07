# ops/server/ — frozen copies of server-local scripts

`stage-internal-skills.sh` is a **byte-identical versioned copy** of the live
server script `~/.amico/server/bin/stage-internal-skills.sh` (amicode#587 —
state capture of the previously unversioned staging allowlist). The server's
copy stays canonical; this is NOT a deploy source (`install.sh` does not
install it). Verify with:
`cmp ops/server/stage-internal-skills.sh ~/.amico/server/bin/stage-internal-skills.sh`

`hub-AGENTS.md` is a **byte-identical versioned copy** of the live hub prompt
`~/.amico/server/opencode-project-staging/opencode-project/AGENTS.md` (amicode#856
— the staged AGENTS.md is hand-maintained on the hub: no script on erlich
generates it, so the repo previously had no record of what the live prompt said,
and mac-rendered paths had baked in). The hub's copy stays canonical; this is a
state capture, not a deploy source. Verify with:
`cmp ops/server/hub-AGENTS.md ~/.amico/server/opencode-project-staging/opencode-project/AGENTS.md`
