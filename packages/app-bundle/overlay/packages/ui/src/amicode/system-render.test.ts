import { describe, it, expect } from "bun:test"
import katex from "katex"
import { systemProjection } from "./problem"
import {
  systemSchematicModel,
  systemTableModel,
  systemHamiltonianLatex,
  systemHamiltonian,
  systemIdentityLine,
  systemCountLabel,
  componentPhysicsRows,
} from "./system-render"

const twoTransmon = {
  platform: "transmon",
  drive: { arch: "per-component" },
  topology: "linear-chain",
  components: [
    { id: "q1", role: "qubit", levels: 3, params: { omega: 4.0, delta: -0.2 } },
    { id: "q2", role: "qubit", levels: 3, params: { omega: 4.1, delta: -0.2 } },
  ],
  couplings: [{ between: ["q1", "q2"], kind: "ZZ", params: { strength: 0.1 } }],
}

describe("systemSchematicModel", () => {
  it("nodes + adjacent 2-id edge + topology for a linear chain", () => {
    const s = systemSchematicModel(systemProjection(twoTransmon))
    expect(s.nodes.map((n) => n.id)).toEqual(["q1", "q2"])
    expect(s.nodes[0].levels).toBe(3)
    expect(s.edges).toEqual([{ a: "q1", b: "q2", label: "ZZ" }])
    expect(s.looseCouplings).toEqual([])
    expect(s.topology).toBe("linear-chain")
  })
  it("N=1 → single node, no edges", () => {
    const single = {
      platform: "transmon",
      drive: { arch: "per-component" },
      components: [{ id: "q1", role: "qubit", levels: 3, params: {} }],
      couplings: [],
    }
    const s = systemSchematicModel(systemProjection(single))
    expect(s.nodes).toHaveLength(1)
    expect(s.edges).toEqual([])
  })
  it("non-adjacent / hyperedge coupling → looseCouplings, not drawn", () => {
    const hyper = {
      platform: "rydberg",
      drive: { arch: "global" },
      components: [
        { id: "q1", role: "atom", levels: 3, params: {} },
        { id: "q2", role: "atom", levels: 3, params: {} },
        { id: "q3", role: "atom", levels: 3, params: {} },
      ],
      couplings: [{ between: ["q1", "q3"], kind: "vdW", params: {} }], // indices 0,2 — non-adjacent
    }
    const s = systemSchematicModel(systemProjection(hyper))
    expect(s.edges).toEqual([])
    expect(s.looseCouplings).toEqual([{ between: ["q1", "q3"], kind: "vdW" }])
  })
})

