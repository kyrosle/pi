import { stripVTControlCharacters } from "node:util";
import { getCapabilities, setCapabilities, Text, TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { ToolRenderContext, ToolRenderers } from "../src/core/extensions/types.ts";
import { createAllToolRenderers } from "../src/core/tools/renderers/index.ts";
import { codemodeRenderers } from "../src/extensions/codemode/renderer.ts";
import { toolDisplayRenderers } from "../src/extensions/tool-display/renderer.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function createTool(name: string, args: Record<string, unknown>, renderers: ToolRenderers, duplicateWrapper = false) {
	const tui = new TuiAltScreen(new VirtualTerminal(120, 40));
	const wrapped = toolDisplayRenderers(renderers);
	const component = new ToolExecutionComponent(
		name,
		"summary-call",
		args,
		{},
		duplicateWrapper ? toolDisplayRenderers(wrapped) : wrapped,
		tui,
		"/tmp/tool-display-summary",
	);
	return {
		tui,
		component,
		text: (width = 80) => stripVTControlCharacters(component.render(width).join("\n")),
	};
}

function withoutLayout(text: string): string {
	return text.replace(/\b(?:Done|Queued|Running|Failed)\b/g, "").replace(/[\s▸▾]/g, "");
}

function nonemptyLines(lines: string[]): string[] {
	return lines.filter((line) => stripVTControlCharacters(line).trim().length > 0);
}

