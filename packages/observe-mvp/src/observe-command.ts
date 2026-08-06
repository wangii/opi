import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ObserveState } from "./types.ts";

export function registerObserveCommand(pi: ExtensionAPI, state: ObserveState): void {
	pi.registerCommand("obs", {
		description: "Invite the agent to reconsider the current problem framing",
		handler: async (args, ctx) => {
			state.userInvitationPending = true;
			const hint = args.trim();
			const message = [
				"Re-examine how the current problem is being framed.",
				"Only call observe if a materially different reading would change the next one to three actions.",
				hint ? `User's optional focus: ${hint}` : undefined,
			]
				.filter((part): part is string => part !== undefined)
				.join("\n");
			if (ctx.isIdle()) {
				pi.sendUserMessage(message);
			} else {
				pi.sendUserMessage(message, { deliverAs: "followUp" });
			}
		},
	});
}
