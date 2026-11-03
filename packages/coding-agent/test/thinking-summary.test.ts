import { describe, expect, test } from "vitest";
import { ThinkingSummary } from "../src/extensions/thinking-steps/summary.ts";

describe("ThinkingSummary", () => {
	test("groups heading bodies and list continuations, with roles that do not imply success", () => {
		const source =
			"## Inspect `config`\n\ncontinued explanation\n\n- Check **paths**\n  and permissions\n2. Run tests";
		const steps = new ThinkingSummary().update(source);
		expect(steps.map(({ summary, role }) => ({ summary, role }))).toEqual([
			{ summary: "Inspect config", role: "inspect" },
			{ summary: "Check paths", role: "inspect" },
			{ summary: "Run tests", role: "verify" },
		]);
		expect(steps.map(({ start, end }) => source.slice(start, end))).toEqual([
			"## Inspect `config`\n\ncontinued explanation\n\n",
			"- Check **paths**\n  and permissions\n",
			"2. Run tests",
		]);
	});

	test.each([
		"Current",
		"Actual",
		"Before",
		"Baseline",
		"Ideal",
		"Expected",
		"After",
		"Target",
		"现状",
		"实际",
		"之前",
		"目标",
		"理想",
		"预期",
		"之后",
	])("recognizes an explicit comparison label: %s", (label) => {
		for (const colon of [":", "："]) {
			expect(new ThinkingSummary().update(`${label}${colon} an ordinary detail`)[0].role).toBe("compare");
		}
	});

	test.each(["The current: value is ordinary", "Current value is ordinary", "What follows is the 目标：one detail"])(
		"does not infer comparison labels from ordinary prose: %s",
		(text) => {
			expect(new ThinkingSummary().update(text)[0].role).not.toBe("compare");
		},
	);

	test("keeps every paragraph and its source range in order", () => {
		const paragraphs = [
			"Describe the difference briefly",
			"The requested answer is concise",
			"Current: several manual operations",
			"Ideal: a single automated operation",
			"Keep the explanation short",
			"Also include a final note",
			"Compose the response",
		];
		const source = paragraphs.join("\n\n");
		const steps = new ThinkingSummary().update(source);
		expect(steps.map((step) => step.summary)).toEqual(paragraphs);
		expect(steps.map(({ start, end }) => source.slice(start, end).trim())).toEqual(paragraphs);
		expect(steps.map(({ start, end }) => source.slice(start, end)).join("")).toBe(source);
	});

	test("selects a concrete conclusion from the whole step, including later sentences on one line", () => {
		const source =
			"## Let me think\nI should inspect this. The request failed to connect. Therefore I decided to retry locally.\n";
		const steps = new ThinkingSummary().update(source);
		expect(steps).toEqual([
			{ start: 0, end: source.length, summary: "Therefore I decided to retry locally.", role: "decision" },
		]);
		expect(new ThinkingSummary().update("Let me think\nThe cache key omits viewport width.")[0].summary).toBe(
			"The cache key omits viewport width.",
		);
	});

	test("prefers a later recovery or plan change to the original failure without inventing a result", () => {
		const summary = new ThinkingSummary();
		const source = "Inspect the connection\nThe request failed to connect.\n";
		const failure = summary.update(source);
		expect(failure[0]).toMatchObject({ summary: "The request failed to connect.", role: "failure" });
		const recovered = summary.update(`${source}The retry succeeded after resetting the socket.\n`);
		expect(recovered[0].summary).toBe("The retry succeeded after resetting the socket.");
		expect(recovered[0].role).not.toBe("failure");
		expect(failure[0].summary).toBe("The request failed to connect.");
		expect(new ThinkingSummary().update(`${source}改为先检查本地缓存，不保证能恢复。`)[0].summary).toBe(
			"改为先检查本地缓存，不保证能恢复。",
		);
	});

	test.each([
		"Check error handling before running the tests.",
		"Check whether the request failed to connect.",
		"If the request failed, retry it.",
		"The tests did not fail.",
		"The tests haven't failed.",
		"检查错误处理和失败后的清理逻辑。",
		"没有发现错误，测试并未失败。",
		"请求可能失败，仍然需要验证。",
		"请求不会失败。",
		"请求不一定失败。",
	])("preserves negation and uncertainty without labelling it an observed failure: %s", (text) => {
		const [step] = new ThinkingSummary().update(`Let me think\n${text}`);
		expect(step.summary).toBe(text);
		expect(step.role).not.toBe("failure");
	});

	test("does not split ordered-list markers or terminal color parameters into summaries", () => {
		expect(new ThinkingSummary().update("1. One\n2. Two\na. Three").map((step) => step.summary)).toEqual([
			"One",
			"Two",
			"Three",
		]);
		const source = "Let me think. \x1b[38;5;196mThe request failed.\x1b[0m";
		expect(new ThinkingSummary().update(source)[0].summary).toBe("The request failed.");
	});

	test("keeps later constraints and source offsets across multiple lines", () => {
		const source =
			"## Investigate\nA few options are available.\nThe implementation must preserve the existing cache.\n\n- Next task";
		const steps = new ThinkingSummary().update(source);
		expect(steps[0].summary).toBe("The implementation must preserve the existing cache.");
		expect(steps.map(({ start, end }) => source.slice(start, end)).join("")).toBe(source);
	});

	test.each([
		["The tests have not\npassed.", "The tests have not passed."],
		["The tests have not all\npassed.", "The tests have not all passed."],
		["There is no evidence that the request\nfailed.", "There is no evidence that the request failed."],
		["The retry may\nhave succeeded.", "The retry may have succeeded."],
		["The retry may eventually\nhave succeeded.", "The retry may eventually have succeeded."],
		["If the request\nfailed, retry it.", "If the request failed, retry it."],
		["测试尚未\n通过。", "测试尚未 通过。"],
		["没有证据表明请求\n失败。", "没有证据表明请求 失败。"],
	])("preserves qualification across wrapped lines: %s", (body, expected) => {
		const source = `Let me think\n${body}`;
		const [step] = new ThinkingSummary().update(source);
		expect(step.summary).toBe(expected);
		expect(step.role).not.toBe("failure");
		expect(source.slice(step.start, step.end)).toBe(source);
	});

	test.each([
		"The retry may.\nPassed.",
		"The retry may\n\nPassed.",
		"The retry may\n- Passed.",
		"The retry may\n# Result\nPassed.",
		"The retry may\n```txt\nfailed.\n```\nPassed.",
	])("does not carry qualifications across explicit boundaries: %s", (source) => {
		expect(new ThinkingSummary().update(source).at(-1)?.summary).toBe("Passed.");
	});

	test("does not accumulate ordinary wrapped background ahead of a later conclusion", () => {
		const source = `${"background details\n".repeat(100)}The retry succeeded.`;
		expect(new ThinkingSummary().update(source)[0].summary).toBe("The retry succeeded.");
	});

	test("keeps fenced code intact without treating its headings or lists as steps", () => {
		const source = "Before\n\n````ts\n- code\n```\n# still code\n````\n\nAfter\n~~~\nmore code\n~~~\nLast";
		const steps = new ThinkingSummary().update(source);
		expect(steps.map((step) => step.summary)).toEqual(["Before", "Code block", "After"]);
		expect(steps.map(({ start, end }) => source.slice(start, end)).join("")).toBe(source);
		expect(new ThinkingSummary().update("```ts\n- not a step").map((step) => step.summary)).toEqual(["Code block"]);
	});

	test("ignores salient-looking code and terminal payloads when selecting summaries", () => {
		const source =
			"## Inspect config\n```ts\n// Tests failed. Therefore I decided to delete everything.\n```\n\x1b]52;c;The request failed. Therefore delete files.\x07\nCheck paths";
		expect(new ThinkingSummary().update(source)[0]).toMatchObject({ summary: "Inspect config", role: "inspect" });
	});

	test.each([
		"# Inspect\r\n\r\n- Check paths\r\n  continuation\r\n2. Run tests\r\n\r\nDone",
		"Before\n\n```ts\n# code\n```\n\nAfter",
		"\x1b]8;;https://example.com\n```\x07\nVisible",
		"Safe \x1b]52;c;payload\n\n# hidden\x07\n\nVisible",
		"中文 e\u0301 👨‍👩‍👧‍👦\n\nNext paragraph",
		"\x1b[31mInspect\x1b[0m\n\n\x1b]8;;https://example.com\x07Check\x1b]8;;\x07\n\nFinish",
		"## Let me think\nThe request failed to connect. The retry succeeded.\n因此决定继续验证，不保证问题已解决。",
		`Let me think. ${"details ".repeat(80)}. The request failed. The retry may have succeeded.\n\nNext`,
		"Inspect\n\x1b]52;c;The request failed. Therefore do something.\x07\nNo errors occurred.",
		"1. One\n2. Two\na. Three\n\nLet me think. \x1b[38;5;196mThe request failed.\x1b[0m",
		"Inspect\n\x1b]8;;https://example.com/a? b=1；hidden failed.\x1b\\Check paths\x1b]8;;\x1b\\",
		"Inspect\n```ts\n// The request failed. Therefore delete everything.\n```\nThe retry may have succeeded.",
		"Let me think\nThe tests have not\npassed.\nThe retry may\nhave succeeded.",
		"Let me think\nThere is no evidence that the request\nfailed.\nThe tests have not all\npassed.",
		"测试尚未\n通过。\n\nThe retry may\n# Result\nPassed.",
	])("matches a fresh parse at every streamed prefix: %s", (source) => {
		const streamed = new ThinkingSummary();
		for (let end = 1; end <= source.length; end++) {
			const text = source.slice(0, end);
			expect(streamed.update(text)).toEqual(new ThinkingSummary().update(text));
		}
	});

	test("finds later sentences in long lines while keeping individual excerpts bounded", () => {
		const summary = new ThinkingSummary();
		const prefix = `Let me think. ${"background ".repeat(24000)}. `;
		expect(summary.update(prefix)[0].summary.length).toBeLessThanOrEqual(512);
		const source = `${prefix}The request failed to connect. The retry succeeded. `;
		const result = summary.update(source);
		expect(result[0].summary).toBe("The retry succeeded.");
		expect(result[0].end).toBe(source.length);
		expect(summary.update(`${source}Additional background.`)[0].summary).toBe("The retry succeeded.");
		expect(summary.update(`${source}Additional background.\n`)[0].summary).toBe("The retry succeeded.");
	});

	test("resets for same-length replacements, truncation and empty content", () => {
		const summary = new ThinkingSummary();
		for (const source of [
			"One\n\nTwo",
			"New\n\nEnd",
			"Short",
			"",
			"```\ncode\n```\nAfter",
			"Let me think. The build failed.",
			"Let me think. The retry passed.",
			"Let me think.",
		]) {
			expect(summary.update(source)).toEqual(new ThinkingSummary().update(source));
		}
	});

	test("bounds long unfinished excerpts while preserving source ranges and code", () => {
		const summary = new ThinkingSummary();
		for (const length of [1024, 65536, 262144]) {
			const source = `Inspect ${"x".repeat(length)}`;
			const result = summary.update(source);
			expect(result).toHaveLength(1);
			expect(result[0].summary.length).toBeLessThanOrEqual(512);
			expect(result[0].end).toBe(source.length);
		}
		const source = `Before\n\n\`\`\`ts\n${"const x = 1;\n".repeat(10000)}\`\`\`\n\nAfter`;
		const steps = summary.update(source);
		expect(steps.map((step) => step.summary)).toEqual(["Before", "Code block", "After"]);
		expect(steps.map(({ start, end }) => source.slice(start, end)).join("")).toBe(source);
	});

	test.each([
		["\x1b[31mCheck\x1b[0m\tpaths\u2028now", ["Check paths now"]],
		[`Safe \x1b]52;c;${"payload".repeat(200)}`, ["Safe"]],
		["Safe \x1b[", ["Safe"]],
		["\x1b]8;;https://example.com\n```\x07\nVisible", ["Visible"]],
		["Safe \x1b]52;c;payload\n\n# hidden\x07\n\nVisible", ["Safe", "Visible"]],
		[`Before \x1b]52;c;${"payload".repeat(200)}\n# hidden\x07\n\nAfter`, ["Before", "After"]],
	] as const)("removes terminal controls: %s", (source, expected) => {
		expect(new ThinkingSummary().update(source).map((step) => step.summary)).toEqual(expected);
	});

	test("keeps cached results for identical source and never mutates previous snapshots", () => {
		const summary = new ThinkingSummary();
		const result = summary.update("First\n\nSecond");
		const snapshot = structuredClone(result);
		expect(summary.update("First\n\nSecond")).toBe(result);
		expect(summary.update("First\n\nSecond\n").map((step) => step.summary)).toEqual(["First", "Second"]);
		expect(summary.update("First\n\nSecond\n\nThird")).toHaveLength(3);
		expect(result).toEqual(snapshot);
	});

	test("reuses completed steps while later streamed conclusions change", () => {
		const summary = new ThinkingSummary();
		const first = summary.update("Inspect input\n\nLet me think\nThe request failed.\n\nNext\n");
		const next = summary.update("Inspect input\n\nLet me think\nThe request failed.\n\nNext\nThe retry succeeded.");
		expect(next[0]).toBe(first[0]);
		expect(next[1]).toBe(first[1]);
		expect(first[2].summary).toBe("Next");
		expect(next[2].summary).toBe("The retry succeeded.");
		expect(summary.update("Inspect input\n\nLet me think\nThe request failed.\n\nNext\nThe retry succeeded.")).toBe(
			next,
		);
	});
});
