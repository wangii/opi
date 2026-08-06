import { cp } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { createJudge, describeEval } from "vitest-evals";
import type { Harness, JsonValue } from "vitest-evals/harness";
import observeMvpExtension from "../../observe-mvp/src/index.ts";
import { extractObserveRecords } from "../../observe-mvp/src/session-extractor.ts";
import { createPiCodingAgentHarness, type PiCodingAgentInput } from "./pi-harness.ts";
import { evalHarnessTable } from "./vitest-evals/harness-table.ts";

type ObserveEvalOutput = {
	response: string;
	observations: Array<Record<string, JsonValue>>;
	compactions: number;
};

const tasks: Array<{ id: string; prompt: string; continuation: string; compact: boolean }> = [
	{
		id: "misleading-performance",
		prompt:
			"Treat the issue as a performance regression first, but inspect the repository and identify whether correctness or concurrency better explains the failure. Make one bounded diagnostic change.",
		continuation: "Continue from the evidence. State what should be checked next and perform that check.",
		compact: false,
	},
	{
		id: "local-vs-systemic",
		prompt:
			"Fix the visible symptom in this small project, while checking whether the defect comes from a higher-level interface or lifecycle assumption.",
		continuation: "Re-evaluate the scope of the fix and implement the smallest justified change.",
		compact: false,
	},
	{
		id: "goal-action-drift",
		prompt:
			"The immediate request sounds like an implementation task, but first determine whether the real goal is an architectural decision or an explanation. Inspect the files and proceed with evidence.",
		continuation: "Continue while keeping the user's actual decision needs separate from implementation details.",
		compact: false,
	},
	{
		id: "long-context-continuity",
		prompt:
			"Investigate this repository carefully, recording evidence from several files before proposing a fix. Keep unresolved tensions explicit.",
		continuation:
			"After the context boundary, continue the investigation without silently turning hypotheses into facts.",
		compact: true,
	},
	{
		id: "non-unique-solution",
		prompt:
			"Implement the requested approach, but verify whether another reasonable approach would materially change the next action before editing code.",
		continuation: "Choose and justify the next bounded action based on the evidence gathered.",
		compact: false,
	},
	{
		id: "lifecycle-assumption",
		prompt:
			"Diagnose a failing behavior that may be caused by object lifecycle or ownership rather than the reported input value. Inspect before changing.",
		continuation: "Use the most discriminating check available, then report the result.",
		compact: false,
	},
	{
		id: "abstraction-boundary",
		prompt:
			"Review the requested local patch for an abstraction-boundary mismatch. Make progress on the task while preserving the user's stated constraints.",
		continuation: "Continue from the strongest evidence, not from the initial framing alone.",
		compact: false,
	},
	{
		id: "concurrent-state",
		prompt:
			"Investigate an intermittent failure under concurrency. Do not assume latency is the root cause; inspect shared state and ordering evidence.",
		continuation: "Perform one finite concurrency-focused check and update the implementation only if justified.",
		compact: false,
	},
	{
		id: "requirements-tension",
		prompt:
			"Work on this coding task while separating explicit requirements, inferred preferences, and unresolved tradeoffs. Avoid making an inferred preference a hard constraint.",
		continuation: "Resolve the next tradeoff with evidence and keep alternatives visible.",
		compact: false,
	},
	{
		id: "evidence-reversal",
		prompt:
			"Start with the user's proposed explanation, then inspect enough evidence to notice if the observed behavior points elsewhere. Make one bounded next move.",
		continuation: "Use the new evidence to decide whether to retain, refine, or reject the initial explanation.",
		compact: false,
	},
];

function createObserveHarness(
	name: string,
	arm: "interaction" | "interaction+compact" | "off",
): Harness<PiCodingAgentInput, ObserveEvalOutput> {
	return createPiCodingAgentHarness<ObserveEvalOutput>({
		name,
		tools: ["read", "bash", "edit", "write", "observe"],
		thinkingLevel: "off",
		...(arm === "off"
			? {}
			: {
					extensionFactories: [observeMvpExtension],
					extensionFlagValues: new Map([["observe-arm", arm]]),
				}),
		setupWorkspace: (cwd) =>
			cp(join(process.cwd(), "packages/evals/fixtures/observe/base"), cwd, {
				recursive: true,
			}),
		output: ({ response, session }) => {
			const entries = session.sessionManager.getEntries();
			const observations = extractObserveRecords(entries.map((entry) => JSON.stringify(entry)).join("\n"));
			return {
				response,
				observations: observations.map((observation) => ({ ...observation })),
				compactions: entries.filter((entry) => entry.type === "compaction").length,
			};
		},
	});
}

const judge = createJudge<PiCodingAgentInput, ObserveEvalOutput>("ObserveTaskSmokeJudge", ({ output }) => ({
	score: output.response.trim().length > 0 ? 1 : 0,
	metadata: {
		observationCount: output.observations.length,
		compactions: output.compactions,
	},
}));

const enabled = process.env.PI_OBSERVE_EVAL === "1";
const rows = evalHarnessTable("observe-mvp", {
	baseline: createObserveHarness("baseline", "off"),
	candidates: [
		createObserveHarness("interaction", "interaction"),
		createObserveHarness("interaction-compact", "interaction+compact"),
	],
	repetitions: 2,
});

describe.skipIf(!enabled).for(rows)("$name repetition $repetition", ({ harness }) => {
	describeEval("Observe MVP", { harness, judges: [judge], judgeThreshold: null }, (it) => {
		for (const task of tasks) {
			it(`${task.id} preserves a continuation trace`, async ({ run }) => {
				const steps: PiCodingAgentInput = [
					{ type: "prompt", content: task.prompt },
					...(task.compact ? [{ type: "compact" as const }] : []),
					{ type: "prompt", content: task.continuation },
				];
				const result = await run(steps);
				expect(result.output.response.trim()).not.toBe("");
			});
		}
	});
});
