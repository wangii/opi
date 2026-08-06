import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isFrameMemoryArm } from "./config.ts";
import { isDefaultObserveFrame } from "./default-frame.ts";
import { estimateFrameTokens } from "./frame-state.ts";
import { estimateRawMessageTokens, messageReferenceKey, sourceReferenceKey } from "./source-reference.ts";
import type { ObserveFrame, ObserveState, SemanticRecord, SourceReference } from "./types.ts";

interface ContextUnit {
	messages: AgentMessage[];
	toolBatchComplete: boolean;
}

interface CoveredMessage {
	record: SemanticRecord;
	source: SourceReference;
}

interface ProjectionUnit extends ContextUnit {
	covered: CoveredMessage[];
	rawTokens: number;
	preFrame: boolean;
}

export interface ContextProjectionResult {
	messages: AgentMessage[];
	projectedTokens: number;
	rawTokens: number;
	replacedSourceIds: string[];
	droppedPreFrameMessages: number;
}

function contextUnits(messages: AgentMessage[]): ContextUnit[] {
	const units: ContextUnit[] = [];
	for (let index = 0; index < messages.length; index += 1) {
		const message = messages[index];
		if (message.role !== "assistant") {
			units.push({ messages: [message], toolBatchComplete: message.role !== "toolResult" });
			continue;
		}
		const toolCallIds = message.content
			.filter(
				(part): part is Extract<(typeof message.content)[number], { type: "toolCall" }> => part.type === "toolCall",
			)
			.map((part) => part.id);
		if (toolCallIds.length === 0) {
			units.push({ messages: [message], toolBatchComplete: true });
			continue;
		}
		const remaining = new Set(toolCallIds);
		const batch: AgentMessage[] = [message];
		let cursor = index + 1;
		while (cursor < messages.length) {
			const result = messages[cursor];
			if (result.role !== "toolResult" || !remaining.has(result.toolCallId)) break;
			remaining.delete(result.toolCallId);
			batch.push(result);
			cursor += 1;
		}
		units.push({
			messages: batch,
			toolBatchComplete:
				remaining.size === 0 &&
				!batch.some((candidate) => candidate.role === "toolResult" && (candidate.addedToolNames?.length ?? 0) > 0),
		});
		index = cursor - 1;
	}
	return units;
}

function isActiveFrameUnit(unit: ContextUnit, activeFrame: ObserveFrame): boolean {
	const activationToolCallId = activeFrame.activationSourceRef?.startsWith("tool-call:")
		? activeFrame.activationSourceRef.slice("tool-call:".length)
		: undefined;
	return (
		activationToolCallId !== undefined &&
		unit.messages.some(
			(message) =>
				message.role === "assistant" &&
				message.content.some(
					(part) => part.type === "toolCall" && part.name === "observe" && part.id === activationToolCallId,
				),
		)
	);
}

function semanticMemoryText(activeFrame: ObserveFrame, covered: CoveredMessage[]): string {
	const records = new Map<string, SemanticRecord>();
	for (const item of covered) records.set(item.record.recordId, item.record);
	const recordLines = [...records.values()]
		.filter((record) => record.disposition !== "drop" && record.interpretation !== undefined)
		.map(
			(record) =>
				`- ${record.disposition} [${record.sourceRefs.map((source) => source.sourceId).join(", ")}]: ${record.interpretation}`,
		);
	return `Active Observe frame:\n- ${activeFrame.frameId}: ${activeFrame.content}\n\nPost-frame records:\n${
		recordLines.length === 0 ? "(none; covered messages were dropped)" : recordLines.join("\n")
	}`;
}

function projectRun(
	activeFrame: ObserveFrame,
	units: ProjectionUnit[],
):
	| {
			message: AgentMessage;
			projectedTokens: number;
			rawTokens: number;
			sourceIds: string[];
			droppedPreFrameMessages: number;
	  }
	| undefined {
	const covered = units.flatMap((unit) => unit.covered);
	const sources = new Map<string, SourceReference>();
	for (const item of covered) sources.set(item.source.sourceId, item.source);
	const rawTokens = units.reduce((total, unit) => total + unit.rawTokens, 0);
	const text = semanticMemoryText(activeFrame, covered);
	const projectedTokens = estimateFrameTokens(text);
	if (projectedTokens >= rawTokens) return undefined;
	return {
		message: {
			role: "custom",
			customType: "observe.semantic-memory",
			content: text,
			display: false,
			details: { frameId: activeFrame.frameId, sourceIds: [...sources.keys()] },
			timestamp: units[0].messages[0].timestamp,
		},
		projectedTokens,
		rawTokens,
		sourceIds: [...sources.keys()],
		droppedPreFrameMessages: units
			.filter((unit) => unit.preFrame)
			.reduce((total, unit) => total + unit.messages.length, 0),
	};
}

export function projectFrameContext(
	messages: AgentMessage[],
	activeFrame: ObserveFrame,
	records: SemanticRecord[],
): ContextProjectionResult {
	const recordBySourceKey = new Map<string, CoveredMessage>();
	for (const record of records) {
		if (record.frameId !== activeFrame.frameId) continue;
		for (const source of record.sourceRefs) recordBySourceKey.set(sourceReferenceKey(source), { record, source });
	}

	const projected: AgentMessage[] = [];
	let pending: ProjectionUnit[] = [];
	let projectedTokens = 0;
	let rawTokens = 0;
	let droppedPreFrameMessages = 0;
	const replacedSourceIds: string[] = [];
	const flush = () => {
		if (pending.length === 0) return;
		const replacement = projectRun(activeFrame, pending);
		if (replacement) {
			projected.push(replacement.message);
			projectedTokens += replacement.projectedTokens;
			rawTokens += replacement.rawTokens;
			droppedPreFrameMessages += replacement.droppedPreFrameMessages;
			replacedSourceIds.push(...replacement.sourceIds);
		} else {
			projected.push(...pending.flatMap((unit) => unit.messages));
		}
		pending = [];
	};

	for (const unit of contextUnits(messages)) {
		const covered = unit.messages.map((message) => {
			const key = messageReferenceKey(message);
			return key === undefined ? undefined : recordBySourceKey.get(key);
		});
		const activeFrameUnit = isActiveFrameUnit(unit, activeFrame);
		const preFrame =
			!isDefaultObserveFrame(activeFrame) &&
			(activeFrameUnit || unit.messages.every((message) => message.timestamp < activeFrame.createdAt));
		if (unit.toolBatchComplete && (preFrame || covered.every((item): item is CoveredMessage => item !== undefined))) {
			pending.push({
				...unit,
				covered: preFrame ? [] : covered.filter((item): item is CoveredMessage => item !== undefined),
				rawTokens: unit.messages.reduce((total, message) => total + estimateRawMessageTokens(message), 0),
				preFrame,
			});
			continue;
		}
		flush();
		projected.push(...unit.messages);
	}
	flush();
	return {
		messages: replacedSourceIds.length === 0 && droppedPreFrameMessages === 0 ? messages : projected,
		projectedTokens,
		rawTokens,
		replacedSourceIds,
		droppedPreFrameMessages,
	};
}

export function registerContextProjection(pi: ExtensionAPI, state: ObserveState): void {
	pi.on("context", (event) => {
		if (!isFrameMemoryArm(state.arm) || !state.activeFrame) return undefined;
		const projection = projectFrameContext(event.messages, state.activeFrame, state.semanticRecords);
		if (projection.messages === event.messages) return undefined;
		return { messages: projection.messages };
	});
}
