import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { buildSemanticCompactPrompt } from "../src/compact-prompt.ts";
import { OBSERVE_ARMS, parseObserveArm } from "../src/config.ts";
import { projectFrameContext } from "../src/context-projection.ts";
import { DEFAULT_FRAME_ENTRY_TYPE, deriveDefaultFrame } from "../src/default-frame.ts";
import { calculateFrameCost, hasFrameCompressionFailed } from "../src/frame-cost.ts";
import { reconstructObserveFrameState } from "../src/frame-state.ts";
import { OBSERVE_PROMPT_GUIDELINES, OBSERVE_TOOL_DESCRIPTION } from "../src/observe-prompt.ts";
import { buildSemanticIndexPrompt, parseSemanticIndexResponse } from "../src/semantic-index-response.ts";
import { reconstructSemanticIndexState, SEMANTIC_INDEX_ENTRY_TYPE } from "../src/semantic-state.ts";
import { extractObserveRecords } from "../src/session-extractor.ts";
import { createSourceReference } from "../src/source-reference.ts";
import type { ObserveFrame, SemanticIndexBatch, SemanticRecord, SourceReference } from "../src/types.ts";

function semanticRecord(id: string, frameId: string, rawTokens: number, semanticTokens: number): SemanticRecord {
	return {
		schemaVersion: 1,
		recordId: `record-${id}`,
		frameId,
		sourceRefs: [
			{
				sourceId: `entry:${id}`,
				entryId: id,
				role: "user",
				timestamp: 300,
				contentHash: `hash-${id}`,
				rawTokens,
			},
		],
		disposition: "retain",
		interpretation: `semantic ${id}`,
		semanticTokens,
		createdAt: 400,
	};
}

function sourceForMessage(id: string, message: AgentMessage): SourceReference {
	const source = createSourceReference({
		type: "message",
		id,
		parentId: null,
		timestamp: new Date(message.timestamp).toISOString(),
		message,
	});
	if (!source) throw new Error(`Message ${id} cannot be referenced`);
	return source;
}

function observeEntry(id: string, frame: ObserveFrame): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date(frame.createdAt).toISOString(),
		message: {
			role: "toolResult",
			toolCallId: `call-${id}`,
			toolName: "observe",
			content: [{ type: "text", text: "Observation recorded." }],
			details: {
				schemaVersion: 2,
				eventId: frame.observationEventId,
				initiatedBy: "agent",
				runId: "run-1",
				turnIndex: 0,
				timestamp: frame.createdAt,
				arm: "interaction",
				frame,
			},
			isError: false,
			timestamp: frame.createdAt,
		},
	};
}

describe("observe configuration", () => {
	it("accepts the experiment arms", () => {
		expect(OBSERVE_ARMS.map((arm) => parseObserveArm(arm))).toEqual([
			"off",
			"interaction",
			"interaction+compact",
			"frame-forward",
			"frame-adaptive",
		]);
	});

	it("defaults to interaction", () => {
		expect(parseObserveArm(undefined)).toBe("interaction");
	});

	it("rejects unknown arms", () => {
		expect(() => parseObserveArm("unknown")).toThrow("--observe-arm");
	});
});

describe("default observe frame", () => {
	it("derives a concise operating frame from the active AGENTS.md hierarchy", () => {
		const derived = deriveDefaultFrame(
			[
				{
					path: "/repo/AGENTS.md",
					content: "# Rules\n\n## Code Quality\nInspect before editing.\n\n## Commands\nRun checks.",
				},
				{
					path: "/repo/packages/pkg/AGENTS.override.md",
					content: "# Local Rules\n\n## Commands\nRun the focused test.\n\n## User Override\nAsk first.",
				},
				{ path: "/repo/packages/pkg/CLAUDE.md", content: "Not part of the AGENTS hierarchy." },
			],
			"/repo/packages/pkg",
		);

		expect(derived?.content).toContain("../../AGENTS.md -> AGENTS.override.md");
		expect(derived?.content).toContain("Code Quality; Commands; User Override");
		expect(derived?.content.match(/Commands/g)).toHaveLength(1);
		expect(derived?.sources).toHaveLength(2);
		expect(derived?.sources.every((source) => source.contentHash.length === 64)).toBe(true);
		expect(derived?.activationSourceRef).toMatch(/^context-files:[a-f0-9]{64}$/);
	});

	it("does not create an AGENTS-derived frame when no AGENTS file is active", () => {
		expect(deriveDefaultFrame([{ path: "/repo/CLAUDE.md", content: "Fallback rules" }], "/repo")).toBeUndefined();
	});
});

