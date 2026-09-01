# Amicode documentation

Quantum optimal control, driven by conversation. Describe the gate you want in
plain language; Amicode designs the pulse, runs the solve, and shows you the
result — without leaving your editor.

This is the user-facing guide. If you're setting up the repo for development
instead, see [`AGENTS.md`](../AGENTS.md).

## Contents

| Page | What's in it |
|---|---|
| [Getting started](./getting-started.md) | Install the extension, open the chat, and run your first solve. |
| [Features](./features.md) | A guided tour of every surface — conversational solves, platform skills, Armonia, the Run Inspector, the Pulse Catalog, and hardware. |
| [Hardware](./hardware.md) | The QICK / RFSoC path in depth: the three-verb boundary, the pure-Julia mock loop, and swapping to a real board. |
| [Ledger bridge contract](./ledger-bridge-contract.md) | SEAM 4: the shared record doctrine (append-only, atomic terminal markers, content hashes) across amicode run dirs, strumento task records, and the Telaio event spine — plus the replay fixtures the fold must replay. |

## New here?

Start with [Getting started](./getting-started.md) and run the worked
example — a minimum-time transmon X gate, taken all the way through the QICK
mock backend. Everything else builds on that loop.
