/** #1928 (A15): the engine hands a session's id to tool children only via the
 *  `shell.env` hook — never process.env. Export it as AMICO_SESSION_ID so an
 *  agent token mint binds principal.session and `amico review post-check`
 *  recognizes an in-session invocation. A missing/empty id changes nothing. */
export function applySessionEnv(
  input: { cwd?: string; sessionID?: string; callID?: string },
  output: { env: Record<string, string> },
): void {
  const id = input.sessionID;
  if (typeof id !== "string" || id === "") return;
  output.env.AMICO_SESSION_ID = id;
}
