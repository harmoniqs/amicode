/** Pick the directory a new draft should be created in.
 *
 *  Prefers the first registered project. Falls back to the server's own working
 *  directory, because a server can legitimately run somewhere that was never
 *  registered as a project — the amicode chat server does exactly that, spawning
 *  in an internal scaffold dir. Without the fallback both the "/" landing route
 *  and the titlebar "+" return silently and the app renders nothing at all. */
export function resolveLandingDirectory(
  projects: readonly { worktree: string }[],
  serverDirectory: string | undefined,
): string | undefined {
  return projects[0]?.worktree ?? serverDirectory
}
