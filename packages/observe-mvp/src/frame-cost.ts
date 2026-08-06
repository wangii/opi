import type { ObserveFrame, SemanticRecord, SourceReference } from "./types.ts";

export interface FrameCostSnapshot {
	frameId: string;
	rawTokens: number;
	semanticTokens: number;
	frameTokens: number;
	framedTokens: number;
	sourceCount: number;
	compressionRatio: number | undefined;
}

export function calculateFrameCost(frame: ObserveFrame, records: SemanticRecord[]): FrameCostSnapshot {
	const latestRecordBySourceId = new Map<string, SemanticRecord>();
	for (const record of records) {
		if (record.frameId !== frame.frameId) continue;
		for (const source of record.sourceRefs) latestRecordBySourceId.set(source.sourceId, record);
	}

	const sourceById = new Map<string, SourceReference>();
	const recordById = new Map<string, SemanticRecord>();
	for (const [sourceId, record] of latestRecordBySourceId) {
		const source = record.sourceRefs.find((candidate) => candidate.sourceId === sourceId);
		if (source) sourceById.set(sourceId, source);
		recordById.set(record.recordId, record);
	}
	const rawTokens = [...sourceById.values()].reduce((total, source) => total + source.rawTokens, 0);
	const semanticTokens = [...recordById.values()].reduce((total, record) => total + record.semanticTokens, 0);
	const framedTokens = frame.frameTokens + semanticTokens;
	return {
		frameId: frame.frameId,
		rawTokens,
		semanticTokens,
		frameTokens: frame.frameTokens,
		framedTokens,
		sourceCount: sourceById.size,
		compressionRatio: rawTokens === 0 ? undefined : framedTokens / rawTokens,
	};
}

export function hasFrameCompressionFailed(snapshot: FrameCostSnapshot): boolean {
	return (snapshot.sourceCount >= 3 || snapshot.rawTokens >= 512) && snapshot.framedTokens >= snapshot.rawTokens;
}
