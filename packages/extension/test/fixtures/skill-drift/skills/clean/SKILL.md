---
name: clean
description: A clean skill whose every extracted claim resolves against the fixture packages.
agents: [engineer]
surface: public
---

# Clean skill

See [companion.md](companion.md) for the worked example.

Build widgets with `FixturePkg.Widget` like so:

```julia
using FixturePkg

w = make_widget(2)
op = EmbeddedOperator(w)
result = FixturePkg.make_widget(3)
```

The `make_widget` implementation lives in `src/widgets.jl` within FixturePkg.
