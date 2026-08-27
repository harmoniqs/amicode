---
name: drifted
description: A skill whose API claims have drifted from the fixture packages.
agents: [engineer]
surface: public
---

# Drifted skill

```julia
using FixturePkg

w = PhantomWidget(2)
q = FixturePkg.phantom_fn(1)
```

Construct a `PhantomWidget` first, then call `FixturePkg.phantom_fn` on it.
