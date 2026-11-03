import { Box, type Component, Text } from "@earendil-works/pi-tui";
import { renderToolPath, str } from "../../core/tools/render-utils.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";

/** Compact titles for built-in calls; complete rendering stays with the tool's renderer. */
export function formatCallSummary(
	toolName: string,
	args: unknown,
	theme: Theme,
	cwd: string,
	call: Component | undefined,
): string | undefined {
	const params = args as { command?: string; timeout?: number; path?: string; file_path?: string } | undefined;
	if (toolName === "edit" || toolName === "write") {
		const title = `${theme.fg("toolTitle", theme.bold(toolName))} ${renderToolPath(str(params?.file_path ?? params?.path), theme, cwd)}`;
		const header = call instanceof Box && call.render === Box.prototype.render ? call.children[0] : call;
		if (!hasNativeTextRendering(header)) return undefined;
		const source = header.getText();
		return source === title || (toolName === "write" && source.startsWith(`${title}\n\n`)) ? title : undefined;
	}
	if (toolName !== "bash" && toolName !== "powershell") return undefined;
	const command = str(params?.command);
	if (!command) return undefined;
	const prompt = toolName === "bash" ? "$" : "PS>";
	const timeout = params?.timeout ? theme.fg("muted", ` (timeout ${params.timeout}s)`) : "";
	// A custom renderer may redact arguments; only reshape text it already displays in native form.
	if (
		!hasNativeTextRendering(call) ||
		call.getText() !== theme.fg("toolTitle", theme.bold(`${prompt} ${command}`)) + timeout
	)
		return undefined;
	const lines = command.split(/\r\n|\r|\n/);
	const first = lines.findIndex((line) => line.trim().length > 0);
	if (first < 0) return undefined;
	let end = lines.length;
	while (end > first && lines[end - 1].trim().length === 0) end--;
	const firstLine = lines[first];
	const summaryLine = toolName === "bash" ? breakShellChain(firstLine) : firstLine;
	if (lines.length === 1 && summaryLine === firstLine) return undefined;
	const count = end - first;
	const heading =
		count > 1 ? `${theme.fg("toolTitle", theme.bold(toolName))}${theme.fg("muted", ` · ${count} lines`)}\n` : "";
	return heading + theme.fg("toolTitle", theme.bold(`${prompt} ${summaryLine}`)) + timeout;
}

function hasNativeTextRendering(component: Component | undefined): component is Text {
	return (
		component instanceof Text &&
		component.render === Text.prototype.render &&
		component.renderTruncated === Text.prototype.renderTruncated
	);
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
