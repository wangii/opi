export const OBSERVE_TOOL_DESCRIPTION =
	"Use observe only when the current semantic framing may be hiding a materially different next action, or when the active frame no longer makes preserving and retrieving task-relevant information cheaper than equivalent raw context. Record a concise provisional frame without copying evidence already available through source references. After observing, perform one bounded task action before observing again, unless user input is genuinely required.";

export const OBSERVE_PROMPT_SNIPPET =
	"Record a concise provisional frame when the current framing hides a different action or stops compressing task-relevant information";

export const OBSERVE_PROMPT_GUIDELINES = [
	"Use observe only when a different reading would change the next one to three actions.",
	"Use observe when the active frame no longer compresses a meaningful window of task-relevant information.",
	"Keep observe frames concise enough that the frame plus its semantic records can be cheaper than equivalent raw context.",
	"Do not use observe for ordinary uncertainty, repetition, summaries, copying source evidence, or avoiding concrete execution.",
	"Do not call observe again merely because the same frame is still active; first perform one bounded task action.",
	"After observe, take one bounded action influenced by the new frame, or explain why user input is required.",
] as const;
