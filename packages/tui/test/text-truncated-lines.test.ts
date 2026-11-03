import assert from "node:assert";
import { describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { Text } from "../src/components/text.ts";
import { visibleWidth } from "../src/utils.ts";

function plain(lines: string[]): string[] {
	return lines.map(stripVTControlCharacters);
}

describe("Text.renderTruncated", () => {
	it("keeps every logical line and truncates each without wrapping", () => {
		const text = new Text("first line is long\nsecond\nthird line is long\nfourth\nfifth", 0, 0);

		assert.deepStrictEqual(plain(text.renderTruncated(10)), [
			"first l...",
			"second    ",
			"third l...",
			"fourth    ",
			"fifth     ",
		]);
	});

	it("normalizes CRLF and CR while preserving blank and trailing lines", () => {
		const text = new Text("first\r\n\rsecond\nthird\n", 0, 0);

		assert.deepStrictEqual(text.renderTruncated(6), ["first ", "      ", "second", "third ", "      "]);
	});

	it("keeps ordinary render wrapping separate from truncated render caching", () => {
		const text = new Text("alpha beta gamma", 0, 0);
		const truncated = text.renderTruncated(10);
		assert.strictEqual(text.renderTruncated(10), truncated);
		assert.deepStrictEqual(plain(truncated), ["alpha b..."]);

		const wrapped = text.render(10);
		assert.strictEqual(text.render(10), wrapped);
		assert.deepStrictEqual(wrapped, ["alpha beta", "gamma     "]);
		assert.notStrictEqual(wrapped, truncated);
		assert.deepStrictEqual(text.renderTruncated(10), truncated);
	});

	it("invalidates cached lines after text, width, and padding changes", () => {
		const text = new Text("one line is long", 0, 0);
		const original = text.renderTruncated(8);
		assert.deepStrictEqual(plain(original), ["one l..."]);
		assert.deepStrictEqual(plain(text.renderTruncated(5)), ["on..."]);
		text.setText("changed text");
		assert.deepStrictEqual(plain(text.renderTruncated(8)), ["chang..."]);
		text.setPaddingX(1);
		assert.deepStrictEqual(plain(text.renderTruncated(8)), [" cha... "]);
		text.invalidate();
		assert.deepStrictEqual(plain(text.renderTruncated(8)), [" cha... "]);
	});

	it("preserves horizontal and vertical padding, tabs, and background", () => {
		const text = new Text("a\tb longer\nshort", 1, 1, (value) => `\x1b[44m${value}\x1b[49m`);
		const lines = text.renderTruncated(10);

		assert.strictEqual(lines.length, 4);
		assert.deepStrictEqual(plain(lines), ["          ", " a   b... ", " short    ", "          "]);
		for (const line of lines) {
			assert.strictEqual(visibleWidth(line), 10);
			assert.ok(line.startsWith("\x1b[44m"));
			assert.ok(line.endsWith("\x1b[49m"));
		}

		text.setCustomBgFn();
		assert.ok(text.renderTruncated(10).every((line) => !line.includes("\x1b[44m")));
	});

	it("keeps CJK and emoji graphemes whole and within the visible width", () => {
		const text = new Text("中文测试内容\n👨‍👩‍👧‍👦abcdefghi\nexact", 0, 0);
		const lines = text.renderTruncated(7);

		assert.deepStrictEqual(plain(lines), ["中文...", "👨‍👩‍👧‍👦ab...", "exact  "]);
		assert.ok(lines.every((line) => visibleWidth(line) === 7));
	});

	it("clips the ellipsis at narrow widths and reduces margins", () => {
		const text = new Text("abcdef\nxy", 1, 0);

		assert.deepStrictEqual(plain(text.renderTruncated(1)), [".", "."]);
		assert.deepStrictEqual(plain(text.renderTruncated(2)), ["..", "xy"]);
		assert.deepStrictEqual(plain(text.renderTruncated(3)), [" . ", " . "]);
	});

	it("does not render for zero or negative width", () => {
		const text = new Text("long\ntext", 1, 1);

		assert.deepStrictEqual(text.renderTruncated(0), []);
		assert.deepStrictEqual(text.renderTruncated(-2), []);
		assert.deepStrictEqual(text.renderTruncated(6), ["      ", " long ", " text ", "      "]);
	});

	it("carries active ANSI styling across original line breaks after truncation", () => {
		const red = "\x1b[31m";
		const lines = new Text(`${red}123456789\nnext\x1b[0m`, 0, 0).renderTruncated(6);

		assert.ok(lines[0].startsWith(`${red}123`));
		assert.ok(lines[0].includes("..."));
		assert.ok(lines[1].startsWith(`${red}next\x1b[0m`));
		assert.ok(lines.every((line) => visibleWidth(line) === 6));
	});

	it("applies a style reset from the omitted tail before the next line", () => {
		const lines = new Text("\x1b[31m123456789\x1b[0m\nplain", 0, 0).renderTruncated(6);

		assert.ok(lines[0].startsWith("\x1b[31m123"));
		assert.strictEqual(lines[1], "plain ");
	});

	it("applies a style change in the omitted tail to the next line", () => {
		const lines = new Text("123456789\x1b[32m\nnext\x1b[0m", 0, 0).renderTruncated(6);

		assert.ok(lines[1].startsWith("\x1b[32mnext\x1b[0m"));
	});

	for (const terminator of ["\x07", "\x1b\\"]) {
		it(`closes and reopens OSC 8 links across original line breaks (${JSON.stringify(terminator)})`, () => {
			const open = `\x1b]8;;https://example.com${terminator}`;
			const close = `\x1b]8;;${terminator}`;
			const lines = new Text(`${open}123456789\nnext${close}\nafter`, 0, 0).renderTruncated(6);

			assert.ok(lines[0].startsWith(open));
			assert.ok(lines[0].includes(close), "Truncated hyperlink must close before ellipsis or padding");
			assert.ok(lines[0].indexOf(close) < lines[0].indexOf("..."), "Ellipsis must not remain clickable");
			assert.ok(lines[1].startsWith(`${open}next${close}`));
			assert.strictEqual(lines[2], "after ");
		});
	}

	it("does not reopen a hyperlink closed in the omitted tail", () => {
		const open = "\x1b]8;;https://example.com\x07";
		const close = "\x1b]8;;\x07";
		const lines = new Text(`${open}123456789${close}\nplain`, 0, 0).renderTruncated(6);

		assert.ok(lines[0].includes(close));
		assert.strictEqual(lines[1], "plain ");
	});
});
