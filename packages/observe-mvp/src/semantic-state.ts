import type { Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { SemanticIndexBatch, SemanticRecord, SourceReference } from "./types.ts";

export const SEMANTIC_INDEX_ENTRY_TYPE = "observe.semantic-index";

export interface SemanticIndexState {
	semanticRecords: SemanticRecord[];
	semanticIndexBatches: SemanticIndexBatch[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function parseUsage(value: unknown): Usage | undefined {
	if (!isRecord(value) || !isRecord(value.cost)) return undefined;
	if (
		!isFiniteNumber(value.input) ||
		!isFiniteNumber(value.output) ||
		!isFiniteNumber(value.cacheRead) ||
		!isFiniteNumber(value.cacheWrite) ||
		!isFiniteNumber(value.totalTokens) ||
		(value.cacheWrite1h !== undefined && !isFiniteNumber(value.cacheWrite1h)) ||
		(value.reasoning !== undefined && !isFiniteNumber(value.reasoning)) ||
		!isFiniteNumber(value.cost.input) ||
		!isFiniteNumber(value.cost.output) ||
		!isFiniteNumber(value.cost.cacheRead) ||
		!isFiniteNumber(value.cost.cacheWrite) ||
		!isFiniteNumber(value.cost.total)
	) {
		return undefined;
	}
	return {
		input: value.input,
		output: value.output,
		cacheRead: value.cacheRead,
		cacheWrite: value.cacheWrite,
		...(value.cacheWrite1h === undefined ? {} : { cacheWrite1h: value.cacheWrite1h }),
		...(value.reasoning === undefined ? {} : { reasoning: value.reasoning }),
		totalTokens: value.totalTokens,
		cost: {
			input: value.cost.input,
			output: value.cost.output,
			cacheRead: value.cost.cacheRead,
			cacheWrite: value.cost.cacheWrite,
			total: value.cost.total,
		},
	};
}

function parseSourceReference(value: unknown): SourceReference | undefined {
	if (!isRecord(value)) return undefined;
	if (
		typeof value.sourceId !== "string" ||
		(value.entryId !== undefined && typeof value.entryId !== "string") ||
		(value.role !== "user" && value.role !== "assistant" && value.role !== "toolResult" && value.role !== "custom") ||
		(value.toolName !== undefined && typeof value.toolName !== "string") ||
		(value.command !== undefined && typeof value.command !== "string") ||
		!isFiniteNumber(value.timestamp) ||
		typeof value.contentHash !== "string" ||
		!isFiniteNumber(value.rawTokens)
	) {
		return undefined;
	}
	return {
		sourceId: value.sourceId,
		...(value.entryId === undefined ? {} : { entryId: value.entryId }),
		role: value.role,
		...(value.toolName === undefined ? {} : { toolName: value.toolName }),
		...(value.command === undefined ? {} : { command: value.command }),
		timestamp: value.timestamp,
		contentHash: value.contentHash,
		rawTokens: value.rawTokens,
	};
}

function parseSemanticRecord(value: unknown): SemanticRecord | undefined {
	if (!isRecord(value) || !Array.isArray(value.sourceRefs)) return undefined;
	if (
		value.schemaVersion !== 1 ||
		typeof value.recordId !== "string" ||
		typeof value.frameId !== "string" ||
		(value.disposition !== "retain" && value.disposition !== "trace" && value.disposition !== "drop") ||
		(value.interpretation !== undefined && typeof value.interpretation !== "string") ||
		(value.disposition !== "drop" && typeof value.interpretation !== "string") ||
		(value.disposition === "drop" && value.interpretation !== undefined) ||
		!isFiniteNumber(value.semanticTokens) ||
		(value.disposition === "drop" && value.semanticTokens !== 0) ||
		!isFiniteNumber(value.createdAt) ||
		(value.migrationId !== undefined && typeof value.migrationId !== "string")
	) {
		return undefined;
	}
	const sourceRefs: SourceReference[] = [];
	for (const source of value.sourceRefs) {
		const parsed = parseSourceReference(source);
		if (!parsed) return undefined;
		sourceRefs.push(parsed);
	}
	if (sourceRefs.length === 0) return undefined;
	return {
		schemaVersion: 1,
		recordId: value.recordId,
		frameId: value.frameId,
		sourceRefs,
		disposition: value.disposition,
		...(value.interpretation === undefined ? {} : { interpretation: value.interpretation }),
		semanticTokens: value.semanticTokens,
		createdAt: value.createdAt,
		...(value.migrationId === undefined ? {} : { migrationId: value.migrationId }),
	};
}

export function parseSemanticIndexBatch(value: unknown): SemanticIndexBatch | undefined {
	if (!isRecord(value) || !Array.isArray(value.records)) return undefined;
	if (
		value.schemaVersion !== 1 ||
		typeof value.generationId !== "string" ||
		typeof value.frameId !== "string" ||
		!isFiniteNumber(value.createdAt)
	) {
		return undefined;
	}
	const generationUsage = parseUsage(value.generationUsage);
	if (!generationUsage) return undefined;
	const records: SemanticRecord[] = [];
	for (const record of value.records) {
		const parsed = parseSemanticRecord(record);
		if (!parsed || parsed.frameId !== value.frameId) return undefined;
		records.push(parsed);
	}
	if (records.length === 0) return undefined;
	return {
		schemaVersion: 1,
		generationId: value.generationId,
		frameId: value.frameId,
		records,
		generationUsage,
		createdAt: value.createdAt,
	};
}

export function reconstructSemanticIndexState(entries: SessionEntry[]): SemanticIndexState {
	const semanticIndexBatches: SemanticIndexBatch[] = [];
	const seenGenerationIds = new Set<string>();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== SEMANTIC_INDEX_ENTRY_TYPE) continue;
		const batch = parseSemanticIndexBatch(entry.data);
		if (!batch || seenGenerationIds.has(batch.generationId)) continue;
		seenGenerationIds.add(batch.generationId);
		semanticIndexBatches.push(batch);
	}
	return {
		semanticIndexBatches,
		semanticRecords: semanticIndexBatches.flatMap((batch) => batch.records),
	};
}
