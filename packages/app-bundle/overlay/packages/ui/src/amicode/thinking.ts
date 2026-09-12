// AMICODE: pure logic for the "thinking" working indicator (thinking-line.tsx).
// Split out from the SolidJS component so word rotation + label formatting are
// unit-testable without a DOM (fork convention: keep message/part render thin,
// test the pure bits — see run-series.ts / run-series.test.ts).

// Whimsical-but-tasteful gerunds shown while Amico works, in the spirit of the
// Claude Code CLI. Quantum-control domain (pulses, ions, gates), then a run of
// verbed physicist names, closing on a couple of house in-jokes (Ann's list,
// 2026-07-28). NO solver-progress words (Converging / Regularizing /
// Warm-starting): they read as "a solve is running" when none is. No trailing
// ellipsis here — the component appends the "…".
export const THINKING_WORDS = [
  "Oscillating",
  "Harmonizing",
  "Wiggling",
  "Noodling",
  "Tuning",
  "Entangling",
  "Superposing",
  "Tunneling",
  "Propagating",
  "Splining",
  "Bending",
  "Trotterizing",
  "Strumming",
  "Resonating",
  "Percolating",
  "Hyperfining",
  "Evolving",
  "ψing",
  "Spinning",
  "Fluxing",
  "Phasing",
  "Charging",
  "Emitting",
  "Not-leaking",
  "Undecohering",
  "Schröding",
  "Transporting",
  "Routing",
  "Teleporting",
  "Optimizing",
  "Bohring",
  "Noethering",
  "Plancking",
  "Skłodowskaing",
  "Fermiing",
  "Amplituding",
  "Braiding",
  "Unfrustrating",
  "Chirping",
  "Dzhanibekoving",
  "Pauliing",
  "Cating",
  "Bogoliuboving",
  "Hamiltonianing",
  "Piccoloing",
  "Fidelitymaxxing",
  "Ionizing",
  "Unionizing",
  "Quantizing",
  "Obsidianing",
] as const

/** Word for a given tick, cycling through THINKING_WORDS (wraps, incl. negatives). */
export function wordAt(tick: number): string {
  const n = THINKING_WORDS.length
  const i = ((Math.floor(tick) % n) + n) % n
  return THINKING_WORDS[i]
}

/** Fisher-Yates shuffle — returns a new array, never mutates the input. */
function shuffledCopy<T>(arr: readonly T[]): T[] {
  const out = [...arr]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const tmp = out[i]!
    out[i] = out[j]!
    out[j] = tmp
  }
  return out
}

/** Shuffled order — computed once at module load so a single turn cycles without repeats, but order varies across reloads. */
export const SHUFFLED_WORDS: readonly string[] = shuffledCopy(THINKING_WORDS)

/** Like wordAt but over the shuffled permutation — this is what the live thinker uses. */
export function shuffledWordAt(tick: number): string {
  const n = SHUFFLED_WORDS.length
  const i = ((Math.floor(tick) % n) + n) % n
  return SHUFFLED_WORDS[i]!
}

/** Compact elapsed label: 0s, 12s, 1m 03s, 12m 05s. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return m > 0 ? `${m}m ${s.toString().padStart(2, "0")}s` : `${s}s`
}

/** Minimal shape of the per-message token accounting we read
 *  (SDK v2 AssistantMessage.tokens — we only need the two growing fields). */
export interface TokenUsage {
  output?: number
  reasoning?: number
}

/** Tokens generated so far this turn — output + reasoning summed across the
 *  turn's assistant messages. This is the number that grows while Amico works;
 *  input/cache are excluded (they're static context, not "thinking" output). */
export function turnTokens(messages: ReadonlyArray<{ tokens?: TokenUsage | null }>): number {
  let n = 0
  for (const m of messages) {
    const t = m.tokens
    if (!t) continue
    n += (t.output ?? 0) + (t.reasoning ?? 0)
  }
  return n
}

/** Compact token label: 42 -> "42", 2400 -> "2.4k", 1_200_000 -> "1.2M". */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0"
  if (n < 1000) return String(Math.floor(n))
  if (n < 1_000_000) {
    const k = n / 1000
    return `${k >= 100 ? Math.round(k) : Math.round(k * 10) / 10}k`
  }
  const mm = n / 1_000_000
  return `${mm >= 100 ? Math.round(mm) : Math.round(mm * 10) / 10}M`
}
