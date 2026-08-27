# ops/server/ — frozen copies of server-local scripts

`stage-internal-skills.sh` is a **byte-identical versioned copy** of the live
server script `~/.amico/server/bin/stage-internal-skills.sh` (amicode#587 —
state capture of the previously unversioned staging allowlist). The server's
copy stays canonical; this is NOT a deploy source (`install.sh` does not
install it). Verify with:
`cmp ops/server/stage-internal-skills.sh ~/.amico/server/bin/stage-internal-skills.sh`
