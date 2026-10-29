// SSE FRAME SPLITTER (#1779, moved to its own module in #1790) — linear-time
// splitting of a decoded server-sent-event stream into whole frames. Shared by
// the fan-in relay's upstream reader (sse_fanin_driver.ts), the extension's SSE
// client (sse_client.ts) and the session multiplexer's stream reader. Kept free
// of any driver/aggregator imports so a reader can use it without pulling in
// the fan-in machinery.

/** The relay reader's frame splitter: decoded upstream text in, WHOLE frames out
 *  (delimiter-inclusive, verbatim). #1779: LINEAR in the text received. The old
 *  reader appended every chunk to the whole partial buffer and searched it from
 *  the start, so a multi-MB frame arriving in 64 KB chunks cost quadratic time.
 *  Now only the NEW chunk is scanned; a delimiter split across two chunks is
 *  caught by looking back into the partial frame (at most two characters),
 *  which is held as pieces and joined ONCE, when it completes.
 *
 *  A frame ends at a blank line — a line feed whose line is empty: `\n\n`, or
 *  with CRLF line endings `\r\n\r\n` (any LF/CRLF mix: `\n\r\n`, `\r\n\n`). The
 *  frame is relayed exactly as received, CRs and all — never normalized (#1264
 *  byte identity); the aggregator reads either line ending. */
export class SseFrameSplitter {
  /** The partial frame, as received (never re-copied while it grows). */
  private parts: string[] = [];
  /** The partial frame's last ≤2 characters — the lookback for a split delimiter. */
  private tail = "";

  /** Feed one decoded chunk; returns the frames it completed, in order. */
  push(chunk: string): string[] {
    const frames: string[] = [];
    if (chunk === "") return frames;
    const tail = this.tail;
    let start = 0; // where the partial frame resumes in this chunk
    let floor = -tail.length; // the current frame's first position (negative = in the tail)
    /** The character at chunk position `i` (negative reaches into the tail), or
     *  NaN before the current frame — a lookback never crosses a frame boundary. */
    const at = (i: number): number =>
      i < floor ? NaN : i >= 0 ? chunk.charCodeAt(i) : tail.charCodeAt(tail.length + i);
    let from = 0;
    let lf: number;
    while ((lf = chunk.indexOf("\n", from)) !== -1) {
      from = lf + 1;
      // the line this line feed ends is empty: it follows another line ending
      const prev = at(lf - 1);
      if (prev !== LF_CODE && !(prev === CR_CODE && at(lf - 2) === LF_CODE)) continue;
      this.parts.push(chunk.slice(start, from));
      frames.push(this.parts.length === 1 ? this.parts[0] : this.parts.join("")); // whole frame, delimiter-inclusive
      this.parts = [];
      start = floor = from;
    }
    if (start < chunk.length) {
      const rest = start === 0 ? chunk : chunk.slice(start);
      this.parts.push(rest);
      this.tail = rest.length >= 2 ? rest.slice(-2) : (start === 0 ? tail + rest : rest).slice(-2);
    } else {
      this.tail = ""; // a frame ended exactly at the chunk's end
    }
    return frames;
  }
}
const LF_CODE = 10;
const CR_CODE = 13;
