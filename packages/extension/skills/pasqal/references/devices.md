# Neutral-atom cloud devices — tiers, limits, and choosing a target

How to read the device list, what the free/non-free boundary actually protects, and how to
pick a target. Loaded on demand from [`../SKILL.md`](../SKILL.md).

## The tier boundary is default-deny

```bash
amico pasqal devices
```

lists what **this connection** exposes, each tagged `free` or `non-free`. The classification
is a one-element allowlist:

- **free** — the free emulator, and only that.
- **non-free** — *everything else*: paid emulators (tensor-network, MPS, state-vector), the
  QPU, and **any device name the tool has never seen before**.

Default-deny is the load-bearing part. A device added to the platform tomorrow is non-free
here on the day it appears, without a code change — so a new name can never slip past the
paid-submission gate by being unrecognized. Do not try to infer a tier from a device name
yourself; ask the CLI.

## The confirm gate

A non-free submission refuses to run unless `--confirm <digest>` matches. The digest binds:

- the device id and tier,
- the **content hash of the pulse**,
- the project identity.

It contains no secret, and it is not a password — it is a checksum of *what you are about to
spend money on*. Change one knot and the digest changes, so a confirmation cannot be reused
for a different pulse. `--dry-run` cannot bypass the gate (the gate is checked first), and
there is no fallback path from a refused paid target to a free one.

**The gate is a mechanism, not permission.** Ask the user before submitting to any paid
target, every time, and say which device and roughly what it costs. Then confirm.

## Blocked states

The device path reads a non-secret status cache; it never opens the token file. Five states
disable the path with their own actionable message and a non-zero exit:

| State | What it means | Fix |
|---|---|---|
| `not-connected` | no credential on this machine | Connections panel → connect |
| `expired` | the stored token has lapsed | Connections panel → reconnect |
| `validating` | a validation handshake is in flight | wait, then re-run |
| `no-devices` | connected, but the project exposes none | check the project in the panel |
| `stale-devices` | last validation older than ~24 h | reconnect to refresh the list |

None of these is a reason to improvise a credential path. See the credential rule in the main
card — the only correct response is to send the user to the panel.

## Published analog-device figures (orientation only)

Read the real values off the device object; these are for sanity-checking magnitudes and for
choosing a $T$ that is plausible before you spend a solve on it.

| Quantity | Order of magnitude |
|---|---|
| max amplitude $\Omega_{\max}$ | ~12.6 rad/µs (≈2 MHz) |
| max abs detuning $\Delta_{\max}$ | ~126 rad/µs (≈20 MHz) |
| interaction coefficient $C_6$ | ~8.66e5 rad/µs · µm⁶ |
| channel clock period | 4 ns |
| minimum atom distance | ~5 µm |
| max sequence duration | a few µs |
| max atom number | tens |

Two immediate consequences of these numbers:

- **The π-pulse speed limit** for a single atom is $T = \pi/\Omega_{\max} \approx 250$ ns.
  A claimed faster X gate is a bug or a different pulse than you think.
- **At the 5 µm minimum spacing** the blockade is *moderate*, not deep:
  $V/\Omega \approx 4.9$ with $V = C_6/d^6$. The naive blockade-π protocol tops out near
  96.8% there, which is exactly the gap optimization exists to close — and it means
  `free_phase` matters (see `atoms`).

Compute $V/\Omega$ for your spacing before choosing a protocol. It is one line and it decides
which regime you are in.

## Choosing a target

| You want | Target |
|---|---|
| does my pulse translate and validate at all | `--dry-run` (no network, no credentials) |
| does it behave under the device model | free emulator |
| a large register / a noisy model / longer sequences | a paid emulator — ask the user first |
| a hardware number | the QPU — ask, confirm, and only with an emulator pass in hand |

**Escalate one rung at a time.** The chain exists so failures are found at the cheapest tier
that can find them. Skipping to the QPU because the emulator queue is long converts a free
failure into a paid one.

## Shots and what comes back

The QPU returns **bitstrings with counts**, not a fidelity. Report the distribution and the
modal outcome, and interpret it against the problem (for a register/MIS run: is the modal
bitstring a valid independent set on the user's graph, and how does its size compare to the
classical optimum? — see `atoms/references/analog.md`). Quote shot counts alongside
frequencies; a 60% outcome over 100 shots and over 10 000 shots are different claims.

For a gate, a bitstring histogram is *not* a gate fidelity: measuring in one basis cannot see
phase. Do not convert populations into a fidelity claim — say what was measured.
