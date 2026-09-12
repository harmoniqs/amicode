/** Whether the user-message text bubble should mount in the DOM.
 *  Prevents an empty styled div from rendering when a skill-only
 *  invocation carries no body text and no inline comments.  */
export function shouldShowUserMessageText(text: string, commentsCount: number) {
  return !!text.trim() || commentsCount > 0
}