describe("observe frame state", () => {
	it("reconstructs an AGENTS-derived default frame from its custom entry", () => {
		const frame: ObserveFrame = {
			schemaVersion: 2,
			frameId: "frame-default",
			observationEventId: "default:event",
			content: "Use the active AGENTS.md as the operating frame.",
			createdAt: 100,
			activationSourceRef: `context-files:${"a".repeat(64)}`,
			frameTokens: 12,
			status: "active",
		};
		const entry: SessionEntry = {
			type: "custom",
			id: "default-entry",
			parentId: null,
			timestamp: new Date(frame.createdAt).toISOString(),
			customType: DEFAULT_FRAME_ENTRY_TYPE,
			data: { schemaVersion: 1, frame, sources: [] },
		};

		expect(reconstructObserveFrameState([entry])).toEqual({ activeFrame: frame, frames: [frame] });
	});

	it("reconstructs the latest frame from the active branch and supersedes its parent", () => {
		const first: ObserveFrame = {
			schemaVersion: 2,
			frameId: "frame-1",
			observationEventId: "event-1",
			content: "Treat the symptom as a lifecycle problem.",
			createdAt: 100,
			frameTokens: 10,
			status: "active",
		};
		const second: ObserveFrame = {
			schemaVersion: 2,
			frameId: "frame-2",
			observationEventId: "event-2",
			parentFrameId: first.frameId,
			content: "The ownership boundary may be the actual fault.",
			createdAt: 200,
			frameTokens: 12,
			status: "active",
		};

		const state = reconstructObserveFrameState([observeEntry("entry-1", first), observeEntry("entry-2", second)]);

		expect(state.activeFrame).toEqual(second);
		expect(state.frames).toEqual([{ ...first, status: "superseded" }, second]);
	});
});

describe("observe prompt contract", () => {
	it("requires frames to be concise and treats compression failure as an observe trigger", () => {
		expect(OBSERVE_TOOL_DESCRIPTION).toContain("cheaper than equivalent raw context");
		expect(OBSERVE_TOOL_DESCRIPTION).toContain("without copying evidence");
		expect(OBSERVE_PROMPT_GUIDELINES).toContain(
			"Use observe when the active frame no longer compresses a meaningful window of task-relevant information.",
		);
		expect(OBSERVE_PROMPT_GUIDELINES.every((guideline) => guideline.includes("observe"))).toBe(true);
	});
});

describe("semantic indexing", () => {
	it("creates stable raw source references for persisted messages", () => {
		const entry: SessionEntry = {
			type: "message",
			id: "user-1",
			parentId: null,
			timestamp: new Date(300).toISOString(),
			message: {
				role: "user",
				content: [{ type: "text", text: "Inspect the lifecycle." }],
				timestamp: 300,
			},
		};

		const first = createSourceReference(entry);
		const second = createSourceReference(entry);

		expect(first).toEqual(second);
		expect(first).toMatchObject({ sourceId: "entry:user-1", entryId: "user-1", role: "user", timestamp: 300 });
		expect(first?.contentHash).toHaveLength(64);
		expect(first?.rawTokens).toBeGreaterThan(0);
	});

	it("accepts exactly one concise interpretation for every requested source", () => {
		const prompt = buildSemanticIndexPrompt("Treat this as ownership drift.", [
			{ sourceId: "entry:1", serialized: "[User]: inspect" },
			{ sourceId: "entry:2", serialized: "[Assistant]: checking owner" },
		]);
		const parsed = parseSemanticIndexResponse(
			'{"records":[{"sourceId":"entry:1","disposition":"retain","interpretation":"Ownership is unverified."},{"sourceId":"entry:2","disposition":"trace","interpretation":"Check lifecycle evidence."}]}',
			["entry:1", "entry:2"],
		);

		expect(prompt).toContain("<active-frame>\nTreat this as ownership drift.\n</active-frame>");
		expect(parsed).toEqual([
			{ sourceId: "entry:1", disposition: "retain", interpretation: "Ownership is unverified." },
			{ sourceId: "entry:2", disposition: "trace", interpretation: "Check lifecycle evidence." },
		]);
		expect(
			parseSemanticIndexResponse('{"records":[{"sourceId":"entry:1","disposition":"drop"}]}', ["entry:1"]),
		).toEqual([{ sourceId: "entry:1", disposition: "drop" }]);
		expect(
			parseSemanticIndexResponse(
				'{"records":[{"sourceId":"entry:1","disposition":"retain","interpretation":"Only one."}]}',
				["entry:1", "entry:2"],
			),
		).toBeUndefined();
	});

	it("reconstructs persisted semantic batches from the active branch", () => {
		const batch: SemanticIndexBatch = {
			schemaVersion: 1,
			generationId: "generation-1",
			frameId: "frame-1",
			records: [
				{
					schemaVersion: 1,
					recordId: "record-1",
					frameId: "frame-1",
					sourceRefs: [
						{
							sourceId: "entry:user-1",
							entryId: "user-1",
							role: "user",
							timestamp: 300,
							contentHash: "hash",
							rawTokens: 10,
						},
					],
					disposition: "retain",
					interpretation: "Check ownership rather than latency.",
					semanticTokens: 8,
					createdAt: 400,
				},
			],
			generationUsage: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 15,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			createdAt: 400,
		};
		const entry: SessionEntry = {
			type: "custom",
			id: "custom-1",
			parentId: null,
			timestamp: new Date(400).toISOString(),
			customType: SEMANTIC_INDEX_ENTRY_TYPE,
			data: batch,
		};

		expect(reconstructSemanticIndexState([entry])).toEqual({
			semanticIndexBatches: [batch],
			semanticRecords: batch.records,
		});
	});
});

