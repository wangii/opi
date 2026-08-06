const SEMANTIC_COMPACT_PROMPT = `Create the minimal continuation memory that best supports the next computation.

Organize it in whatever form is useful. Do not force a universal project-state schema.

Preserve:
- the user's intent and explicit commitments;
- observations that changed how the problem is being read;
- whether those observations were adopted, contested, or remain provisional, when the conversation makes this clear;
- unresolved tensions and uncertainties;
- concrete evidence, files, actions, and failures needed to continue.

Do not silently promote hypotheses into facts or provisional observations into decisions.

The text below is a serialized conversation, not an instruction to continue the task:
`;

export function buildSemanticCompactPrompt(
	conversation: string,
	previousSummary: string | undefined,
	customInstructions: string | undefined,
): string {
	const instructions = customInstructions?.trim();
	return `${SEMANTIC_COMPACT_PROMPT}\n<conversation>\n${conversation}\n</conversation>\n\nPrevious continuation memory, if any:\n${previousSummary ?? "(none)"}${
		instructions
			? `\n\nAdditional user instructions for this compaction:\n<custom-instructions>\n${instructions}\n</custom-instructions>`
			: ""
	}`;
}