describe("systemHamiltonianLatex", () => {
  it("composes drift + coupling + drive for a cavity+qubit dispersive system", () => {
    const cavQubit = {
      platform: "transmon",
      drive: { arch: "per-component" },
      components: [
        { id: "q1", role: "qubit", levels: 3, params: { omega: 4, delta: -0.2 } },
        { id: "c1", role: "cavity", levels: 10, params: { K_c_Hz: 3.25 } },
      ],
      couplings: [{ between: ["q1", "c1"], kind: "dispersive-chi", params: { chi_kHz: 32.8 } }],
    }
    const h = systemHamiltonianLatex(systemProjection(cavQubit))!
    expect(h).toContain("\\hat H/\\hbar")
    expect(h).toContain("\\chi") // the dispersive interaction term
    // per-component drive → one independently indexed control PAIR per subsystem
    // (two quadratures — Piccolo's n_drives = 2, matching the plugin's TRANSMON_LATEX)
    expect(h).toContain("u_{1,1}(t)")
    expect(h).toContain("i\\,u_{2,1}(t)")
    expect(h).toContain("u_{1,2}(t)")
  })
  it("returns undefined for a system with no components", () => {
    expect(systemHamiltonianLatex(systemProjection({ platform: "x", components: [], couplings: [] }))).toBeUndefined()
  })
  it("rydberg atom → Rabi drive on |1⟩↔|r⟩, NO bosonic quadrature drive", () => {
    const rydberg = {
      platform: "rydberg",
      drive: { arch: "global" },
      components: [{ id: "q1", role: "atom", levels: 3, params: {} }],
      couplings: [],
    }
    const h = systemHamiltonianLatex(systemProjection(rydberg))!
    // n̂ = |r⟩⟨r|, the same operator the vdW term uses — one notation per operator
    expect(h).toContain("-\\Delta\\,\\hat n")
    expect(h).toContain("\\Omega(t)") // laser Rabi drive
    expect(h).toContain("|r\\rangle\\langle 1|")
    expect(h).not.toContain("\\varepsilon(t)") // no cavity-style drive on a bare atom
    expect(h).not.toContain("\\hat a") // no bosonic ladder operators at all
    expect(h).not.toContain("\\sum") // N=1 carries no index clutter
  })
  it("N atoms sum over sites — the register size is IN the equation", () => {
    const atoms = (n: number) => ({
      platform: "rydberg",
      drive: { arch: "global" },
      components: Array.from({ length: n }, (_, i) => ({ id: `q${i + 1}`, role: "atom", levels: 3, params: {} })),
      couplings: Array.from({ length: n - 1 }, (_, i) => ({
        between: [`q${i + 1}`, `q${i + 2}`],
        kind: "vdW",
        params: {},
      })),
    })
    const two = systemHamiltonianLatex(systemProjection(atoms(2)))!
    const three = systemHamiltonianLatex(systemProjection(atoms(3)))!
    // the bug this replaces: 1, 2 and 20 atoms all rendered the same string
    expect(two).not.toBe(systemHamiltonianLatex(systemProjection(atoms(1)))!)
    expect(two).toContain("-\\Delta\\,\\sum_i \\hat n_{i}")
    expect(two).toContain("\\tfrac{C_6}{r_{12}^6}\\,\\hat n_{1} \\hat n_{2}") // one edge → real site ids
    expect(three).toContain("\\sum_{\\langle ij\\rangle} \\tfrac{C_6}{r_{ij}^6}") // two edges → sum over pairs
    expect(two.split("\\Omega(t)")).toHaveLength(2) // one global control, applied to every site
  })
  it("drive architecture reaches the equation: global shares one control, per-site indexes it", () => {
    const pair = (arch: string) => ({
      platform: "rydberg",
      drive: { arch },
      components: [
        { id: "q1", role: "atom", levels: 3, params: {} },
        { id: "q2", role: "atom", levels: 3, params: {} },
      ],
      couplings: [{ between: ["q1", "q2"], kind: "vdW", params: {} }],
    })
    const global = systemHamiltonianLatex(systemProjection(pair("global")))!
    const per = systemHamiltonianLatex(systemProjection(pair("per-component")))!
    const zoned = systemHamiltonianLatex(systemProjection(pair("zoned")))!
    expect(global).toContain("\\Omega(t)") // one knob for the whole register
    expect(per).toContain("\\Omega_{i}(t)") // one knob per atom
    expect(zoned).toContain("\\Omega_{z(i)}(t)") // one knob per zone
    expect(new Set([global, per, zoned]).size).toBe(3) // the badge is not decoration
    expect(global).toContain("-\\Delta\\,\\sum_i") // Δ is the laser's, so it follows the drive
    expect(per).toContain("\\Delta_{i}")
  })
  it("a qubit and a cavity never share an operator symbol", () => {
    const h = systemHamiltonianLatex(
      systemProjection({
        platform: "transmon",
        drive: { arch: "per-component" },
        components: [
          { id: "q1", role: "qubit", levels: 3, params: {} },
          { id: "c1", role: "cavity", levels: 10, params: {} },
        ],
        couplings: [{ between: ["q1", "c1"], kind: "dispersive-chi", params: {} }],
      }),
    )!
    expect(h).toContain("\\hat a^\\dagger_{1} \\hat a_{1}") // qubit ladder
    expect(h).toContain("\\hat b^\\dagger_{2} \\hat b_{2}") // cavity gets its OWN letter
    expect(h).toContain("\\chi\\,\\hat b^\\dagger_{2} \\hat b_{2}\\,\\hat n_{1}")
  })
  it("an off-template platform infers NOTHING rather than the transmon ladder", () => {
    // The reported bug: "hrl style spin qubit" → role defaults to qubit, levels
    // unstated, and the card asserted ω â†â + δ/2 â†²â² + ε(t)(â + â†). There is
    // no honest fallback here — `Ĥ_drift + Ĥ_c(t)` is true of every control
    // problem ever posed — so the slot stays empty until someone records one.
    const hrl = {
      platform: "hrl-spin",
      drive: { arch: "per-component" },
      components: [{ id: "q1", role: "other", params: {} }],
      couplings: [],
    }
    expect(systemHamiltonianLatex(systemProjection(hrl))).toBeUndefined()
    // …a role defaulted to "qubit" by an unrecognized platform is the same case…
    expect(
      systemHamiltonianLatex(systemProjection({ ...hrl, components: [{ id: "q1", role: "qubit", params: {} }] })),
    ).toBeUndefined()
    // …and so is one where the researcher HAS stated a level count. Three levels
    // on an exchange-only qubit is three dots, not an anharmonic ladder.
    expect(
      systemHamiltonianLatex(
        systemProjection({ ...hrl, components: [{ id: "q1", role: "qubit", levels: 3, params: { drive_max: 1 } }] }),
      ),
    ).toBeUndefined()
    // the same entity on a platform we DO model keeps its ladder
    const transmon = systemHamiltonianLatex(
      systemProjection({ ...hrl, platform: "transmon", components: [{ id: "q1", role: "qubit", params: {} }] }),
    )!
    expect(transmon).toContain("\\tfrac{\\delta}{2}")
  })

  it("an unmodelled component in a MIXED system is a placeholder, not a hole", () => {
    // Here there IS something to say, so the modelled parts render and the
    // unknown one gets a named term rather than invented algebra.
    const h = systemHamiltonianLatex(
      systemProjection({
        platform: "hybrid",
        drive: { arch: "per-component" },
        components: [
          { id: "q1", role: "atom", levels: 3, params: {} },
          { id: "s1", role: "spin-qudit", levels: 4, params: {} },
        ],
        couplings: [],
      }),
    )!
    expect(h).toContain("\\hat H_{\\mathrm{drift}}^{(2)}")
    expect(h).toContain("\\hat H_{\\mathrm{c}}^{(2)}(t)")
    expect(h).toContain("|r\\rangle\\langle 1|_{1}") // the atom still renders properly
    expect(h).not.toContain("\\hat a") // no bosonic algebra conjured for the qudit
  })
  it("a term carrying its own minus sign is joined with −, not '+ -'", () => {
    const h = systemHamiltonianLatex(
      systemProjection({
        platform: "hybrid",
        drive: { arch: "per-component" },
        components: [
          { id: "c1", role: "cavity", levels: 10, params: {} },
          { id: "a1", role: "atom", levels: 3, params: {} },
        ],
        couplings: [],
      }),
    )!
    expect(h).not.toContain("+ -")
    expect(h).toContain(" - \\Delta_{2}")
  })
  it("levels, not param presence, picks the qubit model: 3-level ladder vs 2-level spin", () => {
    const ladder = {
      platform: "transmon",
      drive: { arch: "per-component" },
      // params still empty — the model is a 3-level ladder regardless
      components: [{ id: "q1", role: "qubit", levels: 3, params: {} }],
      couplings: [],
    }
    const h = systemHamiltonianLatex(systemProjection(ladder))!
    expect(h).toContain("\\tfrac{\\delta}{2}")
    expect(h).not.toContain("\\hat\\sigma_z")

    const spin = systemHamiltonianLatex(
      systemProjection({ ...ladder, components: [{ id: "q1", role: "qubit", levels: 2, params: {} }] }),
    )!
    expect(spin).toContain("\\hat\\sigma_z")
    expect(spin).toContain("\\hat\\sigma_x") // driven in the Pauli basis…
    expect(spin).not.toContain("\\hat a") // …not on a bosonic quadrature
  })
  it("mixed atom + cavity → both drive flavors", () => {
    const mixed = {
      platform: "hybrid",
      drive: { arch: "per-component" },
      components: [
        { id: "q1", role: "atom", levels: 3, params: {} },
        { id: "c1", role: "cavity", levels: 10, params: {} },
      ],
      couplings: [],
    }
    const h = systemHamiltonianLatex(systemProjection(mixed))!
    expect(h).toContain("\\Omega_{1}(t)") // laser Rabi on the atom
    expect(h).toContain("u_{1,2}(t)") // quadrature drive on the cavity
  })
})