describe("context projection", () => {
	const usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};

	it("keeps older raw messages under an AGENTS-derived default frame until they are indexed", () => {
		const frame: ObserveFrame = {
			schemaVersion: 2,
			frameId: "frame-default",
			observationEventId: "default:event",
			content: "Use the active AGENTS.md as the operating frame.",
			createdAt: 200,
			activationSourceRef: `context-files:${"b".repeat(64)}`,
			frameTokens: 12,
			status: "active",
		};
		const message: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "Preserve this task request." }],
			timestamp: 100,
		};

		const messages = [message];
		const projected = projectFrameContext(messages, frame, []);

		expect(projected.messages).toBe(messages);
		expect(projected.messages).toEqual([message]);
		expect(projected.droppedPreFrameMessages).toBe(0);
	});

	it("uses the active frame as an epoch boundary and drops disposable post-frame messages", () => {
		const frame: ObserveFrame = {
			schemaVersion: 2,
			frameId: "frame-active",
			observationEventId: "event-active",
			content: "Treat the failure as an ownership problem.",
			createdAt: 200,
			activationSourceRef: "tool-call:observe-call",
			frameTokens: 10,
			status: "active",
		};
		const preFrame: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: `Old framing ${"x".repeat(800)}` }],
			timestamp: 100,
		};
		const activation: AgentMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "observe-call", name: "observe", arguments: { content: frame.content } }],
			api: "openai-responses",
			provider: "test",
			model: "test",
			usage,
			stopReason: "toolUse",
			timestamp: 150,
		};
		const activationResult: AgentMessage = {
			role: "toolResult",
			toolCallId: "observe-call",
			toolName: "observe",
			content: [{ type: "text", text: "Observation recorded." }],
			isError: false,
			timestamp: 200,
		};
		const disposable: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: `Acknowledged ${"y".repeat(800)}` }],
			timestamp: 300,
		};
		const source = sourceForMessage("disposable", disposable);
		const record: SemanticRecord = {
			schemaVersion: 1,
			recordId: "record-disposable",
			frameId: frame.frameId,
			sourceRefs: [source],
			disposition: "drop",
			semanticTokens: 0,
			createdAt: 400,
		};

		const result = projectFrameContext([preFrame, activation, activationResult, disposable], frame, [record]);

		expect(result.messages).toHaveLength(1);
		expect(result.messages[0]).toMatchObject({ role: "custom", customType: "observe.semantic-memory" });
		expect(JSON.stringify(result.messages)).not.toContain("Old framing");
		expect(JSON.stringify(result.messages)).not.toContain("Acknowledged");
		expect(result.droppedPreFrameMessages).toBe(3);
		expect(result.replacedSourceIds).toEqual([source.sourceId]);
	});

	it("keeps only a light action outcome trace for a completed tool batch", () => {
		const frame: ObserveFrame = {
			schemaVersion: 2,
			frameId: "frame-trace",
			observationEventId: "event-trace",
			content: "Track discriminating lifecycle checks.",
			createdAt: 100,
			frameTokens: 8,
			status: "active",
		};
		const call: AgentMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "read-call", name: "read", arguments: { path: "src/owner.ts" } }],
			api: "openai-responses",
			provider: "test",
			model: "test",
			usage,
			stopReason: "toolUse",
			timestamp: 200,
		};
		const resultMessage: AgentMessage = {
			role: "toolResult",
			toolCallId: "read-call",
			toolName: "read",
			content: [{ type: "text", text: `file contents ${"z".repeat(1200)}` }],
			isError: false,
			timestamp: 201,
		};
		const callSource = sourceForMessage("read-call-entry", call);
		const resultSource = sourceForMessage("read-result-entry", resultMessage);
		const records: SemanticRecord[] = [
			{
				schemaVersion: 1,
				recordId: "record-call",
				frameId: frame.frameId,
				sourceRefs: [callSource],
				disposition: "drop",
				semanticTokens: 0,
				createdAt: 300,
			},
			{
				schemaVersion: 1,
				recordId: "record-result",
				frameId: frame.frameId,
				sourceRefs: [resultSource],
				disposition: "trace",
				interpretation: "read src/owner.ts: succeeded",
				semanticTokens: 8,
				createdAt: 300,
			},
		];

		const projected = projectFrameContext([call, resultMessage], frame, records);
		const serialized = JSON.stringify(projected.messages);

		expect(projected.messages).toHaveLength(1);
		expect(serialized).toContain("read src/owner.ts: succeeded");
		expect(serialized).not.toContain("file contents");
	});
});

