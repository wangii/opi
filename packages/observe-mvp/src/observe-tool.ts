import { Type, uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { OBSERVE_TOOL_NAME } from "./config.ts";
import { activateObserveFrame, estimateFrameTokens } from "./frame-state.ts";
import { OBSERVE_PROMPT_GUIDELINES, OBSERVE_PROMPT_SNIPPET, OBSERVE_TOOL_DESCRIPTION } from "./observe-prompt.ts";
import type { ObserveAttemptDetails, ObserveDetails, ObserveFrame, ObserveState } from "./types.ts";

function resultText(rejected?: ObserveAttemptDetails["rejected"]): string {
	if (rejected === "arm-disabled") return "Observation is disabled for the current experiment arm.";
	if (rejected === "duplicate-in-turn") return "Observation already recorded for this agent turn. Continue the task.";
	return "Observation recorded. Treat it as provisional and user-revisable. Continue the task with one bounded action influenced by it.";
}

export function registerObserveTool(pi: ExtensionAPI, state: ObserveState): void {
	pi.registerTool({
		name: OBSERVE_TOOL_NAME,
		label: "Observe",
		description: OBSERVE_TOOL_DESCRIPTION,
		promptSnippet: OBSERVE_PROMPT_SNIPPET,
		promptGuidelines: [...OBSERVE_PROMPT_GUIDELINES],
		parameters: Type.Object({
			content: Type.String({ minLength: 1, description: "Free-form provisional observation" }),
		}),
		executionMode: "sequential",
		renderShell: "self",
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			const timestamp = Date.now();
			const eventId = uuidv7();
			const runId = state.currentRunId ?? ctx.sessionManager.getSessionId();
			const baseDetails = {
				schemaVersion: 2 as const,
				eventId,
				runId,
				turnIndex: state.currentTurnIndex,
				timestamp,
				arm: state.arm,
			};

			if (state.arm === "off") {
				const details: ObserveAttemptDetails = { ...baseDetails, rejected: "arm-disabled" };
				return { content: [{ type: "text" as const, text: resultText(details.rejected) }], details, isError: true };
			}
			if (state.observationUsed) {
				const details: ObserveAttemptDetails = { ...baseDetails, rejected: "duplicate-in-turn" };
				return { content: [{ type: "text" as const, text: resultText(details.rejected) }], details, isError: true };
			}

			const content = params.content.trim();
			if (!content) throw new Error("Observation content must not be empty.");

			state.observationUsed = true;
			const frame: ObserveFrame = {
				schemaVersion: 2,
				frameId: uuidv7(),
				observationEventId: eventId,
				...(state.activeFrame ? { parentFrameId: state.activeFrame.frameId } : {}),
				content,
				createdAt: timestamp,
				activationSourceRef: `tool-call:${toolCallId}`,
				frameTokens: estimateFrameTokens(content),
				status: "active",
			};
			const details: ObserveDetails = {
				...baseDetails,
				initiatedBy: state.userInvitationPending ? "user-invited" : "agent",
				frame,
			};
			const activated = activateObserveFrame(state, frame);
			state.activeFrame = activated.activeFrame;
			state.frames = activated.frames;
			state.userInvitationPending = false;
			return {
				content: [{ type: "text" as const, text: resultText() }],
				details,
			};
		},
		renderCall(args, theme) {
			const box = new Box(1, 0, (text) => theme.bg("customMessageBg", text));
			box.addChild(new Text(theme.fg("accent", "【观】"), 0, 0));
			box.addChild(new Text(args.content.trim(), 0, 0));
			return box;
		},
		renderResult(result, _options, theme) {
			const text = result.content
				.filter((part): part is { type: "text"; text: string } => part.type === "text")
				.map((part) => part.text)
				.join("\n");
			const rejected = typeof result.details === "object" && result.details !== null && "rejected" in result.details;
			return new Text(theme.fg(rejected ? "error" : "dim", text), 0, 0);
		},
	});
}
