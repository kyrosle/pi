/**
 * Presentation for the shell tools.
 *
 * Renderers live apart from the implementation so a process that only displays tool output does not
 * load the execution path or its typebox parameter schema. `bash.ts` spreads these into the shell
 * tool definition, so the tool's public shape is unchanged.
 */

import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { keyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
import { VisualLinePreview } from "../../../modes/interactive/components/visual-truncate.ts";
import { theme } from "../../../modes/interactive/theme/theme.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../../extensions/types.ts";
import type { BashToolDetails } from "../bash.ts";
import { getTextOutput, invalidArgText, startToolTimer, str, toolTimerText } from "../render-utils.ts";
import { DEFAULT_MAX_BYTES, formatSize } from "../truncate.ts";

const BASH_PREVIEW_LINES = 5;
export const BASH_UPDATE_THROTTLE_MS = 100;
class ShellCallRenderComponent extends Text {
	compactToolCall?: Text;
}

function breakShellChain(line: string): string {
	const parts: string[] = [];
	const operators: string[] = [];
	let start = 0;
	let quote = "";
	for (let index = 0; index < line.length; index++) {
		const character = line[index];
		if (character === "\\" && quote !== "'") {
			if (index + 1 === line.length) return line;
			index++;
			continue;
		}
		if (quote) {
			if (quote === '"' && (character === "`" || (character === "$" && "({".includes(line[index + 1] ?? " "))))
				return line;
			if (character === quote) quote = "";
			continue;
		}
		if (character === '"' || character === "'") {
			quote = character;
			continue;
		}
		// Keep compound syntax opaque rather than guessing where its command boundaries lie.
		if (
			"`()[]{}".includes(character) ||
			(character === "$" && "({'".includes(line[index + 1] ?? " ")) ||
			(character === "<" && line[index + 1] === "<")
		)
			return line;
		if (character === "#" && (index === 0 || /[\s&<>;|]/.test(line[index - 1]))) break;
		// Redirection operators belong to the current command, including their | and & characters.
		if (
			(character === ">" && ">|&".includes(line[index + 1] ?? " ")) ||
			(character === "<" && line[index + 1] === "&") ||
			(character === "&" && line[index + 1] === ">")
		) {
			index++;
			if (character === "&" && line[index + 1] === ">") index++;
			continue;
		}
		let operator: string;
		if (character === "&") {
			if (line[index + 1] !== "&") return line;
			operator = "&&";
		} else if (character === "|") {
			operator = line[index + 1] === "|" ? "||" : line[index + 1] === "&" ? "|&" : "|";
		} else if (character === ";") {
			if (line[index + 1] === ";" || line[index + 1] === "&") return line;
			let next = index + 1;
			while (next < line.length && /\s/.test(line[next])) next++;
			if (next === line.length || line[next] === "#") break;
			operator = ";";
		} else {
			continue;
		}
		parts.push(line.slice(start, index).trim());
		operators.push(operator);
		start = index + operator.length;
		index += operator.length - 1;
	}
	if (parts.length === 0) return line;
	parts.push(line.slice(start).trim());
	if (
		parts.some(
			(part) =>
				!part ||
				/^(?:#|(?:!\s+)*(?:if|elif|then|else|fi|for|while|until|case|esac|select|function|do|done|in)\b)/.test(
					part,
				),
		)
	)
		return line;
	return parts.map((part, index) => (index === 0 ? part : `${operators[index - 1]} ${part}`)).join("\n");
}

function formatShellCall(args: { command?: string; timeout?: number } | undefined, prompt: string): string {
	const command = str(args?.command);
	const timeout = args?.timeout as number | undefined;
	const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";
	const commandDisplay = command === null ? invalidArgText(theme) : command ? command : theme.fg("toolOutput", "...");
	return theme.fg("toolTitle", theme.bold(`${prompt} ${commandDisplay}`)) + timeoutSuffix;
}
function rebuildBashResultRenderComponent(
	component: Container,
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: BashToolDetails;
	},
	options: ToolRenderResultOptions,
	showImages: boolean,
	timerText: string | undefined,
): void {
	component.clear();

	let output = getTextOutput(result as any, showImages).trim();
	const truncation = result.details?.truncation;
	const fullOutputPath = result.details?.fullOutputPath;
	if (!options.isPartial && truncation?.truncated && fullOutputPath && output.endsWith("]")) {
		const footerStart = output.lastIndexOf("\n\n[");
		if (footerStart !== -1 && output.slice(footerStart).includes(fullOutputPath)) {
			output = output.slice(0, footerStart).trimEnd();
		}
	}

	if (output) {
		const styledOutput = output
			.split("\n")
			.map((line) => theme.fg("toolOutput", line))
			.join("\n");

		if (options.expanded) {
			component.addChild(new Text(`\n${styledOutput}`, 0, 0));
		} else {
			component.addChild(new Spacer(1));
			component.addChild(
				new VisualLinePreview({
					text: styledOutput,
					maxVisualLines: BASH_PREVIEW_LINES,
					keep: "end",
					formatHint: (hidden) =>
						theme.fg("muted", `... (${hidden} earlier lines,`) +
						` ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`,
				}),
			);
		}
	}

	if (truncation?.truncated || fullOutputPath) {
		const warnings: string[] = [];
		if (fullOutputPath) {
			warnings.push(`Full output: ${fullOutputPath}`);
		}
		if (truncation?.truncated) {
			if (truncation.truncatedBy === "lines") {
				warnings.push(`Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`);
			} else {
				warnings.push(
					`Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`,
				);
			}
		}
		component.addChild(new Text(`\n${theme.fg("warning", `[${warnings.join(". ")}]`)}`, 0, 0));
	}

	if (timerText) component.addChild(new Text(`\n${theme.fg("muted", timerText)}`, 0, 0));
}

/** Shell renderers are shared by bash and powershell. */
export function createShellRenderers(
	prompt: string,
	label: string,
): Pick<ToolDefinition<any, any>, "renderCall" | "renderResult"> {
	return {
		renderCall(args, _theme, context) {
			startToolTimer(context);
			const renderArgs = args as { command?: string; timeout?: number } | undefined;
			const text =
				context.lastComponent instanceof ShellCallRenderComponent
					? context.lastComponent
					: new ShellCallRenderComponent("", 0, 0);
			text.setText(formatShellCall(renderArgs, prompt));
			const lines = str(renderArgs?.command)?.split(/\r\n|\r|\n/) ?? [];
			const first = lines.findIndex((line) => line.trim().length > 0);
			let end = lines.length;
			while (end > first && lines[end - 1]?.trim().length === 0) end--;
			const firstLine = lines[first] ?? "";
			const summaryLine = label === "bash" ? breakShellChain(firstLine) : firstLine;
			if (first >= 0 && (lines.length > 1 || summaryLine !== firstLine)) {
				const count = end - first;
				const entry = formatShellCall({ ...renderArgs, command: summaryLine }, prompt);
				const heading =
					count > 1
						? `${theme.fg("toolTitle", theme.bold(label))}${theme.fg("muted", ` · ${count} lines`)}\n`
						: "";
				text.compactToolCall ??= new Text("", 0, 0);
				text.compactToolCall.setText(heading + entry);
			} else {
				text.compactToolCall = undefined;
			}
			return text;
		},
		renderResult(result, options, _theme, context) {
			const timerText = toolTimerText(context, options.isPartial);
			const component = (context.lastComponent as Container | undefined) ?? new Container();
			rebuildBashResultRenderComponent(component, result as any, options, context.showImages, timerText);
			component.invalidate();
			return component;
		},
	};
}
