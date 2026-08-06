import type { ToolKind } from "./tool-policy.ts";

export interface SemanticPromptSource {
	sourceId: string;
	serialized: string;
	kind: ToolKind;
	rawTokens: number;
	/** Explicit read interpretation budget for read-kind sources. */
	readBudget?: number;
}

export interface SemanticInterpretation {
	sourceId: string;
	disposition: "retain" | "trace" | "drop";
	interpretation?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function buildSemanticIndexPrompt(frame: string, sources: SemanticPromptSource[]): string {
	const serializedSources = sources
		.map(
			({ sourceId, serialized, kind, rawTokens, readBudget }) =>
				`<source id=${JSON.stringify(sourceId)} kind=${JSON.stringify(kind)} rawTokens=${JSON.stringify(String(rawTokens))}${
					readBudget === undefined ? "" : ` readBudget=${JSON.stringify(String(readBudget))}`
				}>\n${serialized}\n</source>`,
		)
		.join("\n\n");
	return `Interpret each source under the active provisional frame and produce the minimum continuation-relevant semantic record.

Requirements:
- return exactly one record for every source id;
- choose disposition "retain" for evidence or commitments needed later;
- choose disposition "trace" for a minimal operational fact such as an action and whether it succeeded;
- choose disposition "drop" only for redundant assistant narration or for read/exploration results that add no future value under this frame;
- never drop a user message, user commitment, or assistant tool call;
- for every tool call/result, keep a concise operational trace of what was attempted, whether it succeeded or failed, and any substantive finding or state change;
- retain assistant decisions, conclusions, plans, file changes, and unresolved blockers; drop only redundant narration;
- preserve evidence that contradicts or pressures the frame;
- keep hypotheses provisional;
- do not copy raw wording when a shorter interpretation is sufficient;
- do not invent source ids;
- make retained and trace interpretations cheaper than their raw sources.

Tool-kind retention rules:
- user messages: always "retain";
- assistant tool calls: never "drop" (they record what was attempted);
- edit/write calls and results: always "retain"; include file path, what changed, intent, and verification status; never "trace"-only or "drop";
- bash results with side effects (install, commit, move/delete, tests, builds): never "drop"; keep whether it succeeded and the key error or outcome;
- bash exploration (ls, find, grep, cat, head, tail): at most a one-line "trace", or "drop" when nothing useful was learned;
- read results (files stay on disk and can be re-read): keep only the facts that matter under the frame; "drop" is allowed when nothing frame-relevant was learned; retained/traced interpretations must not exceed the source's stated read budget;
- other tool results: never "drop"; keep a concise operational trace.

For "retain" and "trace", include a non-empty interpretation. For "drop", omit interpretation.
Return only JSON with this shape:
{"records":[{"sourceId":"entry:...","disposition":"retain|trace|drop","interpretation":"..."}]}

<active-frame>
${frame}
</active-frame>

<sources>
${serializedSources}
</sources>`;
}

export function parseSemanticIndexResponse(
	text: string,
	expectedSourceIds: readonly string[],
): SemanticInterpretation[] | undefined {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start === -1 || end < start) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(text.slice(start, end + 1));
	} catch {
		return undefined;
	}
	if (!isRecord(parsed) || !Array.isArray(parsed.records)) return undefined;

	const expected = new Set(expectedSourceIds);
	const seen = new Set<string>();
	const records: SemanticInterpretation[] = [];
	for (const candidate of parsed.records) {
		if (
			!isRecord(candidate) ||
			typeof candidate.sourceId !== "string" ||
			(candidate.disposition !== "retain" && candidate.disposition !== "trace" && candidate.disposition !== "drop")
		) {
			return undefined;
		}
		if (!expected.has(candidate.sourceId) || seen.has(candidate.sourceId)) return undefined;
		const interpretation = typeof candidate.interpretation === "string" ? candidate.interpretation.trim() : undefined;
		if (candidate.disposition !== "drop" && !interpretation) return undefined;
		seen.add(candidate.sourceId);
		records.push({
			sourceId: candidate.sourceId,
			disposition: candidate.disposition,
			...(candidate.disposition === "drop" ? {} : { interpretation }),
		});
	}
	if (seen.size !== expected.size) return undefined;
	return records;
}
