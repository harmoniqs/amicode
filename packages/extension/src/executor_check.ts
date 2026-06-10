// Type-level contract check (spec §9 AC): the extension consumes the β.1 library API.
// β.5 replaces this with the real RunsManager integration.
import type { Executor, RunHandle, RunEvent } from '@amicode/amico-run'

export type _ExecutorContract = {
  submit: Executor['submit']
  handle: Pick<RunHandle, 'runId' | 'runDir' | 'events' | 'finished' | 'abort'>
  event: RunEvent['kind']
}