describe("systemHamiltonian — recorded beats inferred", () => {
  // The architectural point: the agent knows what an exchange-only spin qubit
  // is; the fallback table never will. When the model is RECORDED the card
  // renders exactly that and stops guessing.
  const hrl = {
    platform: "hrl-spin",
    drive: { arch: "per-component" },
    components: [
      { id: "q1", role: "other", params: {} },
      { id: "q2", role: "other", params: {} },
      { id: "q3", role: "other", params: {} },
    ],
    couplings: [
      { between: ["q1", "q2"], kind: "exchange", params: {} },
      { between: ["q2", "q3"], kind: "exchange", params: {} },
    ],
    hamiltonian: {
      terms: [
        { kind: "coupling", latex: "J_{12}(t)\\,\\vec S_1 \\cdot \\vec S_2", label: "exchange 1–2" },
        { kind: "coupling", latex: "J_{23}(t)\\,\\vec S_2 \\cdot \\vec S_3", label: "exchange 2–3" },
      ],
      notes: "encoded qubit in the S=1/2, S_z=-1/2 subspace; exchange-only, no on-site drive",
    },
  }

  it("renders the recorded terms verbatim and marks them recorded", () => {
    const h = systemHamiltonian(systemProjection(hrl))!
    expect(h.source).toBe("recorded")
    expect(h.latex).toBe("\\hat H/\\hbar = J_{12}(t)\\,\\vec S_1 \\cdot \\vec S_2 + J_{23}(t)\\,\\vec S_2 \\cdot \\vec S_3")
    expect(h.notes).toContain("exchange-only")
    expect(() => katex.renderToString(h.latex, { throwOnError: true })).not.toThrow()
  })

  it("orders drift → coupling → drive however they were recorded", () => {
    const h = systemHamiltonian(
      systemProjection({
        ...hrl,
        hamiltonian: {
          terms: [
            { kind: "drive", latex: "u(t)\\,\\hat X" },
            { kind: "drift", latex: "\\omega\\,\\hat Z" },
            { kind: "coupling", latex: "J\\,\\hat Z_1\\hat Z_2" },
          ],
        },
      }),
    )!
    expect(h.latex).toBe("\\hat H/\\hbar = \\omega\\,\\hat Z + J\\,\\hat Z_1\\hat Z_2 + u(t)\\,\\hat X")
  })

  it("a recorded term carrying a minus is joined with −, like the inferred path", () => {
    const h = systemHamiltonian(
      systemProjection({
        ...hrl,
        hamiltonian: { terms: [{ kind: "drift", latex: "\\omega\\,\\hat Z" }, { kind: "drift", latex: "-\\Delta\\,\\hat n" }] },
      }),
    )!
    expect(h.latex).not.toContain("+ -")
    expect(h.latex).toContain(" - \\Delta")
  })

  it("falls back to the inferred form, labelled, when nothing is recorded", () => {
    const h = systemHamiltonian(systemProjection(twoTransmon))!
    expect(h.source).toBe("inferred")
    expect(h.latex).toBe(systemHamiltonianLatex(systemProjection(twoTransmon))!)
  })

  it("nothing recorded and nothing modelled → undefined, so the card can say so", () => {
    expect(systemHamiltonian(systemProjection({ ...hrl, hamiltonian: undefined }))).toBeUndefined()
  })

  it("junk terms are dropped rather than rendered as holes", () => {
    const junk = (terms: unknown) => systemHamiltonian(systemProjection({ ...hrl, hamiltonian: { terms } } as any))
    expect(junk([{ kind: "drift" }, { kind: "drift", latex: "   " }])).toBeUndefined() // → falls through
    expect(junk([{ kind: "drift", latex: "\\omega\\,\\hat Z" }, { latex: 42 }])!.latex).toBe(
      "\\hat H/\\hbar = \\omega\\,\\hat Z",
    )
    expect(junk("not an array")).toBeUndefined()
  })
})

