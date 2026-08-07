# Knot budget, slew bounds, and thread alignment

How to choose `N`, `du_bound(s)` and `Δt_bounds` from physics and hardware rather than from
round numbers. Loaded on demand from [`../SKILL.md`](../SKILL.md).

## Knot count — three numbers, take the smallest

1. **Shape floor** — what the solution needs: **13–17** (1Q), **17–25** (2Q / few-lobe),
   **25–33** (3Q, multi-stage schedules, several motional modes). Start here.
2. **Slew ceiling** — $N \le T\,(\text{slew}_{\max}/u_{\max}) + 1$. Above this you are asking
   for waveform detail the hardware physically cannot slew to; the extra knots cost memory and
   buy nothing. **If the floor exceeds the ceiling, `T` is too short — lengthen `T`, do not add
   knots.**
3. **Memory ceiling** — NLP variables $\approx N \times (\text{state\_dim} + 2 n_\text{drives})$;
   exact-Hessian work $\approx N \times \text{state\_dim}^2$, where
   $\text{state\_dim} = 2\,\text{dim}^2$ (`UnitaryTrajectory`) or $2 k\,\text{dim}$
   (`MultiKetTrajectory`).

When the shape floor exceeds the memory ceiling, **change trajectory type before cutting `N`**
(`Unitary` → `MultiKet` drops per-knot cost from $\text{dim}^2$ to $k\,\text{dim}$). An
under-resolved pulse is unrepresentable; an expensive one is merely slow.

Note the ordering this implies: knot count grows with **duration and bandwidth**, not with qubit
count. More qubits raises `dim`, which *tightens* the memory ceiling while leaving the shape
floor alone. Adding knots because the register got bigger is backwards.

Some platforms have a tighter **physics** ceiling than their slew ceiling. On a transmon,
spectral content near $|\alpha|$ drives $|1\rangle\to|2\rangle$, so $N \lesssim 2|\alpha|T + 1$
binds first (13 for a 20 ns gate, against a slew ceiling of 21). On ions the slew cap is orders
of magnitude looser than anything relevant and the motional mode structure governs instead.

**When fidelity stalls, fix `T` first, then warm-start, then knots.** Fluxonium evidence: holding
the parameterization fixed and moving `T_init` 50 ns → 25 ns produced new-best results on all
four 1Q gates (+0.008 to +0.36 pp). The historical "linear 51 beats cubic 11" comparison
confounded pulse type with knot count and ran ~2× above its own slew ceiling.

## Align `N` to your thread count

Every threaded loop in the solver stack runs over **intervals**, `k = 1:(N-1)` — not over knot
points. The integrator, the DK Jacobian operator and the Hessian-vector product all share that
shape, so the alignment rule is on `N - 1`:

```julia
# N - 1 divisible by nthreads: each thread gets equal knot-intervals
N = k * Threads.nthreads() + 1
```

That is why the folklore values 11 / 21 / 31 / 51 behave well — they are 10 / 20 / 30 / 50
intervals. Two refinements:

- The CPU VJP is **red-black colored** (two passes, stride 2), so each pass carries $(N-1)/2$.
  Ideal alignment is `(N - 1) % (2 * Threads.nthreads()) == 0`.
- That coloring is skipped when the problem carries globals — **`free_phase = true` makes the VJP
  fall back to serial.** Since free phase is recommended for every entangling gate, alignment
  matters most for the `1:(N-1)` integrator and Hessian loops, which stay threaded either way.
  Expect less speedup from extra threads on a free-phase problem.

At 4 or 8 threads, `N ∈ {17, 25, 33}` (16/24/32 intervals) balances both. Prefer these over a
neighboring value with an awkward factorization: `N = 49` (48 intervals, $2^4\cdot3$) balances on
2/3/4/6/8/12/16/24 threads, whereas `N = 48` gives 47 intervals — prime, and therefore balanced
on nothing.

When `Δt` is pinned to a device clock grid, `T` and `N` are not independent: `T = (N-1)·Δt`. Pick
`Δt` as a clock multiple and the interval count divisible by your thread count, then read `T` off
the product (see `pasqal`).

## Slew bounds

Read `du_bound` off the slew-rate spec. Use the **vector** `du_bounds` whenever channels differ:
neutral-atom Ω and Δ have separate published caps (250 vs 2000 MHz/µs), and a scalar `du_bound`
silently imposes the tighter one on both, throwing away most of the detuning channel's agility.

A `du_bound` that no instrument could produce is worse than none: it lets the optimizer buy
fidelity with waveform detail that will not survive translation to hardware. Sanity-check it as a
rise time — `u_max/du_bound` should be a plausible number of nanoseconds.

## Timestep bounds

`Δt_bounds` brackets the nominal step: `(0.3, 3.0) .* T/(N-1)`. Two failure modes to check for,
both of which are mis-specified problems rather than permissive ones:

- an upper bound exceeding `T` itself (a single timestep longer than the whole gate);
- a *lower* bound above the nominal step, or an upper bound below it — then the stated `T`, `N`
  and `Δt_bounds` cannot all hold at once.

## Free time and unequal timesteps — the defaults, and why to keep them

Δt is always an optimization variable (there is no `free_time` switch), and
`PiccoloOptions(timesteps_all_equal)` defaults to **`false`**. Keep both.

A *bracket* like `(0.3, 3.0) .* Δt_nom` leaves each Δt free to move independently inside it, so
the optimizer can spend duration where the dynamics need it — slow through an avoided crossing,
fast through a flat stretch — without changing the knot count. That is a genuine degree of
freedom, and on schedules with a minimum gap (adiabatic ramps, MIS encodings) it is usually the
most valuable one available.

Pinning is different from bounding. `Δt_bounds = (x, x)` fixes the grid, and:

- it makes **`MinimumTimeProblem` a no-op** — duration is $\sum_k \Delta t_k$, so fixing every
  Δt fixes the total. Never pin a problem you intend to chain into min-time; compress first,
  pin afterwards;
- it already forces equality, so passing `timesteps_all_equal = true` alongside it adds nothing;
- it is correct in exactly one situation: emitting to hardware that samples on a fixed clock
  grid, where off-grid knots would be resampled underneath you (see `pasqal`).

If a solve needs a *uniform* grid for reasons other than a device clock, prefer widening the
bracket over pinning it — a narrow bracket keeps the freedom while limiting how far the grid can
distort.
