# Getting started

Amicode turns a plain-language description of a control problem into an
LLM-authored Julia optimization, runs it, and streams the result back into
native editor panels. This page takes you from a fresh install to your first
converged pulse.

## What you'll need

- **VS Code** 1.95 or newer.
- **Julia** 1.12 or newer. The solver runs locally on your machine — Amicode
  authors a self-contained Piccolo script and hands it to Julia.
- **A model provider** for the chat. Sign in to your provider once, or set an
  API key in your environment; without one, the extension falls back to a free
  anonymous tier that works but is best avoided for real work.

## Install and open

1. Install the Amicode extension in VS Code.
2. Open the **Amicode** icon in the Activity Bar. You'll see three views —
   **Vault**, **Catalog**, and **Armonia** — and the chat opens on its own once
   the assistant is ready. (You can reopen it any time with **Amicode: Open
   Chat** from the Command Palette.)

That's it. The first time you run a solve, Julia precompiles its project, which
takes a few minutes; every solve after that is fast.

## The chat panel

The chat is where you do the work. You describe a gate, a state preparation, or
a whole closed loop in ordinary language, and the assistant plans it against the
physics and against your own notes before it writes a line of code. A short
guided exchange fills in anything it needs — levels, drive conventions, what to
penalize — and then it writes the script.

Pick the model from the in-chat model picker at any time; the choice sticks for
that session.

## Your first solve

Open the chat and paste:

> Design a minimum-time single-qubit X gate for a transmon (3 levels, penalize
> leakage to |2⟩). Then run the optimized pulse through the IntonatoQICK mock
> backend, read out the populations, and plot both the pulse and the readout.

This one prompt exercises the whole loop: it names a platform (transmon), a
target (an X gate), a constraint (keep population out of |2⟩), and a hardware
step (the QICK mock backend — see [Hardware](./hardware.md)). You don't need to
know the Piccolo API, the transmon Hamiltonian, or the QICK verbs; the
assistant supplies all three.

## What to expect

The loop runs in three visible beats:

1. **A script is authored.** The assistant writes a self-contained Piccolo
   script — Hamiltonian, drives, objective, constraints, and the QICK mock call,
   all inlined — and shows it to you in the chat.
2. **The solve runs.** Julia executes the script and the Ipopt solve begins. A
   status-bar item tracks it live.
3. **The result is captured.** Open the **Run Inspector** to watch the solve
   converge — overlaid pulse plots, fidelity and constraint-violation traces,
   and per-run metrics. Open it from the status bar or with **Amicode: Open Run
   Inspector**, or turn on `amicode.inspector.autoOpen` to have it reveal itself
   when a solve starts.

Every run is captured to disk and stays revisitable — nothing you solve is
thrown away. When you're happy with a pulse, save it to your
[Pulse Catalog](./features.md#pulse-catalog) and warm-start from it next time.

## Where to go next

- [Features](./features.md) — a tour of every surface in the extension.
- [Hardware](./hardware.md) — the QICK / RFSoC path, from the mock loop to a
  real board.
