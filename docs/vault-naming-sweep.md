# Vault naming sweep — 2026-09-02 (one-time)

The naming rule of record: **vaults minted by `armonia-init` are named
`vault-<owner-or-purpose>`; "armonia" names the workspace (`~/armonia` =
repos + data), never a minted vault.** Team vaults riding code repos keep
the repo's own name (armonissima is a code repo first) — exempt by
construction, never "overridden".

## Fleet inventory at the rule's adoption

| vault | kind | naming | note |
| --- | --- | --- | --- |
| vault-aaron | personal | conforms (renamed 2026-09-02) | was armonia-aaron-trowbridge; compat symlink held one cycle |
| vault-partitura | restricted | conforms (renamed 2026-09-02) | was armonia-partitura; `name` field edit parked on the raise-content conflict's resolution |
| armonissima | team | exempt by construction | the armonissima code monorepo doubling as team vault |
| meeting-vault | team | conforms (already clean) | — |
| vault-attic | legacy | conforms (precedent — renamed before the rule was written down) | — |
| vault-public | public | conforms (precedent) | — |
| vault-visionroom | project | conforms (precedent) | — |
| armonia-issimo | project | legacy name, existing | pre-rule mint; converges opportunistically — enforcement is at minting, never by renaming history |

## Remaining migration debt (tracked to closure)

- mini: layout verification + dir rename via the fleet ritual (unreachable
  from the server at sweep time).
- Compat symlinks (`armonia-aaron-trowbridge → vault-aaron` on mac + server):
  removal gated on the no-session-broke confirmation.
- vault-partitura: the 139-commit catch-up + `name`-field edit, parked on the
  owner's resolution of the conflicted raise-pipeline file (human-owned
  content).