describe("systemHamiltonianLatex — exhaustive sweep", () => {
  // Every role × every coupling kind × every drive arch × N ∈ {2,3}. The card
  // renders this straight into KaTeX, so an unparseable string is a visible
  // error box in the transcript; a composer that special-cases roles and edge
  // shapes needs the whole product space swept, not a handful of examples.
  const ROLES = ["qubit2", "qubit3", "atom", "cavity", "cavityK", "resonator", "mode", "unmodeled"]
  const KINDS = ["exchange", "ZZ", "cross-resonance", "dispersive-chi", "vdW", "mode-mediated", "not-a-kind"]
  const ARCHES = ["global", "per-component", "zoned", undefined]
  // Platform is load-bearing: it is the only thing that licenses a ladder for a
  // `qubit` role, so the sweep has to cross both sides of that line.
  const PLATFORMS = ["transmon", "exchange-only-spin"]
  const LADDER = new Set(["transmon", "bosonic"])
  /** No model → no terms. The only two ways to get there. */
  const unmodelled = (r: string, p: string) => r === "unmodeled" || (r === "qubit3" && !LADDER.has(p))
  const mk = (r: string, i: number) =>
    r === "qubit2" ? { id: `q${i}`, role: "qubit", levels: 2, params: {} }
    : r === "qubit3" ? { id: `q${i}`, role: "qubit", levels: 3, params: {} }
    : r === "atom" ? { id: `q${i}`, role: "atom", levels: 3, params: {} }
    : r === "cavityK" ? { id: `q${i}`, role: "cavity", levels: 10, params: { K_c_Hz: 3 } }
    : r === "unmodeled" ? { id: `q${i}`, role: "flux-tunable-thingy", levels: 4, params: { foo: 1 } }
    : { id: `q${i}`, role: r, levels: 10, params: {} }

  it("every expressible system renders parseable KaTeX", () => {
    const broken: string[] = []
    let checked = 0
    // Render each DISTINCT output once. The sweep enumerates ~8k systems but they
    // collapse onto far fewer equations, and KaTeX is the expensive part —
    // rendering the same string 200 times proves nothing and timed out CI.
    // Increased from default 5000ms — exhaustive sweep needs ~6s on CI runners.
    const distinct = new Map<string, string>()
    for (const platform of PLATFORMS)
      for (const a of ROLES)
        for (const b of ROLES)
          for (const kind of KINDS)
            for (const arch of ARCHES)
              for (const third of [false, true]) {
                const components = [mk(a, 1), mk(b, 2), ...(third ? [mk(b, 3)] : [])]
                const latex = systemHamiltonianLatex(
                  systemProjection({
                    platform,
                    ...(arch ? { drive: { arch } } : {}),
                    components,
                    couplings: [
                      { between: ["q1", "q2"], kind, params: {} },
                      ...(third ? [{ between: ["q2", "q3"], kind, params: {} }] : []),
                    ],
                  }),
                )
                // No output is the CORRECT answer when nothing in the system has
                // a model — there is no honest canonical form to fall back to.
                if (!latex) {
                  if (!unmodelled(a, platform) || !unmodelled(b, platform))
                    broken.push(`no output: ${platform}/${a}/${b}/${kind}`)
                  continue
                }
                // …and conversely, an all-unmodelled system must NOT produce one.
                if (unmodelled(a, platform) && unmodelled(b, platform))
                  broken.push(`invented a model for ${platform}/${a}/${b}/${kind}: ${latex}`)
                checked++
                if (!distinct.has(latex))
                  distinct.set(latex, `${platform}/${a}/${b}/${kind}/${arch}/N${components.length}`)
              }
    for (const [latex, where] of distinct) {
      try {
        katex.renderToString(latex, { throwOnError: true })
      } catch (err) {
        broken.push(`${where}: ${(err as Error).message}\n  ${latex}`)
      }
    }
    expect(checked).toBeGreaterThan(6000)
    expect(distinct.size).toBeGreaterThan(100) // the sweep really does vary the output
    expect(broken).toEqual([])
  }, 10000)

  it("survives malformed input without throwing", () => {
    const cases = [
      // coupling naming a component that doesn't exist
      { platform: "x", components: [{ id: "q1", role: "atom", levels: 3, params: {} }],
        couplings: [{ between: ["q1", "GHOST"], kind: "vdW", params: {} }] },
      // a one-ended coupling
      { platform: "x", components: [{ id: "q1", role: "qubit", levels: 3, params: {} }],
        couplings: [{ between: ["q1"], kind: "ZZ", params: {} }] },
      // no levels recorded anywhere
      { platform: "x", components: [{ id: "q1", role: "qubit", params: {} }], couplings: [] },
      // a mode-mediated hyperedge across three different roles
      { platform: "x",
        components: [
          { id: "q1", role: "qubit", levels: 3, params: {} },
          { id: "a1", role: "atom", levels: 3, params: {} },
          { id: "m1", role: "mode", levels: 8, params: {} },
        ],
        couplings: [{ between: ["q1", "a1", "m1"], kind: "mode-mediated", params: {} }] },
    ]
    for (const c of cases) {
      const latex = systemHamiltonianLatex(systemProjection(c as any))
      // undefined is allowed (nothing modelled); anything else must be renderable
      if (latex === undefined) continue
      expect(latex).toContain("\\hat H/\\hbar")
      expect(() => katex.renderToString(latex, { throwOnError: true })).not.toThrow()
    }
  })
})

