import js from "@eslint/js";
import importPlugin from "eslint-plugin-import";
import prettierConfig from "eslint-config-prettier";

export default [
	// Ignore heavy/generated folders and logs
	{ ignores: ["logs/**", "tracking/**", "analysis-output/**", "backtest-output/**", "**/*.log", "**/*.jsonl"] },
	js.configs.recommended,
	{
		languageOptions: {
			ecmaVersion: 2022,
			sourceType: "module",
			globals: {
				console: "readonly",
				process: "readonly",
				Buffer: "readonly",
				__dirname: "readonly",
				__filename: "readonly",
				global: "readonly",
				module: "readonly",
				require: "readonly",
				exports: "readonly",
				setTimeout: "readonly",
				clearTimeout: "readonly",
				setInterval: "readonly",
				clearInterval: "readonly",
				setImmediate: "readonly",
				clearImmediate: "readonly",
				URL: "readonly",
				fetch: "readonly",
			},
		},
		plugins: {
			import: importPlugin,
		},
		rules: {
			"no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none", caughtErrorsIgnorePattern: "^_" }],
			"import/no-unresolved": "off",
		},
	},
	prettierConfig,
];
