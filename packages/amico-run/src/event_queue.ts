/** Push-based AsyncIterable: producer pushes, single consumer iterates. */
export class EventQueue<T> implements AsyncIterable<T> {
  private buf: T[] = []
  private waiters: Array<(r: IteratorResult<T>) => void> = []
  private ended = false

  push(v: T): void {
    if (this.ended) return   // late producers (post-settle) are dropped, never buffered
    const w = this.waiters.shift()
    if (w) w({ value: v, done: false })
    else this.buf.push(v)
  }
  close(): void {
    this.ended = true
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true })
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buf.length > 0) return Promise.resolve({ value: this.buf.shift()!, done: false })
        if (this.ended) return Promise.resolve({ value: undefined as never, done: true })
        return new Promise(res => this.waiters.push(res))
      },
    }
  }
}