describe("systemTableModel", () => {
  it("component + coupling rows", () => {
    const t = systemTableModel(systemProjection(twoTransmon))
    expect(t.components).toHaveLength(2)
    expect(t.components[0]).toMatchObject({ id: "q1", role: "qubit", levels: 3 })
    expect(t.components[0].params).toMatchObject({ omega: 4.0, delta: -0.2 })
    expect(t.couplings[0]).toMatchObject({ between: ["q1", "q2"], kind: "ZZ" })
  })
})

describe("componentPhysicsRows", () => {
  const labels = (c: any, platform?: string) => componentPhysicsRows(c, platform).map((r) => r.label)
  const row = (c: any, label: string, platform?: string) =>
    componentPhysicsRows(c, platform).find((r) => r.label === label)

  it("a rydberg atom is never asked for an anharmonicity — it gets detuning + Rabi", () => {
    const atom = { id: "q1", role: "atom", levels: 3, params: {} }
    expect(labels(atom)).not.toContain("anharmonicity")
    expect(labels(atom)).not.toContain("frequency")
    expect(labels(atom)).toEqual(["levels", "detuning", "rabi drive", "decay"])
    expect(row(atom, "detuning")!.state).toBe("missing")
  })

  it("a transmon keeps the frequency/anharmonicity/drive-bound spec", () => {
    const q = { id: "q1", role: "qubit", levels: 3, params: { omega: 4.8, delta: -0.2 } }
    expect(labels(q, "transmon")).toEqual(["levels", "frequency", "anharmonicity", "drive bound", "decay"])
    expect(row(q, "frequency", "transmon")).toMatchObject({ value: "4.8", state: "recorded" })
    expect(row(q, "drive bound", "transmon")).toMatchObject({ value: "not set", state: "missing" })
  })

  it("a TWO-level qubit has no anharmonicity row at all", () => {
    expect(labels({ id: "q1", role: "qubit", levels: 2, params: {} })).not.toContain("anharmonicity")
  })

  it("an off-template platform is NOT given the transmon model just because role defaults to qubit", () => {
    // platformDefaultRole maps every unfamiliar platform to "qubit", so an
    // exchange-only HRL-style spin qubit arrives here indistinguishable from a
    // transmon by role alone. It used to be handed ω, δ, |u| and the transmon
    // Hamiltonian; an exchange-only qubit has no anharmonicity to speak of.
    const hrl = { id: "q1", role: "qubit", params: {} }
    expect(labels(hrl)).toEqual(["levels"]) // no platform → nothing claimed
    expect(componentPhysicsRows(hrl, "hrl-spin").map((r) => r.label)).toEqual(["levels"])
    expect(componentPhysicsRows(hrl, "hrl-spin").map((r) => r.label)).not.toContain("anharmonicity")
    // …while a transmon, whose model we do have, still fills in before levels.
    expect(componentPhysicsRows(hrl, "transmon").map((r) => r.label)).toEqual([
      "levels",
      "frequency",
      "anharmonicity",
      "drive bound",
      "decay",
    ])
  })

  it("two levels earns the generic two-level model on any platform", () => {
    // Safe everywhere: every two-level system has a splitting and σx/σy control.
    const spin = { id: "q1", role: "qubit", levels: 2, params: {} }
    expect(componentPhysicsRows(spin, "hrl-spin").map((r) => r.label)).toEqual([
      "levels",
      "frequency",
      "drive bound",
      "decay",
    ])
    expect(componentPhysicsRows(spin, "hrl-spin").map((r) => r.label)).not.toContain("anharmonicity")
  })

  it("THREE levels is a dimension, not an oscillator — it earns no ladder off-template", () => {
    // Reported against `exchange-only-spin` at levels=3: the card still showed
    // ω â†â + δ/2 â†²â² + u₁(â+â†) + i u₂(â−â†) and asked for an anharmonicity.
    // An exchange-only qubit at levels=3 is three dots; a spin-1 defect is three
    // Zeeman sublevels. Neither is an anharmonic ladder.
    const three = { id: "q1", role: "qubit", levels: 3, params: {} }
    expect(componentPhysicsRows(three, "exchange-only-spin").map((r) => r.label)).toEqual(["levels"])
    // …and the platform whose qubits ARE ladders still gets one.
    expect(componentPhysicsRows(three, "transmon").map((r) => r.label)).toContain("anharmonicity")
  })

  it("an unrecognized role expects nothing — only what was recorded shows", () => {
    const spin = { id: "s1", role: "spin", params: { J_MHz: 12 } }
    expect(labels(spin)).toEqual(["levels", "J"])
    expect(row(spin, "levels")!.state).toBe("missing")
    expect(row(spin, "J")).toMatchObject({ value: "12 MHz", state: "recorded" })
  })

  it("unit-suffixed keys render their unit; bare keys never get an assumed one", () => {
    const c = { id: "q1", role: "qubit", levels: 3, params: { omega_GHz: 4.8, drive_max: 0.2 } }
    expect(row(c, "frequency", "transmon")!.value).toBe("4.8 GHz")
    expect(row(c, "drive bound", "transmon")!.value).toBe("≤ 0.2")
  })

  it("an atom's Δ does not absorb a transmon's δ — a stray delta stays unclaimed", () => {
    const atom = { id: "q1", role: "atom", levels: 3, params: { delta: 0.2 } }
    expect(row(atom, "detuning")!.state).toBe("missing")
    expect(row(atom, "delta")).toMatchObject({ sym: "δ", value: "0.2", state: "recorded" })
  })

  it("levels reads 'not set' rather than being silently omitted", () => {
    expect(row({ id: "q1", role: "qubit", params: {} }, "levels")).toMatchObject({
      value: "not set",
      state: "missing",
    })
  })

  it("a cavity gets frequency/kerr/linewidth, not a drive bound", () => {
    const cav = { id: "c1", role: "cavity", levels: 10, params: { K_c_Hz: 3.25 } }
    expect(labels(cav)).toEqual(["levels", "frequency", "kerr", "linewidth", "decay"])
    expect(row(cav, "kerr")!.value).toBe("3.25 Hz")
  })

  it("zero still reads as unset, and recorded T₁/T₂ collapse into one decay row", () => {
    const c = { id: "q1", role: "qubit", levels: 3, params: { omega: 0, T1: 30, T2: 20 } }
    expect(row(c, "frequency", "transmon")!.state).toBe("missing")
    expect(row(c, "decay", "transmon")).toMatchObject({ value: "T₁ 30 · T₂ 20", state: "recorded" })
  })
})

