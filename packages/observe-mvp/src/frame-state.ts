import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { DEFAULT_FRAME_ENTRY_TYPE } from "./default-frame.ts";
import type { ObserveFrame } from "./types.ts";

export interface ObserveFrameState {
	activeFrame: ObserveFrame | undefined;
	frames: ObserveFrame[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function estimateFrameTokens(content: string): number {
	return Math.max(1, Math.ceil(new TextEncoder().encode(content).byteLength / 4));
}

export function parseObserveFrame(value: unknown): ObserveFrame | undefined {
	if (!isRecord(value)) return undefined;
	if (
		value.schemaVersion !== 2 ||
		typeof value.frameId !== "string" ||
		typeof value.observationEventId !== "string" ||
		typeof value.content !== "string" ||
		typeof value.createdAt !== "number" ||
		typeof value.frameTokens !== "number" ||
		(value.status !== "active" && value.status !== "superseded") ||
		(value.parentFrameId !== undefined && typeof value.parentFrameId !== "string") ||
		(value.activationSourceRef !== undefined && typeof value.activationSourceRef !== "string")
	) {
		return undefined;
	}
	return {
		schemaVersion: 2,
		frameId: value.frameId,
		observationEventId: value.observationEventId,
		...(value.parentFrameId === undefined ? {} : { parentFrameId: value.parentFrameId }),
		content: value.content,
		createdAt: value.createdAt,
		...(value.activationSourceRef === undefined ? {} : { activationSourceRef: value.activationSourceRef }),
		frameTokens: value.frameTokens,
		status: value.status,
	};
}

export function activateObserveFrame(state: ObserveFrameState, frame: ObserveFrame): ObserveFrameState {
	const activeFrame = { ...frame, status: "active" as const };
	return {
		activeFrame,
		frames: [
			...state.frames
				.filter((candidate) => candidate.frameId !== frame.frameId)
				.map((candidate) =>
					candidate.status === "active" ? { ...candidate, status: "superseded" as const } : candidate,
				),
			activeFrame,
		],
	};
}

export function reconstructObserveFrameState(entries: SessionEntry[]): ObserveFrameState {
	let state: ObserveFrameState = { activeFrame: undefined, frames: [] };
	for (const entry of entries) {
		let frame: ObserveFrame | undefined;
		if (entry.type === "custom" && entry.customType === DEFAULT_FRAME_ENTRY_TYPE) {
			const details = entry.data;
			// schemaVersion 1 (AGENTS-derived) and 2 (task-state) both carry `frame`.
			if (isRecord(details) && (details.schemaVersion === 1 || details.schemaVersion === 2)) {
				frame = parseObserveFrame(details.frame);
			}
		} else if (
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolName === "observe"
		) {
			const details = entry.message.details;
			if (isRecord(details) && details.schemaVersion === 2) frame = parseObserveFrame(details.frame);
		}
		if (frame) state = activateObserveFrame(state, frame);
	}
	return state;
}
