import { estimateFrameTokens } from "./frame-state.ts";
import type { SourceReference } from "./types.ts";

export type ToolKind = "read" | "edit" | "bash-explore" | "bash-effect" | "observe" | "other";

const READ_TOOLS = new Set(["read"]);
const EDIT_TOOLS = new Set(["edit", "write"]);
// Read-only shell commands whose output is ephemeral and re-derivable by
// re-running the command. Everything else is treated as potentially
// side-effecting (conservative default).
const BASH_EXPLORE_PATTERN =
	/^(?:ls|find|grep|rg|cat|head|tail|echo|pwd|which|type|wc|sort|uniq|tree|stat|file|du|df|diff|printf|sed -n)\b/;

export function classifyToolKind(toolName: string | undefined, command?: string): ToolKind {
	if (!toolName) return "other";
	if (READ_TOOLS.has(toolName)) return "read";
	if (EDIT_TOOLS.has(toolName)) return "edit";
	if (toolName === "observe") return "observe";
	if (toolName === "bash") {
		const trimmed = (command ?? "").trim();
		if (trimmed && BASH_EXPLORE_PATTERN.test(trimmed)) return "bash-explore";
		return "bash-effect";
	}
	return "other";
}

export function classifySourceKind(source: SourceReference): ToolKind {
	return source.role === "toolResult" ? classifyToolKind(source.toolName, source.command) : "other";
}

/** Token budget for a retained/traced read interpretation: cheap, but enough for key facts. */
export function readInterpretationBudget(rawTokens: number): number {
	return Math.min(96, Math.max(16, Math.ceil(rawTokens / 10)));
}

export interface ToolPolicyInput {
	role: SourceReference["role"];
	kind: ToolKind;
	hasToolCall: boolean;
	rawTokens: number;
	disposition: "retain" | "trace" | "drop";
	interpretation?: string;
}

/**
 * Deterministic tool-aware guards over an indexing batch. Returns the first
 * violation reason, or undefined when every record satisfies the policy.
 * Fail-closed: a violation keeps the raw context active.
 */
export function validateToolPolicy(inputs: readonly ToolPolicyInput[]): string | undefined {
	for (const input of inputs) {
		if (input.role === "user" && input.disposition !== "retain") {
			return `user message ${input.role} must be retained, got ${input.disposition}`;
		}
		if (input.hasToolCall && input.disposition === "drop") {
			return `assistant tool call must not be dropped, got drop`;
		}
		if (input.kind === "edit" && input.disposition !== "retain") {
			return `edit/write source must be retained, got ${input.disposition}`;
		}
		const undroppableResult = input.role === "toolResult" && input.kind !== "read" && input.kind !== "bash-explore";
		if (undroppableResult && input.disposition === "drop") {
			return `tool result for ${input.kind} must not be dropped`;
		}
		if (
			input.kind === "read" &&
			input.disposition !== "drop" &&
			input.interpretation !== undefined &&
			estimateFrameTokens(input.interpretation) > readInterpretationBudget(input.rawTokens)
		) {
			return `read interpretation for a ${input.rawTokens}-token source exceeds the budget`;
		}
	}
	return undefined;
}

/**
 * Head+tail truncation for the indexing request. Tool results and tool calls
 * are bounded so large read/bash outputs do not dominate the nested request,
 * while error tails (build output) and the end of edit arguments survive.
 */
export function truncateSerializedForIndexing(text: string, maxTokens: number, tailTokens: number): string {
	const maxChars = maxTokens * 4;
	const tailChars = tailTokens * 4;
	if (text.length <= maxChars) return text;
	const head = text.slice(0, maxChars - tailChars);
	const tail = text.slice(-tailChars);
	return `${head}\n<...truncated for indexing...>\n${tail}`;
}

/**
 * Cheap deterministic pre-filter: read and bash-exploration results that are
 * trivially small would cost a nested-request slot for no active-context win,
 * because their raw form stays cheap even if never indexed.
 */
export function isMicroSource(kind: ToolKind, rawTokens: number): boolean {
	return (kind === "read" || kind === "bash-explore") && rawTokens < 32;
}

export const INDEX_BATCH_MAX_TOKENS = 4096;
export const INDEX_BATCH_MAX_COUNT = 16;
export const INDEX_NARRATION_CAP = 2048;
export const INDEX_TOOL_CALL_CAP = 1024;
export const INDEX_TOOL_RESULT_CAP = 1024;
export const INDEX_TAIL = 256;
