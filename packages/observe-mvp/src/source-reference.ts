import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { estimateFrameTokens } from "./frame-state.ts";
import type { SourceReference } from "./types.ts";

function normalizedSourceMessage(message: AgentMessage): string | undefined {
	switch (message.role) {
		case "user":
		case "assistant":
			return JSON.stringify({ role: message.role, content: message.content });
		case "toolResult":
			return JSON.stringify({
				role: message.role,
				toolCallId: message.toolCallId,
				toolName: message.toolName,
				content: message.content,
				isError: message.isError,
			});
		case "custom":
			return JSON.stringify({ role: message.role, customType: message.customType, content: message.content });
		default:
			return undefined;
	}
}

export function estimateRawMessageTokens(message: AgentMessage): number {
	return estimateFrameTokens(normalizedSourceMessage(message) ?? JSON.stringify(message));
}

export function messageReferenceKey(message: AgentMessage): string | undefined {
	const normalized = normalizedSourceMessage(message);
	if (normalized === undefined) return undefined;
	return `${message.role}:${message.timestamp}:${createHash("sha256").update(normalized).digest("hex")}`;
}

export function sourceReferenceKey(source: SourceReference): string {
	return `${source.role}:${source.timestamp}:${source.contentHash}`;
}

export interface ToolCallInfo {
	toolName: string;
	command?: string;
}

export function createSourceReference(
	entry: SessionEntry,
	toolCalls?: ReadonlyMap<string, ToolCallInfo>,
): SourceReference | undefined {
	if (entry.type !== "message") return undefined;
	const normalized = normalizedSourceMessage(entry.message);
	if (normalized === undefined) return undefined;
	const role = entry.message.role;
	if (role !== "user" && role !== "assistant" && role !== "toolResult" && role !== "custom") return undefined;
	const toolName = role === "toolResult" ? entry.message.toolName : undefined;
	const command = role === "toolResult" ? toolCalls?.get(entry.message.toolCallId)?.command : undefined;
	// Content-only hash for read results: stable across repeated reads of the
	// same file, so re-derivable reads are not re-indexed once indexed.
	const readContentHash =
		toolName === "read"
			? createHash("sha256").update(JSON.stringify(entry.message.content)).digest("hex")
			: undefined;
	return {
		sourceId: `entry:${entry.id}`,
		entryId: entry.id,
		role,
		...(toolName === undefined ? {} : { toolName }),
		...(command === undefined ? {} : { command }),
		...(readContentHash === undefined ? {} : { readContentHash }),
		timestamp: entry.message.timestamp,
		contentHash: createHash("sha256").update(normalized).digest("hex"),
		rawTokens: estimateRawMessageTokens(entry.message),
	};
}
