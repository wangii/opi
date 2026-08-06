import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "../../vitest.base.ts";

export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			environment: "node",
			include: ["test/**/*.test.ts"],
		},
		resolve: {
			alias: [
				{
					find: /^@earendil-works\/pi-coding-agent$/,
					replacement: fileURLToPath(new URL("../coding-agent/src/index.ts", import.meta.url)),
				},
			],
		},
	}),
);
