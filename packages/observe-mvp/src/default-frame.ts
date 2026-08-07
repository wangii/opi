import { createHash } from "node:crypto";

export const DEFAULT_FRAME_ENTRY_TYPE = "observe.default-frame";
export const DEFAULT_FRAME_CONTEXT_MESSAGE_TYPE = "observe.default-frame-context";

export const MAX_TASK_ANCHOR_LENGTH = 240;

/**
 * Normalized, bounded excerpt of a user prompt used as the task anchor. A
 * frame is a task-state model, so the default frame anchors on the actual
 * goal rather than on repository rules (which already live in the system
 * prompt through context files).
 */
function taskAnchor(prompt: string | undefined): string | undefined {
	if (!prompt) return undefined;
	const cleaned = prompt.replace(/\s+/g, " ").trim();
	if (!cleaned) return undefined;
	return cleaned.length <= MAX_TASK_ANCHOR_LENGTH ? cleaned : `${cleaned.slice(0, MAX_TASK_ANCHOR_LENGTH - 1)}…`;
}

export interface DefaultFrameDerivation {
	content: string;
	promptAnchor: string;
	activationSourceRef: string;
}

/**
 * A frame is a provisional, action-guiding hypothesis: it names what to
 * observe (the focus) and the conditions under which it must be corrected
 * (reframe triggers). The default frame is derived deterministically from the
 * session's first prompt; agent-authored frames (via observe) carry the same
 * structure and may make both parts fully task-specific.
 */
export function deriveDefaultFrame(prompt: string | undefined): DefaultFrameDerivation | undefined {
	const anchor = taskAnchor(prompt);
	if (anchor === undefined) return undefined;
	const content = [
		"Provisional task-state frame: a hypothesis that guides what to observe and when to reframe, not an instruction source.",
		"",
		`Focus (observe these dimensions): deliver the goal "${anchor}". Attend to evidence, decisions, constraints, and results that bear on it; track what is established, what is open, and what would change the next actions.`,
		"",
		"Reframe when (call observe to record a revised frame):",
		"- the goal above is delivered to the user and verified, or the user ends it;",
		"- the user redirects the task to a materially different goal;",
		"- evidence or user corrections contradict this focus;",
		"- the injected projection metrics show this frame no longer compresses task-relevant context.",
	].join("\n");
	const activationSourceRef = `prompt:${createHash("sha256").update(anchor).digest("hex")}`;
	return { content, promptAnchor: anchor, activationSourceRef };
}
