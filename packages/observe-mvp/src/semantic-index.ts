import { contentText, uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import { isFrameMemoryArm } from "./config.ts";
import { estimateFrameTokens } from "./frame-state.ts";
import { buildSemanticIndexPrompt, parseSemanticIndexResponse } from "./semantic-index-response.ts";
import { reconstructSemanticIndexState, SEMANTIC_INDEX_ENTRY_TYPE } from "./semantic-state.ts";
import { createSourceReference } from "./source-reference.ts";
import {
	classifySourceKind,
	INDEX_BATCH_MAX_COUNT,
	INDEX_BATCH_MAX_TOKENS,
	INDEX_NARRATION_CAP,
	INDEX_READ_CAP,
	INDEX_READ_TAIL,
	INDEX_TAIL,
	INDEX_TOOL_CALL_CAP,
	INDEX_TOOL_RESULT_CAP,
	isMicroSource,
	readInterpretationBudget,
	type ToolKind,
	truncateSerializedForIndexing,
	validateToolPolicy,
} from "./tool-policy.ts";
import type { ObserveState, SemanticIndexBatch, SemanticRecord, SourceReference } from "./types.ts";

const SEMANTIC_INDEX_STATUS_ID = "observe-semantic-index";

export function formatSemanticIndexStatus(sourceCount: number): string {
	return `indexing ${sourceCount} ${sourceCount === 1 ? "message" : "messages"}…`;
}

interface IndexCandidate {
	entry: Extract<SessionEntry, { type: "message" }>;
	source: SourceReference;
	serialized: string;
	kind: ToolKind;
	hasToolCall: boolean;
}

function isObserveLifecycleMessage(entry: Extract<SessionEntry, { type: "message" }>): boolean {
	if (entry.message.role === "toolResult") return entry.message.toolName === "observe";
	return (
		entry.message.role === "assistant" &&
		entry.message.content.some((part) => part.type === "toolCall" && part.name === "observe")
	);
}

function bashCommandFromCall(part: { type: "toolCall"; name: string; arguments?: unknown }): string | undefined {
	if (part.name !== "bash") return undefined;
	const command =
		typeof part.arguments === "object" && part.arguments !== null
			? (part.arguments as { command?: unknown }).command
			: undefined;
	return typeof command === "string" ? command : undefined;
}

function serializationCap(
	message: Extract<SessionEntry, { type: "message" }>["message"],
	kind: ToolKind,
): {
	maxTokens: number;
	tailTokens: number;
} {
	switch (message.role) {
		case "user":
			// User intent must be indexed with full fidelity.
			return { maxTokens: Number.POSITIVE_INFINITY, tailTokens: 0 };
		case "toolResult":
			if (kind === "read") return { maxTokens: INDEX_READ_CAP, tailTokens: INDEX_READ_TAIL };
			return { maxTokens: INDEX_TOOL_RESULT_CAP, tailTokens: INDEX_TAIL };
		case "assistant":
			if (message.content.some((part) => part.type === "toolCall")) {
				return { maxTokens: INDEX_TOOL_CALL_CAP, tailTokens: INDEX_TAIL };
			}
			return { maxTokens: INDEX_NARRATION_CAP, tailTokens: 0 };
		default:
			return { maxTokens: INDEX_TOOL_RESULT_CAP, tailTokens: INDEX_TAIL };
	}
}

function indexCandidates(state: ObserveState, entries: SessionEntry[]): IndexCandidate[] {
	const frame = state.activeFrame;
	if (!frame) return [];
	const indexedSourceIds = new Set(
		state.semanticRecords.flatMap((record) => record.sourceRefs.map((source) => source.sourceId)),
	);
	// Reads are re-derivable: once a given file content was indexed under the
	// active frame, a repeated identical read is skipped and stays raw in
	// context instead of being indexed (and possibly dropped) again. This
	// breaks the read -> drop -> re-read loop and saves nested-request tokens.
	const indexedReadHashes = new Set<string>();
	for (const record of state.semanticRecords) {
		if (record.frameId !== frame.frameId) continue;
		for (const source of record.sourceRefs) {
			if (source.role === "toolResult" && source.toolName === "read" && source.readContentHash !== undefined) {
				indexedReadHashes.add(source.readContentHash);
			}
		}
	}
	const toolCallById = new Map<string, { toolName: string; command?: string }>();
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		for (const part of entry.message.content) {
			if (part.type !== "toolCall") continue;
			const command = bashCommandFromCall(part);
			toolCallById.set(part.id, {
				toolName: part.name,
				...(command === undefined ? {} : { command }),
			});
		}
	}
	const candidates: IndexCandidate[] = [];
	let batchTokens = 0;
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.timestamp < frame.createdAt || isObserveLifecycleMessage(entry)) {
			continue;
		}
		const source = createSourceReference(entry, toolCallById);
		if (!source || indexedSourceIds.has(source.sourceId)) continue;
		const kind = classifySourceKind(source);
		if (source.role === "toolResult" && isMicroSource(kind, source.rawTokens)) continue;
		if (
			source.role === "toolResult" &&
			source.toolName === "read" &&
			source.readContentHash !== undefined &&
			indexedReadHashes.has(source.readContentHash)
		) {
			continue;
		}
		const hasToolCall =
			entry.message.role === "assistant" && entry.message.content.some((part) => part.type === "toolCall");
		const { maxTokens, tailTokens } = serializationCap(entry.message, kind);
		const serialized = truncateSerializedForIndexing(
			serializeConversation(convertToLlm([entry.message])),
			maxTokens,
			tailTokens,
		);
		const serializedTokens = estimateFrameTokens(serialized);
		if (candidates.length > 0 && batchTokens + serializedTokens > INDEX_BATCH_MAX_TOKENS) break;
		candidates.push({ entry, source, serialized, kind, hasToolCall });
		batchTokens += serializedTokens;
		if (candidates.length >= INDEX_BATCH_MAX_COUNT) break;
	}
	return candidates;
}