describe("tool display call summaries", () => {
	beforeAll(() => initTheme("dark"));

	it.each([false, true])(
		"truncates long shell segments instead of wrapping them (duplicate wrapper: %s)",
		(duplicate) => {
			const command =
				`cd /tmp/${"long-directory/".repeat(20)} && ` +
				`printf '%s  %s\\n' 'literal && argument' "quoted argument" | grep -n -- 'END_OF_COMMAND'`;
			const { component, text } = createTool("bash", { command }, createAllToolRenderers().bash, duplicate);
			component.updateResult({ content: [{ type: "text", text: "HIDDEN_RESULT_BODY" }], isError: false });
			for (const width of [12, 24, 40, 80, 120]) {
				const lines = component.render(width);
				expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
				expect(text(width)).toContain("...");
				expect(nonemptyLines(lines)).toHaveLength(width < 24 ? 4 : 3);
				expect(text(width)).not.toContain("HIDDEN_RESULT_BODY");
				expect(text(width)).not.toContain("more lines");
				expect(component.render(width)).toEqual(lines);
			}
			expect(text(40)).toContain("cd /tmp/long-directory/");
			expect(nonemptyLines(component.render(40))).toHaveLength(3);
			expect(text(120)).toContain("| grep -n -- 'END_OF_COMMAND'");
			component.setToolViewMode("collapsed");
			expect(nonemptyLines(component.render(80))).toHaveLength(1);
			component.setToolViewMode("summary");
			expect(text()).toContain("...");
			expect(nonemptyLines(component.render(80))).toHaveLength(3);
		},
	);

	it.each([false, true])("folds a six-line inline Ruby script as one call (duplicate wrapper: %s)", (duplicate) => {
		const command = [
			"cd /tmp/tool-summary-fixture && ruby -e '",
			'require "yaml"',
			"%w[fixture_a fixture_b fixture_c].each do |name|",
			'  document = { "fixture" => name }',
			'  puts "HIDDEN_RUBY_BODY #{document.inspect}"',
			"end' 2>/dev/null",
		].join("\n");
		const { component, text } = createTool("bash", { command }, createAllToolRenderers().bash, duplicate);
		component.updateResult({ content: [{ type: "text", text: "HIDDEN_RESULT_BODY" }], isError: false });
		const output = text(120);
		expect(output).toContain("bash");
		expect(output).toContain("6 lines");
		expect(output).toContain("$ cd /tmp/tool-summary-fixture");
		expect(output).toContain("&& ruby -e '");
		expect(output).not.toContain("require");
		expect(output).not.toContain("HIDDEN_RUBY_BODY");
		expect(output).not.toContain("HIDDEN_RESULT_BODY");
		expect(nonemptyLines(component.render(120))).toHaveLength(3);
		component.setToolViewMode("collapsed");
		expect(nonemptyLines(component.render(120))).toHaveLength(1);
		component.setToolViewMode("expanded");
		expect(text(120)).toContain("HIDDEN_RUBY_BODY");
		expect(text(120)).toContain("HIDDEN_RESULT_BODY");
		component.setToolViewMode("summary");
		expect(text(120)).toBe(output);
	});

	it.each([
		{
			command: "echo A;echo B|cat||echo C&&echo D|&cat",
			segments: ["$ echo A", "; echo B", "| cat", "|| echo C", "&& echo D", "|& cat"],
		},
		{
			command: 'cd /tmp; printf "%s" "pipe|literal" | grep fixture || echo FALLBACK && echo DONE',
			segments: ["$ cd /tmp", '; printf "%s" "pipe|literal"', "| grep fixture", "|| echo FALLBACK", "&& echo DONE"],
		},
		{
			command: "echo A || echo B ; echo C | cat && echo D ; echo E || echo F |& cat",
			segments: ["$ echo A", "|| echo B", "; echo C", "| cat", "&& echo D", "; echo E", "|| echo F", "|& cat"],
		},
	])("preserves every operator in a mixed shell chain: $command", ({ command, segments }) => {
		const { component, text } = createTool("bash", { command }, createAllToolRenderers().bash);
		component.updateResult({ content: [], isError: false });
		const lines = nonemptyLines(component.render(140)).map((line) => stripVTControlCharacters(line));
		expect(lines).toHaveLength(segments.length);
		for (let index = 0; index < segments.length; index++) expect(lines[index]).toContain(segments[index]);
		expect(text().match(/Done/g)).toHaveLength(1);
		component.setToolViewMode("collapsed");
		expect(nonemptyLines(component.render(140))).toHaveLength(1);
		component.setToolViewMode("expanded");
		expect(text(200)).toContain(command);
	});

	it.each([
		{ command: "printf FIRST >|/tmp/out && echo SECOND", first: "printf FIRST >|/tmp/out", last: "&& echo SECOND" },
		{ command: "printf FIRST >&2 | cat", first: "printf FIRST >&2", last: "| cat" },
		{ command: "printf FIRST &>/tmp/out;echo SECOND", first: "printf FIRST &>/tmp/out", last: "; echo SECOND" },
		{ command: "printf FIRST 2>&1 |& cat", first: "printf FIRST 2>&1", last: "|& cat" },
		{ command: "printf FIRST &>>/tmp/out || echo SECOND", first: "printf FIRST &>>/tmp/out", last: "|| echo SECOND" },
		{ command: "cat <&3 && echo SECOND", first: "cat <&3", last: "&& echo SECOND" },
		{ command: "printf FIRST >>/tmp/out;echo SECOND", first: "printf FIRST >>/tmp/out", last: "; echo SECOND" },
	])("distinguishes redirections from shell chain operators: $command", ({ command, first, last }) => {
		const { component } = createTool("bash", { command }, createAllToolRenderers().bash);
		component.updateResult({ content: [], isError: false });
		const lines = nonemptyLines(component.render(140)).map((line) => stripVTControlCharacters(line));
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain(first);
		expect(lines[1]).toContain(last);
	});

	it.each([
		{ command: "echo FIRST;echo SECOND;", last: "; echo SECOND;" },
		{ command: "echo FIRST&&echo SECOND; # trailing | || &&", last: "&& echo SECOND; # trailing | || &&" },
		{ command: "echo FIRST||echo SECOND;# trailing | &&", last: "|| echo SECOND;# trailing | &&" },
	])("keeps trailing semicolons and their comments on the final chain row: $command", ({ command, last }) => {
		const { component, text } = createTool("bash", { command }, createAllToolRenderers().bash);
		component.updateResult({ content: [], isError: false });
		const lines = nonemptyLines(component.render(140)).map((line) => stripVTControlCharacters(line));
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("echo FIRST");
		expect(lines[1]).toContain(last);
		expect(text(140).match(/Done/g)).toHaveLength(1);
	});

	it.each([false, true])("lists every simple bash chain segment (duplicate wrapper: %s)", (duplicate) => {
		const segments = ["cd /tmp/chain-fixture", ...Array.from({ length: 7 }, (_, index) => `echo CALL_${index}`)];
		const { component, text } = createTool(
			"bash",
			{ command: segments.join("&&") },
			createAllToolRenderers().bash,
			duplicate,
		);
		component.updateResult({ content: [{ type: "text", text: "HIDDEN_CHAIN_RESULT" }], isError: false });
		const lines = nonemptyLines(component.render(120)).map((line) => stripVTControlCharacters(line));
		expect(lines).toHaveLength(segments.length);
		expect(lines[0]).toContain(`$ ${segments[0]}`);
		for (let index = 1; index < segments.length; index++) expect(lines[index]).toContain(`&& ${segments[index]}`);
		expect(text().match(/Done/g)).toHaveLength(1);
		expect(text()).not.toContain("HIDDEN_CHAIN_RESULT");
		component.setToolViewMode("collapsed");
		expect(nonemptyLines(component.render(120))).toHaveLength(1);
		component.setToolViewMode("expanded");
		expect(text(240)).toContain(segments.join("&&"));
		expect(text(240)).toContain("HIDDEN_CHAIN_RESULT");
		component.setToolViewMode("summary");
		expect(nonemptyLines(component.render(120))).toHaveLength(segments.length);
	});

	it.each([
		{
			command: "printf '%s' 'literal && argument' && echo REAL",
			first: "'literal && argument'",
			last: "&& echo REAL",
		},
		{
			command: 'printf "%s" "literal && argument" && echo REAL',
			first: '"literal && argument"',
			last: "&& echo REAL",
		},
		{ command: "echo one \\&\\& two && echo REAL", first: "one \\&\\& two", last: "&& echo REAL" },
		{
			command: 'printf "escaped \\" && literal" && echo REAL',
			first: '"escaped \\" && literal"',
			last: "&& echo REAL",
		},
		{
			command: "echo FIRST && echo SECOND # keep && inside comment",
			first: "echo FIRST",
			last: "&& echo SECOND # keep && inside comment",
		},
		{ command: "echo FIRST#suffix&&echo SECOND", first: "echo FIRST#suffix", last: "&& echo SECOND" },
		{
			command: "printf '%s' 'literal ; || | &&' ; echo REAL",
			first: "'literal ; || | &&'",
			last: "; echo REAL",
		},
		{
			command: 'printf "%s" "literal ; || | &&" || echo REAL',
			first: '"literal ; || | &&"',
			last: "|| echo REAL",
		},
		{
			command: "echo one \\;two \\|\\| three \\| four \\&\\& five | cat",
			first: "one \\;two \\|\\| three \\| four \\&\\& five",
			last: "| cat",
		},
		{
			command: "echo FIRST | cat # keep ; || | && inside comment",
			first: "echo FIRST",
			last: "| cat # keep ; || | && inside comment",
		},
		{ command: "echo FIRST#suffix|cat", first: "echo FIRST#suffix", last: "| cat" },
	])("splits only executable chain operators in $command", ({ command, first, last }) => {
		const { component, text } = createTool("bash", { command }, createAllToolRenderers().bash);
		component.updateResult({ content: [], isError: false });
		const lines = nonemptyLines(component.render(140)).map((line) => stripVTControlCharacters(line));
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain(first);
		expect(lines[1]).toContain(last);
		expect(text(140).match(/Done/g)).toHaveLength(1);
	});

	it.each([
		"# comment && ignored",
		"echo $'ANSI-C && literal' && echo SECOND",
		"echo $(printf 'FIRST && INNER') && echo SECOND",
		`echo \${VALUE:-FIRST} && echo SECOND`,
		"echo `printf FIRST` && echo SECOND",
		"(echo FIRST && echo SECOND) && echo THIRD",
		"[[ -d /tmp ]] && echo TRUE",
		"(( 1 + 1 )) && echo TWO",
		"{ echo FIRST; echo SECOND; } && echo THIRD",
		"echo FIRST && cat <<'EOF'",
		"if true; then echo FIRST || echo SECOND; fi",
		'for item in one two; do echo "$item" | cat; done',
		'echo BEFORE; for item in one; do echo "$item"; done',
		"case value in x) echo FIRST ;; *) echo SECOND ;; esac",
		"echo FIRST & echo SECOND | cat",
		"echo FIRST;;echo SECOND",
		"echo FIRST;&echo SECOND",
		"echo FIRST;;&echo SECOND",
		"echo FIRST &&",
		"echo FIRST ||",
		"echo FIRST |",
		"echo FIRST |&",
		"echo FIRST ;",
		"echo FIRST && || echo SECOND",
		"echo FIRST || | cat",
		"echo FIRST | | cat",
		"echo FIRST&&&echo SECOND",
		"echo FIRST|||cat",
		"echo FIRST|&&echo SECOND",
		"echo FIRST;# comment || && | ignored",
		"echo FIRST|# comment ; || && ignored",
		"echo FIRST; fi",
		"echo FIRST|done",
		"echo FIRST||esac",
		"echo FIRST; in word",
	])("keeps complex bash syntax on its original line: %s", (command) => {
		const { component, text } = createTool("bash", { command }, createAllToolRenderers().bash);
		component.updateResult({ content: [], isError: false });
		expect(nonemptyLines(component.render(160))).toHaveLength(1);
		expect(text(160)).toContain(command);
	});

	it("leaves PowerShell chain syntax unchanged", () => {
		const command =
			'Set-Location "C:\\fixture"; Write-Output FIRST | Write-Output SECOND || echo FALLBACK && echo DONE';
		const { component, text } = createTool("powershell", { command }, createAllToolRenderers().powershell);
		component.updateResult({ content: [], isError: false });
		expect(nonemptyLines(component.render(140))).toHaveLength(1);
		expect(text(140)).toContain(command);
	});

	it("truncates each chain segment while keeping the status and height stable", () => {
		const command = `cd /tmp/${"long-directory/".repeat(10)}FIRST_TAIL && echo ${"argument-".repeat(30)}SECOND_TAIL && echo LAST`;
		for (const width of [24, 40, 80]) {
			const { component, text } = createTool("bash", { command }, createAllToolRenderers().bash);
			const queued = withoutLayout(text(width));
			const height = component.render(width).length;
			expect(nonemptyLines(component.render(width))).toHaveLength(3);
			expect(text(width).match(/\.\.\./g)).toHaveLength(2);
			expect(text(width)).not.toContain("FIRST_TAIL");
			expect(text(width)).not.toContain("SECOND_TAIL");
			expect(text(width)).toContain("&& echo LAST");
			component.markExecutionStarted();
			expect(text(width)).toContain("Running");
			expect(withoutLayout(text(width))).toBe(queued);
			expect(component.render(width)).toHaveLength(height);
			component.updateResult({ content: [], isError: false });
			expect(text(width)).toContain("Done");
			expect(withoutLayout(text(width))).toBe(queued);
			expect(component.render(width)).toHaveLength(height);
			expect(component.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
		}
	});

	it.each([false, true])(
		"folds a 39-line heredoc without hiding the call itself (duplicate wrapper: %s)",
		(duplicate) => {
			const commandLines = [
				"cat > /tmp/tool-summary-fixture.rb <<'RUBY'",
				"require 'yaml'",
				...Array.from({ length: 34 }, (_, index) => `puts 'HIDDEN_SCRIPT_BODY_${index}'`),
				"puts 'HIDDEN_SCRIPT_TAIL'",
				"RUBY",
				"ruby /tmp/tool-summary-fixture.rb 2>/dev/null",
			];
			expect(commandLines).toHaveLength(39);
			const { component, text } = createTool(
				"bash",
				{ command: commandLines.join("\n") },
				createAllToolRenderers().bash,
				duplicate,
			);
			component.updateResult({ content: [], isError: false });
			for (const width of [24, 40, 80, 120]) {
				const output = text(width);
				if (width >= 40) expect(output).toContain("39 lines");
				expect(output).toContain("cat >");
				expect(output).not.toContain("HIDDEN_SCRIPT_BODY");
				expect(output).not.toContain("HIDDEN_SCRIPT_TAIL");
				expect(output).not.toContain("ruby /tmp");
				expect(nonemptyLines(component.render(width))).toHaveLength(2);
				expect(component.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
			}
		},
	);

	it.each(["\n", "\r\n", "\r"])("counts shell script logical lines with %j newlines", (newline) => {
		const command = ["", "  ", "echo FIRST_CALL", "", "echo HIDDEN_MIDDLE", "echo HIDDEN_LAST", "", "  "].join(
			newline,
		);
		const { component, text } = createTool("bash", { command }, createAllToolRenderers().bash);
		component.updateResult({ content: [], isError: false });
		expect(text()).toContain("4 lines");
		expect(text()).toContain("echo FIRST_CALL");
		expect(text()).not.toContain("HIDDEN_MIDDLE");
		expect(text()).not.toContain("HIDDEN_LAST");
		expect(nonemptyLines(component.render(80))).toHaveLength(2);
	});

	it.each(["bash", "powershell"] as const)(
		"keeps a single %s invocation on one line despite surrounding newlines",
		(name) => {
			const { component, text } = createTool(
				name,
				{ command: "\n  \n  echo SINGLE_INVOCATION\n\n" },
				createAllToolRenderers()[name],
			);
			component.updateResult({ content: [], isError: false });
			expect(text()).toContain("echo SINGLE_INVOCATION");
			expect(text()).not.toContain("lines");
			expect(nonemptyLines(component.render(80))).toHaveLength(1);
		},
	);

	it.each(["bash", "powershell"] as const)(
		"truncates the first %s script line and keeps status changes stable",
		(name) => {
			const command = `echo FIRST_${"argument-".repeat(50)}HIDDEN_FIRST_TAIL\necho HIDDEN_BODY`;
			for (const width of [24, 40, 80]) {
				const { component, text } = createTool(name, { command }, createAllToolRenderers()[name]);
				const queued = withoutLayout(text(width));
				const height = component.render(width).length;
				if (width >= 40) expect(text(width)).toContain("2 lines");
				expect(text(width)).toContain("...");
				expect(text(width)).not.toContain("HIDDEN_FIRST_TAIL");
				expect(text(width)).not.toContain("HIDDEN_BODY");
				component.markExecutionStarted();
				expect(text(width)).toContain("Running");
				expect(withoutLayout(text(width))).toBe(queued);
				expect(component.render(width)).toHaveLength(height);
				component.updateResult({ content: [], isError: false });
				expect(text(width)).toContain("Done");
				expect(withoutLayout(text(width))).toBe(queued);
				expect(component.render(width)).toHaveLength(height);
				expect(component.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
			}
		},
	);

	it("keeps summary truncation stable as the status changes from queued through completion", () => {
		const command = `printf '${"argument-".repeat(50)}FINAL_ARGUMENT'`;
		for (const width of [24, 40, 80]) {
			const { component, text } = createTool("bash", { command }, createAllToolRenderers().bash);
			const queued = withoutLayout(text(width));
			const height = component.render(width).length;
			component.markExecutionStarted();
			expect(text(width)).toContain("Running");
			expect(withoutLayout(text(width))).toBe(queued);
			expect(component.render(width)).toHaveLength(height);
			component.updateResult({ content: [], isError: false });
			expect(text(width)).toContain("Done");
			expect(withoutLayout(text(width))).toBe(queued);
			expect(component.render(width)).toHaveLength(height);
		}
	});

	it("truncates wide-character linked read paths to one line when resizing", () => {
		const capabilities = getCapabilities();
		setCapabilities({ ...capabilities, hyperlinks: true });
		try {
			const path = `/tmp/${"目录/路径😀/".repeat(15)}FINAL_FILE.ts`;
			const { component, text } = createTool("read", { path, offset: 12, limit: 34 }, createAllToolRenderers().read);
			component.updateResult({ content: [{ type: "text", text: "HIDDEN_READ_BODY" }], isError: false });
			for (const width of [12, 24, 40, 80]) {
				const lines = component.render(width);
				expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
				expect(text(width)).toContain("...");
				expect(text(width)).not.toContain("FINAL_FILE.ts");
				expect(nonemptyLines(lines).length).toBeLessThanOrEqual(2);
				expect(text(width)).not.toContain("HIDDEN_READ_BODY");
			}
			expect(component.render(80).join("\n")).toContain("\x1b]8;");
		} finally {
			setCapabilities(capabilities);
		}
	});

	it.each(["edit", "write"] as const)("truncates the %s path while folding source and diff bodies", (name) => {
		const path = `/tmp/${"long-folder/".repeat(20)}FINAL_FILE.ts`;
		const args =
			name === "write"
				? { path, content: "const HIDDEN_SOURCE_BODY = true;\n" }
				: { path, oldText: "old source", newText: "HIDDEN_SOURCE_BODY" };
		const { component, text } = createTool(name, args, createAllToolRenderers()[name]);
		component.updateResult({
			content: [],
			details: name === "edit" ? { diff: "+1 HIDDEN_SOURCE_BODY", firstChangedLine: 1 } : undefined,
			isError: false,
		});
		for (const width of [24, 40, 80]) {
			expect(text(width)).toContain("...");
			expect(text(width)).not.toContain("FINAL_FILE.ts");
			expect(nonemptyLines(component.render(width))).toHaveLength(1);
			expect(text(width)).not.toContain("HIDDEN_SOURCE_BODY");
		}
		component.setToolViewMode("expanded");
		expect(text()).toContain("HIDDEN_SOURCE_BODY");
		component.setToolViewMode("summary");
		expect(text()).not.toContain("HIDDEN_SOURCE_BODY");
	});

	it.each(["find", "grep", "ls"] as const)("truncates long %s arguments without showing result output", (name) => {
		const path = `/tmp/${"search-directory/".repeat(15)}FINAL_DIRECTORY`;
		const pattern = `${"long-search-pattern-".repeat(10)}FINAL_PATTERN`;
		const { component, text } = createTool(
			name,
			{ path, pattern, glob: "**/*.ts", limit: 432 },
			createAllToolRenderers()[name],
		);
		component.updateResult({ content: [{ type: "text", text: "HIDDEN_SEARCH_OUTPUT" }], isError: false });
		for (const width of [24, 40, 80]) {
			const output = text(width);
			expect(output).toContain("...");
			expect(output).not.toContain("FINAL_DIRECTORY");
			expect(output).not.toContain("FINAL_PATTERN");
			expect(output).not.toContain("HIDDEN_SEARCH_OUTPUT");
			expect(nonemptyLines(component.render(width))).toHaveLength(1);
		}
	});

	it("shows every custom call line without a row cap and truncates each long line", () => {
		const source = Array.from({ length: 12 }, (_, index) => `parameter-${index}: ${"value".repeat(16)}`).join("\n");
		const { component, text } = createTool(
			"custom",
			{},
			{
				renderCall: () => new Text(`custom\n${source}`, 0, 0),
				renderResult: () => new Text("HIDDEN_CUSTOM_OUTPUT", 0, 0),
			},
		);
		component.updateResult({ content: [], isError: false });
		for (let index = 0; index < 12; index++) expect(text(40)).toContain(`parameter-${index}:`);
		expect(text(40).match(/\.\.\./g)).toHaveLength(12);
		expect(text(40)).not.toContain("HIDDEN_CUSTOM_OUTPUT");
		expect(nonemptyLines(component.render(40))).toHaveLength(13);
	});

	it.each([false, true])(
		"keeps each codemode call on one row without a call cap (duplicate wrapper: %s)",
		(duplicate) => {
			const { component, text } = createTool(
				"codemode",
				{ code: 'text("HIDDEN_SCRIPT");' },
				codemodeRenderers,
				duplicate,
			);
			component.updateResult({
				content: [{ type: "text", text: "HIDDEN_CODEMODE_OUTPUT" }],
				details: {
					calls: Array.from({ length: 12 }, (_, index) => ({
						id: `call/${index}`,
						name: `read_${index}`,
						args: JSON.stringify({ path: `/tmp/${"long-directory/".repeat(20)}FINAL_FILE.ts` }),
						status: "ok",
						durationMs: 12,
					})),
				},
				isError: false,
			});
			for (const width of [24, 40, 80]) {
				const lines = component.render(width);
				const output = text(width);
				expect(nonemptyLines(lines)).toHaveLength(13);
				for (let index = 0; index < 12; index++) expect(output).toContain(`✓ read_${index}`);
				expect(output.match(/\.\.\./g)).toHaveLength(12);
				expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
				expect(output).not.toContain("HIDDEN_SCRIPT");
				expect(output).not.toContain("HIDDEN_CODEMODE_OUTPUT");
				expect(output).not.toContain("FINAL_FILE.ts");
			}
		},
	);

	it("preserves native bodies for call renderers that opt out of compact presentation", () => {
		const { component, text } = createTool(
			"custom",
			{},
			{
				renderCall: () => Object.assign(new Text("custom\nNATIVE_CALL_BODY", 0, 0), { compactToolCall: false }),
				renderResult: () => new Text("NATIVE_RESULT_BODY", 0, 0),
			},
		);
		component.updateResult({ content: [], isError: false });
		for (const mode of ["collapsed", "summary", "expanded"] as const) {
			component.setToolViewMode(mode);
			expect(text()).toContain("NATIVE_CALL_BODY");
			expect(text()).toContain("NATIVE_RESULT_BODY");
		}
	});

	it.each([
		`printf '${"long-argument-".repeat(20)}FINAL_COMMAND'`,
		"cd /tmp/hover-fixture&&printf 'SECOND && literal'&&echo FINAL_COMMAND",
		"cd /tmp/hover-fixture;printf 'SECOND ; | || literal'|cat||echo FALLBACK&&echo FINAL_COMMAND",
	])("keeps raw results and the original command in hover and click expansion: %s", (command) => {
		const { component, tui, text } = createTool("bash", { command }, createAllToolRenderers().bash);
		vi.spyOn(tui, "transcriptViewportHeight", "get").mockReturnValue(30);
		const show = vi.spyOn(tui, "showHoverPreview").mockImplementation(() => {});
		component.updateResult({ content: [{ type: "text", text: "COMPLETE_RAW_RESULT" }], isError: false });
		const lines = component.render(80);
		const summary = text();
		const event = {
			type: "move" as const,
			button: "none" as const,
			x: 4,
			y: lines.findIndex((line) => stripVTControlCharacters(line).includes("Done")),
			screenX: 4,
			screenY: 1,
			width: 80,
			height: lines.length,
			shift: false,
			alt: false,
			ctrl: false,
		};
		component.handleMouse(event);
		const panel = show.mock.lastCall?.[1];
		expect(panel).toBeDefined();
		const preview = stripVTControlCharacters(panel!.render(100).join("\n"));
		expect(preview).toContain("COMPLETE_RAW_RESULT");
		expect(withoutLayout(preview).replace(/[─│╭╮╰╯┌┐└┘]/g, "")).toContain(withoutLayout(command));
		expect(text()).toBe(summary);
		component.handleMouse({ ...event, type: "click", button: "left" });
		expect(text()).toContain("COMPLETE_RAW_RESULT");
		expect(withoutLayout(text())).toContain(withoutLayout(command));
		component.handleMouse({ ...event, type: "click", button: "left" });
		expect(text()).toBe(summary);
	});

	it.each([false, true])(
		"reuses the native component as streamed chain boundaries change (duplicate wrapper: %s)",
		(duplicate) => {
			const nativeRenderers = createAllToolRenderers().bash;
			const renderCall = vi.fn(nativeRenderers.renderCall!);
			const renderers = { ...nativeRenderers, renderCall };
			const { component, text } = createTool("bash", { command: "echo FIRST" }, renderers, duplicate);
			const native = renderCall.mock.results[0].value;
			for (const [command, rows] of [
				["echo FIRST&&echo SECOND", 2],
				["echo FIRST&&echo SECOND&&echo THIRD", 3],
				["echo FIRST | cat && echo SECOND", 3],
				["echo FIRST;echo SECOND||echo THIRD", 3],
				["echo FIRST|&cat", 2],
				["echo $(printf FIRST)&&echo SECOND", 1],
				["echo SINGLE_AGAIN", 1],
				["echo FIRST;echo SECOND", 2],
			] as const) {
				component.updateArgs({ command });
				expect(renderCall.mock.lastCall?.[2].lastComponent).toBe(native);
				expect(renderCall.mock.results.at(-1)?.value).toBe(native);
				expect(nonemptyLines(component.render(120))).toHaveLength(rows);
				expect(text(120)).not.toContain("lines");
			}
			component.updateResult({ content: [], isError: false });
			expect(text()).toContain("; echo SECOND");
			expect(text().match(/Done/g)).toHaveLength(1);
			component.setToolViewMode("expanded");
			expect(text()).toContain("echo FIRST;echo SECOND");
			component.setToolViewMode("summary");
			expect(nonemptyLines(component.render(120))).toHaveLength(2);
		},
	);

	it.each([false, true])("keeps the whole script in hover and click previews (duplicate wrapper: %s)", (duplicate) => {
		const command = "cat <<'RUBY'\nputs 'COMPLETE_SCRIPT_BODY'\nRUBY\necho COMPLETE_SCRIPT_TAIL";
		const { component, tui, text } = createTool("bash", { command }, createAllToolRenderers().bash, duplicate);
		vi.spyOn(tui, "transcriptViewportHeight", "get").mockReturnValue(30);
		const show = vi.spyOn(tui, "showHoverPreview").mockImplementation(() => {});
		component.updateResult({ content: [{ type: "text", text: "COMPLETE_SCRIPT_RESULT" }], isError: false });
		const lines = component.render(80);
		const summary = text();
		expect(summary).toContain("4 lines");
		expect(summary).not.toContain("COMPLETE_SCRIPT_BODY");
		expect(summary).not.toContain("COMPLETE_SCRIPT_TAIL");
		expect(summary).not.toContain("COMPLETE_SCRIPT_RESULT");
		const event = {
			type: "move" as const,
			button: "none" as const,
			x: 4,
			y: lines.findIndex((line) => stripVTControlCharacters(line).includes("Done")),
			screenX: 4,
			screenY: 1,
			width: 80,
			height: lines.length,
			shift: false,
			alt: false,
			ctrl: false,
		};
		component.handleMouse(event);
		const panel = show.mock.lastCall?.[1];
		expect(panel).toBeDefined();
		const preview = stripVTControlCharacters(panel!.render(100).join("\n"));
		for (const marker of ["COMPLETE_SCRIPT_BODY", "COMPLETE_SCRIPT_TAIL", "COMPLETE_SCRIPT_RESULT"])
			expect(preview).toContain(marker);
		expect(text()).toBe(summary);
		component.handleMouse({ ...event, type: "click", button: "left" });
		for (const marker of ["COMPLETE_SCRIPT_BODY", "COMPLETE_SCRIPT_TAIL", "COMPLETE_SCRIPT_RESULT"])
			expect(text()).toContain(marker);
		component.handleMouse({ ...event, type: "click", button: "left" });
		expect(text()).toBe(summary);
	});

	it.each([false, true])(
		"updates folded shell metadata while reusing streamed native calls (duplicate wrapper: %s)",
		(duplicate) => {
			const nativeRenderers = createAllToolRenderers().bash;
			const renderCall = vi.fn(nativeRenderers.renderCall!);
			const renderers = { ...nativeRenderers, renderCall };
			const { component, text } = createTool("bash", { command: "echo FIRST" }, renderers, duplicate);
			const native = renderCall.mock.results[0].value;
			expect(nonemptyLines(component.render(80))).toHaveLength(1);
			component.updateArgs({ command: "echo FIRST\necho HIDDEN_BODY" });
			expect(renderCall.mock.lastCall?.[2].lastComponent).toBe(native);
			expect(renderCall.mock.results.at(-1)?.value).toBe(native);
			expect(text()).toContain("2 lines");
			expect(text()).not.toContain("HIDDEN_BODY");
			expect(nonemptyLines(component.render(80))).toHaveLength(2);
			component.updateArgs({ command: "echo FIRST\necho HIDDEN_BODY\necho HIDDEN_TAIL\n" });
			expect(text()).toContain("3 lines");
			expect(text()).not.toContain("HIDDEN_TAIL");
			component.updateArgs({ command: "echo SINGLE_AGAIN" });
			expect(text()).toContain("echo SINGLE_AGAIN");
			expect(text()).not.toContain("lines");
			expect(nonemptyLines(component.render(80))).toHaveLength(1);
			component.updateArgs({ command: "echo FIRST\necho FINAL_SCRIPT_BODY" });
			component.updateResult({ content: [], isError: false });
			expect(text()).toContain("2 lines");
			expect(text()).not.toContain("FINAL_SCRIPT_BODY");
			component.setToolViewMode("expanded");
			expect(text()).toContain("FINAL_SCRIPT_BODY");
			component.setToolViewMode("summary");
			expect(text()).not.toContain("FINAL_SCRIPT_BODY");
		},
	);

	it("reuses native call components while truncating streamed arguments", () => {
		const renderCall = vi.fn((_args: unknown, _theme: unknown, context: ToolRenderContext) => {
			const component = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
			component.setText(`custom ${(context.args as { query: string }).query}`);
			return component;
		});
		const first = "part-".repeat(60);
		const { component, text } = createTool("custom", { query: first }, { renderCall });
		const native = renderCall.mock.results[0].value;
		expect(text(40)).toContain("custom part-part-part-");
		expect(text(40)).toContain("...");
		component.updateArgs({ query: `${first}FINAL_STREAM_TAIL` });
		expect(renderCall.mock.lastCall?.[2].lastComponent).toBe(native);
		component.updateResult({ content: [], isError: false });
		for (const width of [24, 80, 40]) {
			expect(text(width)).toContain("...");
			expect(text(width)).not.toContain("FINAL_STREAM_TAIL");
			expect(nonemptyLines(component.render(width))).toHaveLength(1);
			expect(component.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
		}
		component.setToolViewMode("expanded");
		expect(withoutLayout(text())).toContain(`${first}FINAL_STREAM_TAIL`);
	});
});
