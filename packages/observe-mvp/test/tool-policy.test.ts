import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createSourceReference } from "../src/source-reference.ts";
import {
	classifySourceKind,
	classifyToolKind,
	isMicroSource,
	readInterpretationBudget,
	type ToolPolicyInput,
	truncateSerializedForIndexing,
	validateToolPolicy,
} from "../src/tool-policy.ts";

describe("tool-kind classification", () => {
	it("classifies read, edit/write, and observe tools", () => {
		expect(classifyToolKind("read")).toBe("read");
		expect(classifyToolKind("edit")).toBe("edit");
		expect(classifyToolKind("write")).toBe("edit");
		expect(classifyToolKind("observe")).toBe("observe");
		expect(classifyToolKind(undefined)).toBe("other");
		expect(classifyToolKind("grepl")).toBe("other");
	});

	it("splits bash into exploration and side-effecting commands", () => {
		expect(classifyToolKind("bash", "ls -la src")).toBe("bash-explore");
		expect(classifyToolKind("bash", "find . -name '*.ts'")).toBe("bash-explore");
		expect(classifyToolKind("bash", "rg -n 'observe' src")).toBe("bash-explore");
		expect(classifyToolKind("bash", "cat package.json")).toBe("bash-explore");
		expect(classifyToolKind("bash", "npm run check")).toBe("bash-effect");
		expect(classifyToolKind("bash", "git commit -m 'fix'")).toBe("bash-effect");
		expect(classifyToolKind("bash", "mv src/a.ts src/b.ts")).toBe("bash-effect");
		expect(classifyToolKind("bash", "npm test")).toBe("bash-effect");
		// Unknown commands default to side-effecting (conservative).
		expect(classifyToolKind("bash", "unknown-tool --flag")).toBe("bash-effect");
		expect(classifyToolKind("bash", undefined)).toBe("bash-effect");
	});
});

describe("source reference tool metadata", () => {
	function bashResultEntry(id: string, toolCallId: string): SessionEntry {
		return {
			type: "message",
			id,
			parentId: null,
			timestamp: new Date(200).toISOString(),
			message: {
				role: "toolResult",
				toolCallId,
				toolName: "bash",
				content: [{ type: "text", text: "checked" }],
				isError: false,
				timestamp: 200,
			},
		};
	}

	it("captures the tool name and paired bash command", () => {
		const toolCalls = new Map([["call-1", { toolName: "bash", command: "npm run check" }]]);
		const source = createSourceReference(bashResultEntry("bash-1", "call-1"), toolCalls);

		expect(source).toMatchObject({ role: "toolResult", toolName: "bash", command: "npm run check" });
		expect(classifySourceKind(source!)).toBe("bash-effect");
	});

	it("omits the command when no paired tool call is known", () => {
		const source = createSourceReference(bashResultEntry("bash-2", "call-missing"));

		expect(source).toMatchObject({ role: "toolResult", toolName: "bash" });
		expect(source?.command).toBeUndefined();
		// Without a command, bash is conservatively treated as side-effecting.
		expect(classifySourceKind(source!)).toBe("bash-effect");
	});

	it("keeps user sources free of tool metadata", () => {
		const source = createSourceReference({
			type: "message",
			id: "user-1",
			parentId: null,
			timestamp: new Date(100).toISOString(),
			message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 100 },
		});

		expect(source).toMatchObject({ role: "user" });
		expect(source?.toolName).toBeUndefined();
		expect(source?.command).toBeUndefined();
	});
});

