import { readFile } from "node:fs/promises";

export interface ObserveSessionRecord {
	type: "observation";
	eventId: string;
	content: string;
	initiatedBy: "agent" | "user-invited";
	runId: string;
	turnIndex: number;
	timestamp: number;
	arm: string;
	toolCallId: string;
	entryId: string;
}

interface SessionEntryLike {
	type?: unknown;
	id?: unknown;
	message?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function extractObserveRecords(jsonl: string): ObserveSessionRecord[] {
	const records: ObserveSessionRecord[] = [];
	for (const line of jsonl.split(/\r?\n/)) {
		if (!line.trim()) continue;
		const entry = JSON.parse(line) as SessionEntryLike;
		if (entry.type !== "message" || !isRecord(entry.message)) continue;
		if (entry.message.role !== "toolResult") continue;
		if (entry.message.toolName !== "observe" || !isRecord(entry.message.details)) continue;
		const details = entry.message.details;
		const frame = details.frame;
		if (
			details.schemaVersion !== 2 ||
			typeof details.eventId !== "string" ||
			(details.initiatedBy !== "agent" && details.initiatedBy !== "user-invited") ||
			typeof details.runId !== "string" ||
			typeof details.turnIndex !== "number" ||
			typeof details.timestamp !== "number" ||
			typeof details.arm !== "string" ||
			!isRecord(frame) ||
			frame.schemaVersion !== 2 ||
			typeof frame.frameId !== "string" ||
			frame.observationEventId !== details.eventId ||
			typeof frame.content !== "string" ||
			typeof entry.id !== "string" ||
			typeof entry.message.toolCallId !== "string"
		) {
			continue;
		}
		records.push({
			type: "observation",
			eventId: details.eventId,
			content: frame.content,
			initiatedBy: details.initiatedBy,
			runId: details.runId,
			turnIndex: details.turnIndex,
			timestamp: details.timestamp,
			arm: details.arm,
			toolCallId: entry.message.toolCallId,
			entryId: entry.id,
		});
	}
	return records;
}

export async function extractObserveRecordsFromFile(path: string): Promise<ObserveSessionRecord[]> {
	return extractObserveRecords(await readFile(path, "utf8"));
}
