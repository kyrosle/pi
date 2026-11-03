import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { isToolViewMode, TOOL_VIEW_MODES } from "../src/core/tool-view.ts";

describe("tool view settings", () => {
	test("defaults to summary and accepts all three modes", () => {
		expect(SettingsManager.inMemory().getToolViewMode()).toBe("summary");
		for (const mode of TOOL_VIEW_MODES) {
			expect(isToolViewMode(mode)).toBe(true);
			expect(SettingsManager.inMemory({ toolViewMode: mode }).getToolViewMode()).toBe(mode);
		}
		for (const value of [undefined, null, false, 0, "invalid"]) {
			expect(isToolViewMode(value)).toBe(false);
		}
	});

	test("persists mode changes, preserves unrelated settings, and respects project overrides", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-tool-settings-"));
		const project = join(directory, "project");
		const settingsPath = join(directory, "settings.json");
		mkdirSync(join(project, ".pi"), { recursive: true });
		try {
			writeFileSync(settingsPath, JSON.stringify({ theme: "dark", thinkingViewMode: "collapsed" }));
			const manager = SettingsManager.create(project, directory);
			for (const mode of TOOL_VIEW_MODES) {
				manager.setToolViewMode(mode);
				await manager.flush();
				expect(SettingsManager.create(project, directory).getToolViewMode()).toBe(mode);
			}
			expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
				theme: "dark",
				thinkingViewMode: "collapsed",
				toolViewMode: "expanded",
			});
			writeFileSync(join(project, ".pi", "settings.json"), JSON.stringify({ toolViewMode: "collapsed" }));
			await manager.reload();
			expect(manager.getToolViewMode()).toBe("collapsed");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("falls back to summary for invalid modes loaded from disk", () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-tool-invalid-"));
		try {
			for (const toolViewMode of ["invalid", null, false, 1]) {
				writeFileSync(join(directory, "settings.json"), JSON.stringify({ toolViewMode }));
				expect(SettingsManager.create(directory, directory).getToolViewMode()).toBe("summary");
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