describe("systemCountLabel", () => {
  it("names N so an unanswered structure question can't read as 'one'", () => {
    expect(systemCountLabel(systemProjection(twoTransmon))).toBe("2 qubits × 3 levels")
    expect(systemCountLabel(systemProjection({ platform: "rydberg", params: {} }))).toBe("1 atom")
    expect(systemCountLabel(systemProjection({ platform: "x", components: [], couplings: [] }))).toBeUndefined()
  })
})

describe("systemIdentityLine", () => {
  it("summarizes platform · N role(s) × levels · arch", () => {
    expect(systemIdentityLine(systemProjection(twoTransmon))).toBe(
      "transmon · 2 qubits × 3 levels · per-component drive",
    )
  })
  it("singular role + global drive for a legacy flat rydberg (N=1)", () => {
    const p = systemProjection({ platform: "rydberg", levels: 3, params: {} })
    expect(systemIdentityLine(p)).toBe("rydberg · 1 atom × 3 levels · global drive")
  })
  it("omits the levels segment when components disagree", () => {
    const p = systemProjection({
      platform: "transmon",
      drive: { arch: "global" },
      components: [
        { id: "q1", role: "qubit", levels: 3, params: {} },
        { id: "c1", role: "cavity", levels: 10, params: {} },
      ],
      couplings: [],
    })
    // mixed roles → "component", mixed levels → no "× L levels"
    expect(systemIdentityLine(p)).toBe("transmon · 2 components · global drive")
  })
})
