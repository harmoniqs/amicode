// @ts-nocheck
import { ThinkingLine } from "./thinking-line"

export default {
  title: "Amicode/ThinkingLine",
  id: "amicode-thinking-line",
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component: `### Thinking block

The Claude-Code-esque "working" indicator shown while a reply streams. A
two-row grid block: the harmonic wave glyph and cycling gerund ride the top
row; the live meta line (elapsed · tokens · esc) sits below, starting under
the wave. The verb reserves the longest gerund's width so word rotation never
shifts the layout, and the meta can never wrap mid-phrase. Verbs are shuffled
per mount so each turn opens on a different word.

Under \`prefers-reduced-motion\` the wave and word are static; the elapsed
counter still advances (it's information, not decoration).`,
      },
    },
  },
}

const Frame = (props) => (
  <div style={{ padding: "16px", "font-size": "13px", display: "flex", "flex-direction": "column", gap: "4px" }}>
    {props.children}
  </div>
)

export const Default = () => (
  <Frame>
    <ThinkingLine />
  </Frame>
)

export const WithTokens = () => (
  <Frame>
    <ThinkingLine tokens={2437} />
  </Frame>
)

export const Interruptible = () => (
  <Frame>
    <ThinkingLine tokens={12800} interruptible />
  </Frame>
)
