import { contentText, uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import { isFrameMemoryArm } from "./config.ts";
import { isDefaultObserveFrame } from "./default-frame.ts";
import { estimateFrameTokens } from "./frame-state.ts";
import { buildSemanticIndexPrompt, parseSemanticIndexResponse } from "./semantic-index-response.ts";
import { reconstructSemanticIndexState, SEMANTIC_INDEX_ENTRY_TYPE } from "./semantic-state.ts";
import { createSourceReference } from "./source-reference.ts";
import type { ObserveState, SemanticIndexBatch, SemanticRecord, SourceReference } from "./types.ts";

interface IndexCandidate {
	entry: Extract<SessionEntry, { type: "message" }>;
	source: SourceReference;
	serialized: string;
}

function isObserveLifecycleMessage(entry: Extract<SessionEntry, { type: "message" }>): boolean {
	if (entry.message.role === "toolResult") return entry.message.toolName === "observe";
	return (
		entry.message.role === "assistant" &&
		entry.message.content.some((part) => part.type === "toolCall" && part.name === "observe")
	);
}

function indexCandidates(state: ObserveState, entries: SessionEntry[]): IndexCandidate[] {
	const frame = state.activeFrame;
	if (!frame) return [];
	const indexedSourceIds = new Set(
		state.semanticRecords.flatMap((record) => record.sourceRefs.map((source) => source.sourceId)),
	);
	const candidates: IndexCandidate[] = [];
	for (const entry of entries) {
		if (
			entry.type !== "message" ||
			(!isDefaultObserveFrame(frame) && entry.message.timestamp < frame.createdAt) ||
			isObserveLifecycleMessage(entry)
		) {
			continue;
		}
		const source = createSourceReference(entry);
		if (!source || indexedSourceIds.has(source.sourceId)) continue;
		candidates.push({
			entry,
			source,
			serialized: serializeConversation(convertToLlm([entry.message])),
		});
		if (candidates.length === 16) break;
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
								candidates.map(({ source, serialized }) => ({ sourceId: source.sourceId, serialized })),
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
	const bySourceId = new Map(interpretations.map((record) => [record.sourceId, record]));
	const createdAt = Date.now();
	const records: SemanticRecord[] = candidates.map(({ source }) => {
		const semantic = bySourceId.get(source.sourceId);
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
	let batch: SemanticIndexBatch | undefined;
	try {
		batch = await generateSemanticIndexBatch(ctx, state, candidates);
	} catch (error) {
		if (ctx.hasUI) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Observe semantic indexing failed; raw context remains active: ${message}`, "warning");
		}
		return;
	}
	if (!batch) return;
	pi.appendEntry<SemanticIndexBatch>(SEMANTIC_INDEX_ENTRY_TYPE, batch);
	state.semanticIndexBatches.push(batch);
	state.semanticRecords.push(...batch.records);
}

export function registerSemanticIndexing(pi: ExtensionAPI, state: ObserveState): void {
	pi.on("session_start", (_event, ctx) => {
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
}