describe("deterministic tool-aware validation", () => {
	function input(overrides: Partial<ToolPolicyInput>): ToolPolicyInput {
		return {
			role: "assistant",
			kind: "other",
			hasToolCall: false,
			rawTokens: 100,
			disposition: "trace",
			interpretation: "attempted",
			...overrides,
		};
	}

	it("accepts a compliant mixed batch", () => {
		expect(
			validateToolPolicy([
				input({ role: "user", disposition: "retain", interpretation: "task" }),
				input({ kind: "edit", role: "toolResult", disposition: "retain", interpretation: "edited src/a.ts" }),
				input({ kind: "read", role: "toolResult", disposition: "drop" }),
				input({ kind: "bash-explore", role: "toolResult", disposition: "drop" }),
				input({ kind: "bash-effect", role: "toolResult", disposition: "trace", interpretation: "check failed" }),
				input({ hasToolCall: true, disposition: "retain", interpretation: "read src/a.ts" }),
			]),
		).toBeUndefined();
	});

	it("rejects a dropped user message", () => {
		expect(validateToolPolicy([input({ role: "user", disposition: "drop" })])).toContain("user message");
	});

	it("rejects a dropped assistant tool call", () => {
		expect(validateToolPolicy([input({ hasToolCall: true, disposition: "drop" })])).toContain("assistant tool call");
	});

	it("rejects edit/write sources that are not retained", () => {
		expect(validateToolPolicy([input({ kind: "edit", role: "toolResult", disposition: "trace" })])).toContain(
			"edit/write",
		);
		expect(validateToolPolicy([input({ kind: "edit", role: "toolResult", disposition: "drop" })])).toContain(
			"edit/write",
		);
	});

	it("rejects drops of side-effecting and unknown tool results", () => {
		expect(validateToolPolicy([input({ kind: "bash-effect", role: "toolResult", disposition: "drop" })])).toContain(
			"must not be dropped",
		);
		expect(validateToolPolicy([input({ kind: "other", role: "toolResult", disposition: "drop" })])).toContain(
			"must not be dropped",
		);
	});

	it("allows drops of read and bash-exploration results", () => {
		expect(
			validateToolPolicy([
				input({ kind: "read", role: "toolResult", disposition: "drop" }),
				input({ kind: "bash-explore", role: "toolResult", disposition: "drop" }),
			]),
		).toBeUndefined();
	});

	it("rejects read interpretations that exceed the token budget", () => {
		const violation = validateToolPolicy([
			input({
				kind: "read",
				role: "toolResult",
				rawTokens: 500,
				disposition: "retain",
				interpretation: "x".repeat(400),
			}),
		]);
		expect(violation).toContain("exceeds the budget");
	});

	it("accepts read interpretations within the budget", () => {
		const budget = readInterpretationBudget(500);
		expect(
			validateToolPolicy([
				input({
					kind: "read",
					role: "toolResult",
					rawTokens: 500,
					disposition: "trace",
					interpretation: "key fact ".repeat(Math.floor(budget / 8)),
				}),
			]),
		).toBeUndefined();
	});

	it("budgets reads proportionally with a floor and a cap", () => {
		expect(readInterpretationBudget(10)).toBe(16);
		expect(readInterpretationBudget(200)).toBe(20);
		expect(readInterpretationBudget(2000)).toBe(96);
	});
});

describe("indexing cost control", () => {
	it("truncates long serialized sources to head and tail", () => {
		const text = `head-${"a".repeat(2000)}-middle-${"b".repeat(2000)}-tail`;
		const truncated = truncateSerializedForIndexing(text, 100, 20);

		expect(truncated).toContain("head-");
		expect(truncated).toContain("-tail");
		expect(truncated).not.toContain("-middle-");
		expect(truncated).toContain("<...truncated for indexing...>");
	});

	it("leaves short sources untouched", () => {
		const text = "short source";
		expect(truncateSerializedForIndexing(text, 100, 20)).toBe(text);
		expect(truncateSerializedForIndexing(text, Number.POSITIVE_INFINITY, 0)).toBe(text);
	});

	it("skips micro read and exploration results from indexing", () => {
		expect(isMicroSource("read", 10)).toBe(true);
		expect(isMicroSource("bash-explore", 31)).toBe(true);
		expect(isMicroSource("read", 32)).toBe(false);
		expect(isMicroSource("bash-effect", 10)).toBe(false);
		expect(isMicroSource("edit", 10)).toBe(false);
	});
});
