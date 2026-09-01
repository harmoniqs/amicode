---
name: paper-writer
description: Gated agentic paper-writing workflow — outline-first, section-by-section, content-provenance. Use when the user asks to write, format, or edit sections of a research paper.
agents: []
surface: public
---

# Paper Writer

A gated workflow for formatting research papers from a user-authored outline.
The researcher owns the intellectual content; the agent is a typesetter, not a
co-author.

## Gate model

This skill enforces two classes of gate:

- **Hard gates** — code-enforced by checking files and frontmatter before
  acting. The agent reads `paper/outline.md`, inspects its YAML frontmatter,
  and refuses to proceed if the gate conditions are not met. These are
  deterministic.
- **Soft gates** — LLM instructions that guide behavior probabilistically.
  They work as well as the model's instruction-following allows. This skill
  is honest about the distinction.

## Hard gates

### 1. Outline-first gate

**Before writing any content in `paper/main.tex`**, check that
`paper/outline.md` exists AND its YAML frontmatter has `status: final` (not
`draft`).

If the outline is missing or still `status: draft`, **refuse** with:

> "I need a finalized outline before writing the paper. Your outline is
> currently [missing / draft]. Please review `paper/outline.md`, mark each
> section as ready, and set `status: final` in the frontmatter."

The user controls when the outline is final. The agent never changes the
outline's `status` field.

### 2. Section-by-section approval

Format **one section at a time** in this order:

1. Read the section's outline bullets from `paper/outline.md`
2. Expand the bullets into LaTeX prose in `paper/main.tex`
3. Present the formatted section to the user for review
4. Wait for explicit approval before proceeding to the next section

After user approval, add the section name to the `sections_approved[]` array
in `paper/outline.md` frontmatter. Never format a section already in the
approved list unless the user explicitly asks for a revision.

### 3. Abstract prohibition

The abstract is **always** user-authored. Never generate an abstract. If the
user asks the agent to write the abstract, respond:

> "The abstract is your synthesis of the work — I can proofread or format it,
> but I shouldn't write it. Draft your abstract in the outline and I'll
> typeset it."

## Soft gates (LLM instructions)

These are behavioral rules, not code-enforceable constraints. They guide the
agent's output quality but are probabilistic.

### Content provenance

Every paragraph in `paper/main.tex` must trace back to a specific bullet in
`paper/outline.md`. When expanding a bullet into prose, cite the outline
bullet in a LaTeX comment:

```latex
% outline: Results > bullet 3
The optimized pulse achieves $F = 0.9995$ in 42~ns...
```

### Forbidden actions

The agent MUST NOT:

1. **Generate novel conclusions** — only format what the outline says
2. **Interpret results** — report numbers; do not explain their significance
   beyond what the outline states
3. **Generate the abstract** — always user-authored (hard gate above)
4. **Select emphasis** — do not add "importantly," "notably," "remarkably" or
   similar editorial emphasis not present in the outline
5. **Invent methodology details** — only include methods described in the
   outline or referenced in `scripts/experiment/` (optimization solves) and
   `scripts/testbed/` (system environment)
6. **Hallucinate citations** — only cite references that exist in
   `paper/references.bib`

### Data grounding

Quantitative claims (fidelities, gate times, error rates, etc.) must cite
their source file in `data/`. When expanding an outline bullet that contains a
number, verify the number appears in a referenced data file. If the number
cannot be traced to `data/`, flag it:

```latex
% WARNING: F = 0.9995 not found in data/ — verify before submission
```

## Capabilities

The paper-writer skill supports seven operations:

1. **Sentence expansion from outline** — expand outline bullets into
   well-formed LaTeX paragraphs, one section at a time
2. **Data citation with inline results** — embed quantitative results from
   `data/` files inline, with provenance comments
3. **Figure placement and captioning** — insert `\includegraphics` for files
   in `paper/figures/`, draft captions from outline descriptions
4. **Bibliography management** — add BibTeX entries to `paper/references.bib`,
   insert `\cite{}` references where the outline indicates citations
5. **Outline gap detection** — identify outline sections that are too thin to
   expand into a full section and suggest what's missing
6. **Proofreading** — fix grammar, punctuation, and LaTeX formatting in
   already-approved sections (does not change technical content)
7. **Equation formatting** — convert inline math descriptions in the outline
   to properly formatted LaTeX equations

## Venue-aware outline templates

When scaffolding `paper/outline.md` for a new project, use the template
matching the project's venue. These templates define the section structure the
paper-writer expects.

### PRL (Physical Review Letters) — compressed format

```markdown
---
status: draft
last_reviewed:
sections_approved: []
---

# [Title]

**Research question:** [question]

## Outline (PRL compressed format)

### Abstract
- [ ] [User-authored summary — max 600 words]

### Introduction
- [ ] Context and motivation (1-2 paragraphs)
- [ ] State of the art and gap
- [ ] Our contribution (one sentence)

### Results
- [ ] Main result with key figure
- [ ] Supporting measurements
- [ ] Comparison with prior work

### Discussion
- [ ] Interpretation of results
- [ ] Limitations
- [ ] Outlook

### Methods
- [ ] Experimental/computational setup
- [ ] Key parameters and their justification

### Supplementary
- [ ] Extended data tables
- [ ] Additional figures
- [ ] Detailed derivations
```

### PRX Quantum — full format

```markdown
---
status: draft
last_reviewed:
sections_approved: []
---

# [Title]

**Research question:** [question]

## Outline (PRX Quantum full format)

### Abstract
- [ ] [User-authored summary]

### Introduction
- [ ] Broad context (1 paragraph)
- [ ] Specific problem and prior work (2-3 paragraphs)
- [ ] Gap in existing approaches
- [ ] Our approach and key results (1 paragraph)
- [ ] Paper organization

### Background
- [ ] Notation and conventions
- [ ] Review of relevant theory
- [ ] System model

### Methods
- [ ] Problem formulation
- [ ] Optimization approach
- [ ] Computational details

### Results
- [ ] Main result
- [ ] Systematic study / parameter sweep
- [ ] Robustness analysis
- [ ] Comparison with baselines

### Discussion
- [ ] Interpretation
- [ ] Connections to related work
- [ ] Limitations and assumptions
- [ ] Future directions

### Conclusion
- [ ] Summary of contributions
- [ ] Open questions

### Acknowledgments
- [ ] Funding, collaborators
```

### arXiv general

```markdown
---
status: draft
last_reviewed:
sections_approved: []
---

# [Title]

**Research question:** [question]

## Outline

### Abstract
- [ ] [User-authored summary]

### Introduction
- [ ] Motivation and context
- [ ] Prior work
- [ ] Our contribution

### Methods
- [ ] Approach description
- [ ] Implementation details

### Results
- [ ] Key findings
- [ ] Supporting evidence

### Discussion
- [ ] Implications
- [ ] Limitations

### Conclusion
- [ ] Summary and outlook
```

### Minimal (no venue)

```markdown
---
status: draft
last_reviewed:
sections_approved: []
---

# [Title]

**Research question:** [question]

## Outline

### Abstract
- [ ] [User-authored summary]

### Introduction
- [ ] TODO

### Methods
- [ ] TODO

### Results
- [ ] TODO

### Discussion
- [ ] TODO

### Conclusion
- [ ] TODO
```

## Overriding per-project

A Research Project can override this skill by placing a custom
`skills/paper-writer/SKILL.md` in its project directory. The project version
shadows the shipped version (project > custom > workspace > shipped in the
skill merge chain). This lets a team enforce lab-specific writing conventions
or venue requirements.
