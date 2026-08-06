import type { SimpleStreamOptions } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { completeModel, type ModelCompletionRegistry } from "../src/model-completion-adapter.ts";

const context = {
	messages: [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: "Index this message." }],
			timestamp: 1,
		},
	],
};

describe("model completion adapter", () => {
	it("uses ModelRegistry.complete when the runtime provides it", async () => {
		const faux = fauxProvider();
		const expected = fauxAssistantMessage("native completion");
		const complete = vi.fn(async () => expected);
		const registry: ModelCompletionRegistry = {
			complete,
			getApiKeyAndHeaders: vi.fn(async () => {
				throw new Error("legacy auth path should not run");
			}),
			getProvider: vi.fn(() => undefined),
		};

		const result = await completeModel(registry, faux.getModel(), context, { maxTokens: 123 });

		expect(result).toBe(expected);
		expect(complete).toHaveBeenCalledWith(faux.getModel(), context, { maxTokens: 123 });
	});

	it("falls back to provider streaming with registry-resolved auth", async () => {
		const faux = fauxProvider();
		let requestOptions: SimpleStreamOptions | undefined;
		let requestBaseUrl: string | undefined;
		faux.setResponses([
			(_context, options, _state, model) => {
				requestOptions = options;
				requestBaseUrl = model.baseUrl;
				return fauxAssistantMessage("adapted completion");
			},
		]);
		const registry: ModelCompletionRegistry = {
			getApiKeyAndHeaders: vi.fn(async () => ({
				ok: true as const,
				apiKey: "resolved-key",
				headers: { "X-Auth": "resolved", "X-Override": "old" },
				baseUrl: "https://resolved.example.test",
				env: { RESOLVED: "yes", OVERRIDE: "old" },
			})),
			getProvider: vi.fn(() => faux.provider),
		};

		const result = await completeModel(registry, faux.getModel(), context, {
			maxTokens: 321,
			headers: { "x-override": "new" },
			env: { OVERRIDE: "new" },
			transformHeaders: (headers) => ({ ...headers, "X-Transformed": "yes" }),
		});

		expect(result.content).toEqual([{ type: "text", text: "adapted completion" }]);
		expect(requestBaseUrl).toBe("https://resolved.example.test");
		expect(requestOptions).toMatchObject({
			apiKey: "resolved-key",
			maxTokens: 321,
			headers: { "X-Auth": "resolved", "x-override": "new", "X-Transformed": "yes" },
			env: { RESOLVED: "yes", OVERRIDE: "new" },
		});
	});

	it("reports registry auth failures before dispatch", async () => {
		const faux = fauxProvider();
		const registry: ModelCompletionRegistry = {
			getApiKeyAndHeaders: vi.fn(async () => ({ ok: false, error: "missing auth" })),
			getProvider: vi.fn(() => faux.provider),
		};

		await expect(completeModel(registry, faux.getModel(), context)).rejects.toThrow("missing auth");
		expect(faux.state.callCount).toBe(0);
	});
});
