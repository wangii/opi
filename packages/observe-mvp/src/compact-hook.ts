import type { Usage } from "@earendil-works/pi-ai";
import { contentText, uuidv7 } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeCompactEvent,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { buildSemanticCompactPrompt } from "./compact-prompt.ts";
import type { ObserveArm } from "./config.ts";
import { completeModel } from "./model-completion-adapter.ts";
import type { SemanticCompactDetails } from "./types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function previousObservationEvents(entries: SessionEntry[]): string[] {
	const eventIds: string[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "observe") {
			continue;
		}
		const details = entry.message.details;
		if (isRecord(details) && details.schemaVersion === 2 && typeof details.eventId === "string") {
			eventIds.push(details.eventId);
		}
	}
	return eventIds;
}

function continuationDetails(
	preparation: SessionBeforeCompactEvent["preparation"],
	entries: SessionEntry[],
): SemanticCompactDetails {
	const read = new Set(preparation.fileOps.read);
	const modified = new Set([...preparation.fileOps.edited, ...preparation.fileOps.written]);
	for (const entry of entries) {
		if (entry.type !== "compaction" || !isRecord(entry.details) || entry.details.schemaVersion !== 1) continue;
		if (Array.isArray(entry.details.readFiles)) {
			for (const file of entry.details.readFiles) if (typeof file === "string") read.add(file);
		}
		if (Array.isArray(entry.details.modifiedFiles)) {
			for (const file of entry.details.modifiedFiles) if (typeof file === "string") modified.add(file);
		}
	}
	const fileLists = {
		readFiles: [...read].filter((file) => !modified.has(file)).sort(),
		modifiedFiles: [...modified].sort(),
	};
	return {
		schemaVersion: 1,
		arm: "interaction+compact",
		...fileLists,
		previousObservationEvents: previousObservationEvents(entries),
	};
}

function serializedMessages(preparation: SessionBeforeCompactEvent["preparation"]): string {
	const messages = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
	return JSON.stringify(convertToLlm(messages), null, 2);
}

async function generateContinuationMemory(
	ctx: ExtensionContext,
	preparation: SessionBeforeCompactEvent["preparation"],
	customInstructions: string | undefined,
	signal: AbortSignal,
): Promise<{ summary: string; usage: Usage } | undefined> {
	const model = ctx.model;
	if (!model) return undefined;

	const response = await completeModel(
		ctx.modelRegistry,
		model,
		{
			systemPrompt: "You write concise, faithful continuation memory for an ongoing coding task.",
			messages: [
				{
					role: "user",
					content: [
						{
							type: "text",
							text: buildSemanticCompactPrompt(
								serializedMessages(preparation),
								preparation.previousSummary,
								customInstructions,
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
			signal,
			maxTokens: Math.min(8192, Math.max(1024, Math.floor(preparation.settings.reserveTokens * 0.8))),
			reasoning: ctx.thinkingLevel,
		},
	);

	if (response.stopReason === "error") return undefined;
	const summary = contentText(response.content).trim();
	if (!summary) return undefined;
	return { summary, usage: response.usage };
}

export function registerSemanticCompactHook(pi: ExtensionAPI, getArm: () => ObserveArm): void {
	pi.on("session_before_compact", async (event, ctx) => {
		if (getArm() !== "interaction+compact") return undefined;
		let generated: Awaited<ReturnType<typeof generateContinuationMemory>>;
		try {
			generated = await generateContinuationMemory(ctx, event.preparation, event.customInstructions, event.signal);
		} catch (error) {
			if (ctx.hasUI) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Semantic compaction failed; using native compaction: ${message}`, "warning");
			}
			return undefined;
		}
		if (!generated) return undefined;
		return {
			compaction: {
				summary: generated.summary,
				firstKeptEntryId: event.preparation.firstKeptEntryId,
				tokensBefore: event.preparation.tokensBefore,
				usage: generated.usage,
				details: continuationDetails(event.preparation, event.branchEntries),
			},
		};
	});
}
