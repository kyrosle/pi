import { describe, expect, test } from "vitest";
import { selectThinkingSteps, ThinkingSummary } from "../src/modes/interactive/components/thinking-summary.ts";

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

	test("selects opening, active step and salient events instead of the latest excerpts", () => {
		const source =
			"Inspect input\n\nFailed to open file\n\nDecided to retry\n\nRead config\n\nWrite output\n\nRun tests\n\nNext task";
		const steps = new ThinkingSummary().update(source);
		expect(selectThinkingSteps(steps).map((step) => step.summary)).toEqual([
			"Inspect input",
			"Failed to open file",
			"Decided to retry",
			"Run tests",
			"Next task",
		]);
		expect(selectThinkingSteps(steps.slice(0, 3))).toEqual(steps.slice(0, 3));
	});

	test("keeps fenced code intact without treating its headings or lists as steps", () => {
		const source = "Before\n\n````ts\n- code\n```\n# still code\n````\n\nAfter\n~~~\nmore code\n~~~\nLast";
		const steps = new ThinkingSummary().update(source);
		expect(steps.map((step) => step.summary)).toEqual(["Before", "Code block", "After"]);
		expect(steps.map(({ start, end }) => source.slice(start, end)).join("")).toBe(source);
		expect(new ThinkingSummary().update("```ts\n- not a step").map((step) => step.summary)).toEqual(["Code block"]);
	});

	test.each([
		"# Inspect\r\n\r\n- Check paths\r\n  continuation\r\n2. Run tests\r\n\r\nDone",
		"Before\n\n```ts\n# code\n```\n\nAfter",
		"\x1b]8;;https://example.com\n```\x07\nVisible",
		"Safe \x1b]52;c;payload\n\n# hidden\x07\n\nVisible",
		"中文 e\u0301 👨‍👩‍👧‍👦\n\nNext paragraph",
		"\x1b[31mInspect\x1b[0m\n\n\x1b]8;;https://example.com\x07Check\x1b]8;;\x07\n\nFinish",
	])("matches a fresh parse at every streamed prefix: %s", (source) => {
		const streamed = new ThinkingSummary();
		for (let end = 1; end <= source.length; end++) {
			const text = source.slice(0, end);
			expect(streamed.update(text)).toEqual(new ThinkingSummary().update(text));
		}
	});

	test("resets for same-length replacements, truncation and empty content", () => {
		const summary = new ThinkingSummary();
		for (const source of ["One\n\nTwo", "New\n\nEnd", "Short", "", "```\ncode\n```\nAfter"]) {
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
});
