import type {
	Api,
	ApiStreamOptions,
	AssistantMessage,
	Context,
	Model,
	ModelsApiStreamOptions,
	Provider,
	ProviderHeaders,
} from "@earendil-works/pi-ai";

interface ResolvedRequestAuth {
	ok: true;
	apiKey?: string;
	headers?: ProviderHeaders;
	baseUrl?: string;
	env?: Record<string, string>;
}

interface RequestAuthError {
	ok: false;
	error: string;
}

type CompleteModel = <TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: ModelsApiStreamOptions<TApi>,
) => Promise<AssistantMessage>;

export interface ModelCompletionRegistry {
	complete?: CompleteModel;
	getApiKeyAndHeaders(model: Model<Api>): Promise<ResolvedRequestAuth | RequestAuthError>;
	getProvider(provider: string): Provider | undefined;
}

function mergeHeaders(
	base: ProviderHeaders | undefined,
	override: ProviderHeaders | undefined,
): ProviderHeaders | undefined {
	if (!base && !override) return undefined;
	const merged = { ...base };
	for (const [name, value] of Object.entries(override ?? {})) {
		const lowerName = name.toLowerCase();
		for (const existingName of Object.keys(merged)) {
			if (existingName.toLowerCase() === lowerName) delete merged[existingName];
		}
		merged[name] = value;
	}
	return merged;
}

/** Temporary bridge for pi runtimes whose extension ModelRegistry does not expose complete(). */
export async function completeModel<TApi extends Api>(
	registry: ModelCompletionRegistry,
	model: Model<TApi>,
	context: Context,
	options?: ModelsApiStreamOptions<TApi>,
): Promise<AssistantMessage> {
	if (registry.complete) return registry.complete(model, context, options);

	const provider = registry.getProvider(model.provider);
	if (!provider) throw new Error(`Unknown provider: ${model.provider}`);
	const auth = await registry.getApiKeyAndHeaders(model);
	if (!auth.ok) throw new Error(auth.error);

	const providerOptions = { ...options };
	const { transformHeaders } = providerOptions;
	delete providerOptions.transformHeaders;
	let headers = mergeHeaders(auth.headers, providerOptions.headers);
	if (transformHeaders) headers = await transformHeaders(headers ?? {});
	const env = auth.env || providerOptions.env ? { ...(auth.env ?? {}), ...(providerOptions.env ?? {}) } : undefined;
	const requestModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
	return provider
		.stream(requestModel, context, {
			...providerOptions,
			apiKey: providerOptions.apiKey ?? auth.apiKey,
			headers,
			env,
		} as ApiStreamOptions<TApi>)
		.result();
}
