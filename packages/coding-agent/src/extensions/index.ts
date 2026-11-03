import type { InlineExtension } from "../core/extensions/types.ts";
import codemodeExtension from "./codemode/index.ts";
import llamaExtension from "./llama/index.ts";
import mcpExtension from "./mcp/index.ts";
import thinkingStepsExtension from "./thinking-steps/index.ts";
import toolDisplayExtension from "./tool-display/index.ts";
import toolOutputContextExtension from "./tool-output-context/index.ts";
import toolSearchExtension from "./tool-search/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "tool-output-context", factory: toolOutputContextExtension, builtin: true },
	{ name: "llama.cpp", factory: llamaExtension, builtin: true },
	{ name: "thinking-steps", factory: thinkingStepsExtension, builtin: true },
	{ name: "tool-display", factory: toolDisplayExtension, builtin: true },
	// Replaceable: an extension that registers `codemode`, `tool_search`, or `/mcp` (such as a third-party
	// MCP extension) takes over instead of running alongside the built-in one.
	{ name: "codemode", factory: codemodeExtension, replaceable: true, builtin: true },
	{ name: "tool-search", factory: toolSearchExtension, replaceable: true, builtin: true },
	{ name: "mcp", factory: mcpExtension, replaceable: true, builtin: true },
];
