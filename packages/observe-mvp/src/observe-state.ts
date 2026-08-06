import type { ObserveState } from "./types.ts";

export function resetObserveSessionState(state: ObserveState): void {
	state.currentRunId = undefined;
	state.currentTurnIndex = 0;
	state.observationUsed = false;
	state.observationActionPending = false;
	state.userInvitationPending = false;
	state.defaultFrameAttempted = false;
	state.activeFrame = undefined;
	state.frames = [];
	state.semanticRecords = [];
	state.semanticIndexBatches = [];
	state.projectionNoCompressionStreak = 0;
}
