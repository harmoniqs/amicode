# Hardware — QICK / RFSoC

Amicode's hardware path is
**[IntonatoQICK.jl](https://github.com/harmoniqs/IntonatoQICK.jl)**, a QICK
backend that bridges an optimized pulse to an RFSoC board. The design goal is a
single, thin firewall between you and the lab: a pulse you solved in the editor
should reach the board without any transcription, and the whole loop should run
on a laptop with no board attached. This page walks that path.

## The three-verb boundary

The interface to a board is deliberately **coarse** — three verbs, and nothing
else crosses the line:

- `upload_pulse!` — send an optimized pulse to the board.
- `trigger!` — fire the sequence.
- `readout` — pull the measured populations back.

That's the entire contract. Everything tProc-v2-specific — waveform memory,
timing, DAC/ADC plumbing — lives board-side, behind those three calls. The
consequence for you is that the boundary is *just a transport*: nothing about a
particular board leaks into the pulse you designed, and nothing about your pulse
design leaks into the board firmware.

## The pure-Julia mock loop

Every one of those three verbs has a pure-Julia mock implementation. The mock
accepts an uploaded pulse, "fires" it, and returns simulated readout — so you
can run the *entire* closed loop with **no Python and no board**. This is the
default path for development and CI: the worked example in
[Getting started](./getting-started.md) runs against the mock, and the backend's
own test suite exercises the full loop this way.

Working against the mock first is the intended workflow, not a fallback. You
converge the pulse, watch the readout, and shake out the whole sequence long
before a board is in the room.

## Swapping to a real board

Because the mock and the real backend implement the same three verbs, moving to
hardware **swaps the transport and nothing else** — the pulse, the script, and
the readout handling are unchanged. You point Amicode at your board's hardware
profile and the same loop now runs on metal.

The board profile lives in a `lab.toml` (by default `~/.amico/lab.toml`), which
Amicode validates on load. A connected board's live status — its queue and
health — surfaces in the Device Inspector panel; the endpoint you configure is a
pointer only, never credentials.

For the backend itself, its supported firmware, and setup on a specific RFSoC,
follow the backend repository:

> **QICK v2 backend & docs → [github.com/harmoniqs/IntonatoQICK.jl](https://github.com/harmoniqs/IntonatoQICK.jl)**

## Beyond open-loop

Driving a board open-loop — upload, trigger, read out — is open. **Closed-loop
hardware calibration**, which tunes pulses against a live device, is one of the
proprietary capabilities in entitled builds, unlocked by the packages you have
access to. Same editor, same workflow; what you can reach is set by your
entitlements. See [Open core](./features.md#open-core).
