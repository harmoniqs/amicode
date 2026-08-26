// Pure DAG scheduler for the multipartite setup interview (spec-20260709 §4.1).
//
// v1: this is the tested REFERENCE that the AGENTS.md / SCORE frontier-batching
// policy mirrors — the LLM follows that prose to build each `question` payload;
// nothing wires `frontier` to a runtime caller yet (the acknowledged §4.1 gap).
// Pure, no I/O, so it is directly unit-testable and drift-checkable.

export interface QNode {
  id: string;
  /** Node ids whose answers must exist before this node is askable. */
  prereqs: string[];
  /** Value predicate over PRIOR answers; default () => true. Prunes an
   *  answered-prereqs-but-IRRELEVANT node out of the frontier (e.g. `topology`
   *  only when component-count > 1; "which state" only if target === "state"). */
  relevant?: (answers: Record<string, unknown>) => boolean;
  /** Prior answer ids whose VALUES generate this node's options — a
   *  value-dependent node is not askable until they are answered (its option
   *  set cannot be computed otherwise). */
  optionsFrom?: string[];
  /** false = semantic/branching, ask SINGLY (platform, target, objective);
   *  true = mechanical, batchable into one multi-question `question` call. */
  batchable: boolean;
}

const answered = (answers: Record<string, unknown>, id: string): boolean =>
  Object.prototype.hasOwnProperty.call(answers, id) && answers[id] !== undefined;

/**
 * The nodes answerable NOW: not already answered, every `prereqs` id answered,
 * every `optionsFrom` id answered (options computable), and `relevant(answers)`
 * true. Pruned/blocked nodes are simply absent from the returned list. Pure.
 *
 * The caller batches all `batchable: true` results into ONE `question` tool call
 * and asks each `batchable: false` result singly, re-running after each submit.
 */
export function frontier(graph: QNode[], answers: Record<string, unknown>): QNode[] {
  return graph.filter((n) => {
    if (answered(answers, n.id)) return false; // already answered
    if (!n.prereqs.every((id) => answered(answers, id))) return false; // prereqs unmet
    if (n.optionsFrom && !n.optionsFrom.every((id) => answered(answers, id))) return false; // options not computable
    if (n.relevant && !n.relevant(answers)) return false; // irrelevant given prior values
    return true;
  });
}
