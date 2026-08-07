export const OBSERVE_TOOL_DESCRIPTION =
	"Record a concise provisional frame that is action-guiding: state what to observe (the current goal and the dimensions that bear on delivering it) and what must trigger a correction (which actions or results, once they occur, require revising this frame with observe). Use observe only when the current semantic framing may be hiding a materially different next action, or when the active frame no longer makes preserving and retrieving task-relevant information cheaper than equivalent raw context. Do not copy evidence already available through source references. After observing, perform one bounded task action before observing again, unless user input is genuinely required.";

export const OBSERVE_PROMPT_SNIPPET =
	"Record a concise provisional frame: the focus to observe and the actions or results that, once they occur, require revising the frame";

export const OBSERVE_PROMPT_GUIDELINES = [
	"Use observe only when a different reading would change the next one to three actions.",
	"Use observe when the active frame no longer compresses a meaningful window of task-relevant information.",
	"Keep observe frames concise enough that the frame plus its semantic records can be cheaper than equivalent raw context.",
	"Every frame must be action-guiding: name the focus to observe (goal and the dimensions that bear on it) and the reframe conditions (which actions or results, once they occur, require revising the frame).",
	"Do not use observe for ordinary uncertainty, repetition, summaries, copying source evidence, or avoiding concrete execution.",
	"Do not call observe again merely because the same frame is still active; first perform one bounded task action.",
	"After observe, take one bounded action influenced by the new frame, or explain why user input is required.",
	"Reconsider the frame (call observe) when new evidence contradicts it, the task goal or constraints changed, or the injected projection metrics show the frame is not compressing context.",
] as const;