describe("frame cost", () => {
	const frame: ObserveFrame = {
		schemaVersion: 2,
		frameId: "frame-cost",
		observationEventId: "event-cost",
		content: "A compact frame.",
		createdAt: 100,
		frameTokens: 5,
		status: "active",
	};

	it("detects compression failure only after a meaningful source window", () => {
		const tooSmall = calculateFrameCost(frame, [
			semanticRecord("1", frame.frameId, 100, 100),
			semanticRecord("2", frame.frameId, 100, 100),
		]);
		const failed = calculateFrameCost(frame, [
			semanticRecord("1", frame.frameId, 100, 100),
			semanticRecord("2", frame.frameId, 100, 100),
			semanticRecord("3", frame.frameId, 100, 100),
		]);

		expect(hasFrameCompressionFailed(tooSmall)).toBe(false);
		expect(hasFrameCompressionFailed(failed)).toBe(true);
		expect(failed.compressionRatio).toBeCloseTo(305 / 300);
	});

	it("keeps a compressing frame active", () => {
		const snapshot = calculateFrameCost(frame, [
			semanticRecord("1", frame.frameId, 200, 20),
			semanticRecord("2", frame.frameId, 200, 20),
			semanticRecord("3", frame.frameId, 200, 20),
		]);

		expect(snapshot).toMatchObject({ rawTokens: 600, semanticTokens: 60, framedTokens: 65, sourceCount: 3 });
		expect(hasFrameCompressionFailed(snapshot)).toBe(false);
	});
});

describe("semantic compaction", () => {
	it("preserves manual compaction instructions in the request", () => {
		const prompt = buildSemanticCompactPrompt("serialized conversation", "previous memory", "Focus on API changes.");

		expect(prompt).toContain("<conversation>\nserialized conversation\n</conversation>");
		expect(prompt).toContain("Previous continuation memory, if any:\nprevious memory");
		expect(prompt).toContain("<custom-instructions>\nFocus on API changes.\n</custom-instructions>");
	});

	it("omits the custom instruction section when no instructions were provided", () => {
		const prompt = buildSemanticCompactPrompt("serialized conversation", undefined, "  ");

		expect(prompt).not.toContain("<custom-instructions>");
	});
});

describe("observe session extractor", () => {
	it("extracts successful observation tool results and ignores malformed entries", () => {
		const jsonl = [
			JSON.stringify({ type: "session", version: 3 }),
			JSON.stringify({
				type: "message",
				id: "entry-1",
				message: {
					role: "toolResult",
					toolName: "observe",
					toolCallId: "call-1",
					content: [{ type: "text", text: "Observation recorded." }],
					details: {
						schemaVersion: 2,
						eventId: "event-1",
						initiatedBy: "agent",
						runId: "run-1",
						turnIndex: 2,
						timestamp: 123,
						arm: "interaction",
						frame: {
							schemaVersion: 2,
							frameId: "frame-1",
							observationEventId: "event-1",
							content: "A lifecycle tension.",
							createdAt: 123,
							frameTokens: 5,
							status: "active",
						},
					},
				},
			}),
			JSON.stringify({
				type: "message",
				id: "entry-2",
				message: { role: "toolResult", toolName: "observe", toolCallId: "call-2", content: [] },
			}),
		].join("\n");

		expect(extractObserveRecords(jsonl)).toEqual([
			{
				type: "observation",
				eventId: "event-1",
				content: "A lifecycle tension.",
				initiatedBy: "agent",
				runId: "run-1",
				turnIndex: 2,
				timestamp: 123,
				arm: "interaction",
				toolCallId: "call-1",
				entryId: "entry-1",
			},
		]);
	});
});
