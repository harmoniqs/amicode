// Hamiltonian term registry (#46, UX1) — pure mapping from the interview's
// physics option labels to rotating-frame Hamiltonian lines, so the view can
// assemble Ĥ(t) live as the user toggles terms. DOM-free by design: unit-
// testable in node, and shared with any future renderer venue.
//
// Conventions (single transmon, qubit-rotating frame, RWA): δ > 0 positive
// convention (the template's), two I/Q drive quadratures always present.

export interface HamiltonianTerm {
  /** Matches an option label / physics slot entry. */
  match: RegExp;
  /** One displayed term (unicode math — the fallback + test surface). */
  math: string;
  /** The same term as LaTeX (KaTeX-rendered in the panel). */
  latex: string;
  /** Physicist aside, rendered dim beside the line. */
  note?: string;
  /** Open-system effects enter the Lindbladian, never Ĥ. */
  lindblad?: boolean;
}

export const HAMILTONIAN_TERMS: HamiltonianTerm[] = [
  {
    match: /anharmonicity/i,
    math: "− (δ⁄2)·â†â†ââ",
    latex: "-\\tfrac{\\delta}{2}\\,\\hat a^{\\dagger}\\hat a^{\\dagger}\\hat a\\hat a",
    note: "anharmonicity (δ > 0 convention)",
  },
  {
    match: /zz|crosstalk/i,
    math: "+ ζ·(â†â ⊗ b̂†b̂)",
    latex: "+\\,\\zeta\\,\\bigl(\\hat a^{\\dagger}\\hat a\\otimes\\hat b^{\\dagger}\\hat b\\bigr)",
    note: "static ZZ with a spectator b̂",
  },
  {
    match: /coupler/i,
    math: "+ g(t)·(â b̂† + â† b̂)",
    latex: "+\\,g(t)\\,\\bigl(\\hat a\\hat b^{\\dagger}+\\hat a^{\\dagger}\\hat b\\bigr)",
    note: "tunable-coupler exchange",
  },
  {
    match: /t1|t2|decoher|dephas|dissipat|relax|noise/i,
    math: "𝓛[ρ̂] ⊃ γ₁·𝒟[â] + γ_φ·𝒟[â†â]",
    latex: "\\mathcal{L}[\\hat\\rho]\\supset\\gamma_1\\,\\mathcal{D}[\\hat a]+\\gamma_{\\phi}\\,\\mathcal{D}[\\hat a^{\\dagger}\\hat a]",
    note: "open-system — enters the Lindbladian, not Ĥ",
    lindblad: true,
  },
];

/** The controls — every gate problem drives the qubit, so this line is
 *  unconditional. */
export const DRIVE_LINE: HamiltonianLine = {
  math: "+ u₁(t)·(â + â†) + u₂(t)·i(â† − â)",
  latex: "+\\,u_1(t)\\,(\\hat a+\\hat a^{\\dagger})+u_2(t)\\,i\\,(\\hat a^{\\dagger}-\\hat a)",
  note: "I/Q drives (always present)",
};

/** LHS prefix for the first rendered line. */
export const LHS_LATEX = "\\hat H(t)/\\hbar \\;=\\; ";

export interface HamiltonianLine {
  math: string;
  latex: string;
  note?: string;
  lindblad?: boolean;
}

/** Sanitize a free-text label for embedding in \text{} — strip TeX-active
 *  characters rather than escape-juggling them. */
function texSafe(label: string): string {
  return label.replace(/[\\{}$%&#^_~]/g, " ").trim();
}

/** True when a physics option label maps to a known term — the view mounts
 *  the live-Hamiltonian panel iff a question offers at least one. */
export function isHamiltonianTerm(label: string): boolean {
  return HAMILTONIAN_TERMS.some((t) => t.match.test(label));
}

/** Assemble the display lines for a set of selected term labels: drift terms
 *  first, the drive line always, then interactions, then Lindblad asides.
 *  Unrecognized labels still show up (captured, agent-interpreted) — the
 *  panel must never silently drop physics the user asked for. */
export function hamiltonianLines(selected: string[]): HamiltonianLine[] {
  const drift: HamiltonianLine[] = [];
  const interactions: HamiltonianLine[] = [];
  const lindblad: HamiltonianLine[] = [];
  for (const s of selected) {
    if (!s.trim() || /^(none|default|just the basics)/i.test(s)) continue;
    const t = HAMILTONIAN_TERMS.find((t) => t.match.test(s));
    if (!t) {
      interactions.push({
        math: `+ Ĥ⟨${s}⟩(t)`,
        latex: `+\\,\\hat H_{\\langle\\text{${texSafe(s)}}\\rangle}(t)`,
        note: "captured — Amico will interpret",
      });
    } else if (t.lindblad) {
      lindblad.push({ math: t.math, latex: t.latex, note: t.note, lindblad: true });
    } else {
      (t.math.startsWith("−") ? drift : interactions).push({ math: t.math, latex: t.latex, note: t.note });
    }
  }
  return [...drift, DRIVE_LINE, ...interactions, ...lindblad];
}
