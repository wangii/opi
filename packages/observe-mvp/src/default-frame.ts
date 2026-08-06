import { createHash } from "node:crypto";
import { basename, relative } from "node:path";
import type { BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import type { DefaultObserveFrameDetails, ObserveFrame } from "./types.ts";

export const DEFAULT_FRAME_ENTRY_TYPE = "observe.default-frame";
export const DEFAULT_FRAME_CONTEXT_MESSAGE_TYPE = "observe.default-frame-context";

const MAX_RULE_AREAS = 10;
const MAX_RULE_AREAS_LENGTH = 320;

function isAgentsFile(path: string): boolean {
	return /^AGENTS(?:\.override)?\.md$/i.test(basename(path));
}

function cleanHeading(heading: string): string {
	return heading
		.replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
		.replace(/[`*_~]/g, "")
		.replace(/\s+#+\s*$/, "")
		.trim();
}

function ruleAreas(content: string): string[] {
	const areas: string[] = [];
	const seen = new Set<string>();
	for (const line of content.split(/\r?\n/)) {
		const match = line.match(/^#{2,3}\s+(.+)$/);
		if (!match) continue;
		const area = cleanHeading(match[1]);
		if (!area || seen.has(area.toLowerCase())) continue;
		seen.add(area.toLowerCase());
		areas.push(area);
	}
	return areas;
}

function displayPath(path: string, cwd: string): string {
	const fromCwd = relative(cwd, path);
	return (fromCwd || basename(path)).replace(/\\/g, "/");
}

function boundedRuleAreas(areas: string[]): string[] {
	const selected: string[] = [];
	const seen = new Set<string>();
	let length = 0;
	for (const area of areas) {
		const normalized = area.toLowerCase();
		if (seen.has(normalized)) continue;
		const nextLength = length + area.length + (selected.length === 0 ? 0 : 2);
		if (selected.length === MAX_RULE_AREAS || nextLength > MAX_RULE_AREAS_LENGTH) break;
		seen.add(normalized);
		selected.push(area);
		length = nextLength;
	}
	return selected;
}

export interface DefaultFrameDerivation {
	content: string;
	sources: DefaultObserveFrameDetails["sources"];
	activationSourceRef: string;
}

export function deriveDefaultFrame(
	contextFiles: BuildSystemPromptOptions["contextFiles"],
	cwd: string,
): DefaultFrameDerivation | undefined {
	const agentsFiles = (contextFiles ?? []).filter((file) => isAgentsFile(file.path));
	if (agentsFiles.length === 0) return undefined;

	const sources = agentsFiles.map((file) => ({
		path: file.path,
		contentHash: createHash("sha256").update(file.content).digest("hex"),
	}));
	const paths = agentsFiles.map((file) => displayPath(file.path, cwd));
	const areas = boundedRuleAreas(agentsFiles.flatMap((file) => ruleAreas(file.content)));
	const scope =
		paths.length === 1
			? `the active AGENTS.md at ${paths[0]}`
			: `the active AGENTS.md hierarchy (${paths.join(" -> ")}), with later and nearer scopes taking precedence`;
	const content = `Use ${scope} as the initial operating frame.${
		areas.length === 0 ? "" : ` Treat the task as constrained by these rule areas: ${areas.join("; ")}.`
	} Keep interpretations provisional where those instructions do not decide the task.`;
	const activationSourceRef = `context-files:${createHash("sha256")
		.update(sources.map((source) => `${source.path}:${source.contentHash}`).join("\n"))
		.digest("hex")}`;
	return { content, sources, activationSourceRef };
}

export function isDefaultObserveFrame(frame: ObserveFrame | undefined): boolean {
	return frame?.activationSourceRef?.startsWith("context-files:") ?? false;
}
