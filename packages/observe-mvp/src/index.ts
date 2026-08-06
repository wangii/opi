import { uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendActiveFrameToSystemPrompt } from "./active-frame-prompt.ts";
import { registerSemanticCompactHook } from "./compact-hook.ts";
import { isFrameMemoryArm, OBSERVE_TOOL_NAME, parseObserveArm, registerObserveArmFlag } from "./config.ts";
import { registerContextProjection } from "./context-projection.ts";
import { DEFAULT_FRAME_CONTEXT_MESSAGE_TYPE, DEFAULT_FRAME_ENTRY_TYPE, deriveDefaultFrame } from "./default-frame.ts";
import { activateObserveFrame, estimateFrameTokens, reconstructObserveFrameState } from "./frame-state.ts";
import { registerObserveCommand } from "./observe-command.ts";
import { registerObserveTool } from "./observe-tool.ts";
import { registerSemanticIndexing } from "./semantic-index.ts";
import type { DefaultObserveFrameDetails, ObserveFrame, ObserveState } from "./types.ts";

function readArm(pi: ExtensionAPI): ObserveState["arm"] {
	return parseObserveArm(pi.getFlag("observe-arm"));
}

function applyArm(pi: ExtensionAPI, arm: ObserveState["arm"]): void {
	const active = pi.getActiveTools().filter((name) => name !== OBSERVE_TOOL_NAME);
	if (arm !== "off") active.push(OBSERVE_TOOL_NAME);
	pi.setActiveTools([...new Set(active)]);
}

function syncArm(pi: ExtensionAPI, state: ObserveState): void {
	state.arm = readArm(pi);
	applyArm(pi, state.arm);
}

export default function observeMvpExtension(pi: ExtensionAPI): void {
	registerObserveArmFlag(pi);
	const state: ObserveState = {
		arm: readArm(pi),
		currentRunId: undefined,
		currentTurnIndex: 0,
		observationUsed: false,
		userInvitationPending: false,
		defaultFrameAttempted: false,
		activeFrame: undefined,
		frames: [],
		semanticRecords: [],
		semanticIndexBatches: [],
	};

	registerObserveTool(pi, state);
	registerObserveCommand(pi, state);

	pi.on("session_start", (_event, ctx) => {
		syncArm(pi, state);
		const frameState = reconstructObserveFrameState(ctx.sessionManager.getBranch());
		state.activeFrame = frameState.activeFrame;
		state.frames = frameState.frames;
		state.defaultFrameAttempted = frameState.activeFrame !== undefined;
	});

	pi.on("before_agent_start", (event, ctx) => {
		syncArm(pi, state);
		if (!isFrameMemoryArm(state.arm)) return { systemPrompt: event.systemPrompt };

		if (!state.activeFrame && !state.defaultFrameAttempted) {
			state.defaultFrameAttempted = true;
			const derived = deriveDefaultFrame(event.systemPromptOptions.contextFiles, ctx.cwd);
			if (derived) {
				const timestamp = Date.now();
				const frame: ObserveFrame = {
					schemaVersion: 2,
					frameId: uuidv7(),
					observationEventId: `default:${uuidv7()}`,
					content: derived.content,
					createdAt: timestamp,
					activationSourceRef: derived.activationSourceRef,
					frameTokens: estimateFrameTokens(derived.content),
					status: "active",
				};
				const details: DefaultObserveFrameDetails = {
					schemaVersion: 1,
					frame,
					sources: derived.sources,
				};
				pi.appendEntry<DefaultObserveFrameDetails>(DEFAULT_FRAME_ENTRY_TYPE, details);
				const activated = activateObserveFrame(state, frame);
				state.activeFrame = activated.activeFrame;
				state.frames = activated.frames;
				return {
					message: {
						customType: DEFAULT_FRAME_CONTEXT_MESSAGE_TYPE,
						content: `Initial Observe frame derived from the active AGENTS.md hierarchy:\n${frame.content}`,
						display: false,
						details: { frameId: frame.frameId },
					},
					systemPrompt: appendActiveFrameToSystemPrompt(event.systemPrompt, frame),
				};
			}
		}

		return {
			systemPrompt: state.activeFrame
				? appendActiveFrameToSystemPrompt(event.systemPrompt, state.activeFrame)
				: event.systemPrompt,
		};
	});

	pi.on("agent_start", (_event, ctx) => {
		state.currentRunId = `${ctx.sessionManager.getSessionId()}:${Date.now()}`;
		state.currentTurnIndex = 0;
		state.observationUsed = false;
	});

	pi.on("turn_start", (event) => {
		state.currentTurnIndex = event.turnIndex;
		state.observationUsed = false;
	});

	pi.on("agent_end", () => {
		state.currentRunId = undefined;
		state.currentTurnIndex = 0;
		state.observationUsed = false;
		state.userInvitationPending = false;
	});

	registerSemanticIndexing(pi, state);
	registerContextProjection(pi, state);
	registerSemanticCompactHook(pi, () => state.arm);
}

export * from "./active-frame-prompt.ts";
export * from "./config.ts";
export * from "./default-frame.ts";
export * from "./session-extractor.ts";
export * from "./types.ts";