async function generateSemanticIndexBatch(
	ctx: ExtensionContext,
	state: ObserveState,
	candidates: IndexCandidate[],
): Promise<SemanticIndexBatch | undefined> {
	const frame = state.activeFrame;
	const model = ctx.model;
	if (!frame || !model || candidates.length === 0) return undefined;
	const response = await ctx.modelRegistry.complete(
		model,
		{
			systemPrompt: "You create concise, source-grounded semantic memory under a provisional frame.",
			messages: [
				{
					role: "user",
					content: [
						{
							type: "text",
							text: buildSemanticIndexPrompt(
								frame.content,
								candidates.map(({ source, serialized, kind }) => ({
									sourceId: source.sourceId,
									serialized,
									kind,
									rawTokens: source.rawTokens,
									...(kind === "read" ? { readBudget: readInterpretationBudget(source.rawTokens) } : {}),
								})),
							),
						},
					],
					timestamp: Date.now(),
				},
			],
		},
		{
			cacheRetention: "none",
			sessionId: uuidv7(),
			...(ctx.signal ? { signal: ctx.signal } : {}),
			maxTokens: Math.min(4096, Math.max(512, candidates.length * 256)),
			reasoning: ctx.thinkingLevel,
		},
	);
	if (response.stopReason === "error") return undefined;
	const interpretations = parseSemanticIndexResponse(
		contentText(response.content),
		candidates.map(({ source }) => source.sourceId),
	);
	if (!interpretations || state.activeFrame?.frameId !== frame.frameId) return undefined;
	const interpretationBySourceId = new Map(interpretations.map((record) => [record.sourceId, record]));
	const violation = validateToolPolicy(
		candidates.map(({ source, kind, hasToolCall }) => {
			const interpretation = interpretationBySourceId.get(source.sourceId);
			if (interpretation === undefined) throw new Error(`Missing semantic disposition for ${source.sourceId}`);
			return {
				role: source.role,
				kind,
				hasToolCall,
				rawTokens: source.rawTokens,
				disposition: interpretation.disposition,
				...(interpretation.interpretation === undefined ? {} : { interpretation: interpretation.interpretation }),
			};
		}),
	);
	if (violation) return undefined;
	const createdAt = Date.now();
	const records: SemanticRecord[] = candidates.map(({ source }) => {
		const semantic = interpretationBySourceId.get(source.sourceId);
		if (semantic === undefined) throw new Error(`Missing semantic disposition for ${source.sourceId}`);
		return {
			schemaVersion: 1,
			recordId: uuidv7(),
			frameId: frame.frameId,
			sourceRefs: [source],
			disposition: semantic.disposition,
			...(semantic.interpretation === undefined ? {} : { interpretation: semantic.interpretation }),
			semanticTokens: semantic.interpretation === undefined ? 0 : estimateFrameTokens(semantic.interpretation),
			createdAt,
		};
	});
	return {
		schemaVersion: 1,
		generationId: uuidv7(),
		frameId: frame.frameId,
		records,
		generationUsage: response.usage,
		createdAt,
	};
}

async function indexPersistedMessages(pi: ExtensionAPI, state: ObserveState, ctx: ExtensionContext): Promise<void> {
	if (!isFrameMemoryArm(state.arm) || !state.activeFrame) return;
	const candidates = indexCandidates(state, ctx.sessionManager.getBranch());
	if (candidates.length === 0) return;
	if (ctx.mode === "tui") {
		ctx.ui.setStatus(
			SEMANTIC_INDEX_STATUS_ID,
			`${ctx.ui.theme.fg("accent", "观")} ${ctx.ui.theme.fg("dim", formatSemanticIndexStatus(candidates.length))}`,
		);
	}
	let batch: SemanticIndexBatch | undefined;
	try {
		batch = await generateSemanticIndexBatch(ctx, state, candidates);
	} catch (error) {
		if (ctx.hasUI) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Observe semantic indexing failed; raw context remains active: ${message}`, "warning");
		}
		return;
	} finally {
		if (ctx.mode === "tui") ctx.ui.setStatus(SEMANTIC_INDEX_STATUS_ID, undefined);
	}
	if (!batch) return;
	pi.appendEntry<SemanticIndexBatch>(SEMANTIC_INDEX_ENTRY_TYPE, batch);
	state.semanticIndexBatches.push(batch);
	state.semanticRecords.push(...batch.records);
}

export function registerSemanticIndexing(pi: ExtensionAPI, state: ObserveState): void {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode === "tui") ctx.ui.setStatus(SEMANTIC_INDEX_STATUS_ID, undefined);
		const restored = reconstructSemanticIndexState(ctx.sessionManager.getBranch());
		state.semanticIndexBatches = restored.semanticIndexBatches;
		state.semanticRecords = restored.semanticRecords;
	});
	pi.on("turn_start", async (_event, ctx) => {
		await indexPersistedMessages(pi, state, ctx);
	});
	pi.on("turn_end", async (_event, ctx) => {
		await indexPersistedMessages(pi, state, ctx);
	});
	pi.on("agent_settled", async (_event, ctx) => {
		await indexPersistedMessages(pi, state, ctx);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.mode === "tui") ctx.ui.setStatus(SEMANTIC_INDEX_STATUS_ID, undefined);
	});
}
