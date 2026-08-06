import type { Usage } from "@earendil-works/pi-ai";
import type { ObserveArm } from "./config.ts";

export interface ObserveFrame {
	schemaVersion: 2;
	frameId: string;
	observationEventId: string;
	parentFrameId?: string;
	content: string;
	createdAt: number;
	activationSourceRef?: string;
	frameTokens: number;
	status: "active" | "superseded";
}

export interface ObserveDetails {
	schemaVersion: 2;
	eventId: string;
	initiatedBy: "agent" | "user-invited";
	runId: string;
	turnIndex: number;
	timestamp: number;
	arm: ObserveArm;
	frame: ObserveFrame;
}

export interface ObserveAttemptDetails {
	schemaVersion: 2;
	eventId: string;
	runId: string;
	turnIndex: number;
	timestamp: number;
	arm: ObserveArm;
	rejected: "arm-disabled" | "duplicate-in-turn";
}

export interface DefaultObserveFrameDetails {
	schemaVersion: 1;
	frame: ObserveFrame;
	sources: Array<{ path: string; contentHash: string }>;
}

export interface SourceReference {
	sourceId: string;
	entryId?: string;
	role: "user" | "assistant" | "toolResult" | "custom";
	timestamp: number;
	contentHash: string;
	rawTokens: number;
}

export interface SemanticRecord {
	schemaVersion: 1;
	recordId: string;
	frameId: string;
	sourceRefs: SourceReference[];
	disposition: "retain" | "trace" | "drop";
	interpretation?: string;
	semanticTokens: number;
	createdAt: number;
	migrationId?: string;
}

export interface SemanticIndexBatch {
	schemaVersion: 1;
	generationId: string;
	frameId: string;
	records: SemanticRecord[];
	generationUsage: Usage;
	createdAt: number;
}

export interface ObserveState {
	arm: ObserveArm;
	currentRunId: string | undefined;
	currentTurnIndex: number;
	observationUsed: boolean;
	userInvitationPending: boolean;
	defaultFrameAttempted: boolean;
	activeFrame: ObserveFrame | undefined;
	frames: ObserveFrame[];
	semanticRecords: SemanticRecord[];
	semanticIndexBatches: SemanticIndexBatch[];
}

export interface SemanticCompactDetails {
	schemaVersion: 1;
	arm: "interaction+compact";
	readFiles: string[];
	modifiedFiles: string[];
	previousObservationEvents: string[];
}
