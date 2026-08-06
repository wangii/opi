import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const OBSERVE_TOOL_NAME = "observe";
export const OBSERVE_ARM_FLAG = "observe-arm";

export const OBSERVE_ARMS = ["off", "interaction", "interaction+compact", "frame-forward", "frame-adaptive"] as const;
export type ObserveArm = (typeof OBSERVE_ARMS)[number];

export function parseObserveArm(value: boolean | string | undefined): ObserveArm {
	if (value === undefined) return "frame-forward";
	if (typeof value !== "string" || !OBSERVE_ARMS.includes(value as ObserveArm)) {
		throw new Error(`--${OBSERVE_ARM_FLAG} must be one of: ${OBSERVE_ARMS.join(", ")}`);
	}
	return value as ObserveArm;
}

export function isFrameMemoryArm(arm: ObserveArm): boolean {
	return arm === "frame-forward" || arm === "frame-adaptive";
}

export function registerObserveArmFlag(pi: ExtensionAPI): void {
	pi.registerFlag(OBSERVE_ARM_FLAG, {
		description: "Observe MVP experiment arm",
		type: "string",
		default: "interaction",
	});
}
