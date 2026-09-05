import katex from "katex"
import { Marked, type MarkedExtension, type Tokens } from "marked"
import markedShiki from "marked-shiki"
import { markedCodeSpanBoundary } from "./marked-code-span"

export function createMarkdownParser(highlight: (code: string, language: string) => string | Promise<string>) {
  return new Marked(
    markedCodeSpanBoundary,
    {
      renderer: {
        link({ href, title, text }) {
          const titleAttr = title ? ` title="${title}"` : ""
          return `<a href="${href}"${titleAttr} class="external-link" target="_blank" rel="noopener noreferrer">${text}</a>`
        },
      },
    },
    katexExtension,
    markedShiki({ highlight }),
  )
}

// KaTeX ships no \Tr, \tr, braket, etc. — they are LaTeX packages (physics /
// \DeclareMathOperator), not core TeX — so an assistant writing quantum-control
// math ("\Tr(\rho)", "\ket{0}") produced red "undefined control sequence"
// errors. Register the operators/notation as macros so chat math renders. This
// is passed to every KaTeX render in this module via renderKatexToken.
const KATEX_MACROS: Record<string, string> = {
  "\\Tr": "\\operatorname{Tr}",
  "\\tr": "\\operatorname{tr}",
  "\\rank": "\\operatorname{rank}",
  "\\diag": "\\operatorname{diag}",
  "\\ket": "{\\left|#1\\right\\rangle}",
  "\\bra": "{\\left\\langle#1\\right|}",
  "\\braket": "{\\left\\langle#1\\right\\rangle}",
  "\\ketbra": "{\\left|#1\\right\\rangle\\!\\left\\langle#2\\right|}",
}

// Single-$ inline math — restored after #34850 removed it for currency false
// positives. Pandoc-style tight delimiters (no whitespace just inside either
// $), no digit-led content (so $5, and $30-and-$50 pairs, stay literal), no
// $$ adjacency, no escaped \$. One regex family, three shapes: the tokenizer
// start hint, the anchored tokenizer match, and the global replace below.
const singleDollarStartRegex = /(?<![\\$])\$(?!\$)/
const singleDollarTokenizerRegex = /^\$(?!\$|\s|\d)((?:\\.|[^$\\\n])+?)(?<![\\\s])\$(?!\$)/
const singleDollarInlineRegex = /(?<![\\$])\$(?!\$|\s|\d)((?:\\.|[^$\\\n])+?)(?<![\\\s])\$(?!\$)/g

export function renderMathInText(text: string): string {
  let result = text

  // Display math: $$...$$
  const displayMathRegex = /\$\$([\s\S]*?)\$\$/g
  result = result.replace(displayMathRegex, (_, math) => {
    try {
      return katex.renderToString(math, {
        displayMode: true,
        throwOnError: false,
        macros: KATEX_MACROS,
      })
    } catch {
      return `$$${math}$$`
    }
  })

  // Inline math: \(...\)
  const inlineMathRegex = /\\\(((?:\\.|[^\\\n])*?)\\\)/g
  result = result.replace(inlineMathRegex, (_, math) => {
    try {
      return katex.renderToString(math, {
        displayMode: false,
        throwOnError: false,
        macros: KATEX_MACROS,
      })
    } catch {
      return `\\(${math}\\)`
    }
  })

  // Inline math: $...$ (guarded — see singleDollarInlineRegex above)
  result = result.replace(singleDollarInlineRegex, (_, math) => {
    try {
      return katex.renderToString(math, {
        displayMode: false,
        throwOnError: false,
        macros: KATEX_MACROS,
      })
    } catch {
      return `$${math}$`
    }
  })

  return result
}

const inlineMathRegex = /^\\\(((?:\\.|[^\\\n])*?)\\\)/
const blockMathRegex = /^\$\$\n([\s\S]+?)\n\$\$(?:\n|$)/

export const katexExtension: MarkedExtension = {
  extensions: [
    {
      name: "inlineKatex",
      level: "inline",
      start(src) {
        const index = src.indexOf("\\(")
        if (index === -1) return
        return index
      },
      tokenizer(src) {
        const match = src.match(inlineMathRegex)
        if (!match) return
        return {
          type: "inlineKatex",
          raw: match[0],
          text: match[1].trim(),
          displayMode: false,
        }
      },
      renderer: renderKatexToken,
    },
    {
      name: "blockKatex",
      level: "block",
      tokenizer(src) {
        const match = src.match(blockMathRegex)
        if (!match) return
        return {
          type: "blockKatex",
          raw: match[0],
          text: match[1].trim(),
          displayMode: true,
        }
      },
      renderer: renderKatexToken,
    },
    {
      // Single-$ inline math (guarded, see singleDollar*Regex above). The
      // close-side (?!\$) keeps this from ever eating one half of $$..$$.
      name: "singleDollarKatex",
      level: "inline",
      start(src) {
        const match = src.match(singleDollarStartRegex)
        return match ? match.index : undefined
      },
      tokenizer(src) {
        const match = src.match(singleDollarTokenizerRegex)
        if (!match) return
        return {
          type: "singleDollarKatex",
          raw: match[0],
          text: match[1].trim(),
          displayMode: false,
        }
      },
      renderer: renderKatexToken,
    },
  ],
}

function renderKatexToken(token: Tokens.Generic) {
  return katex.renderToString(typeof token.text === "string" ? token.text : "", {
    displayMode: token.displayMode === true,
    throwOnError: false,
    macros: KATEX_MACROS,
  })
}
