import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("thinking view settings", () => {
	test("defaults to summary and honors an explicit mode ahead of the old hide flag", () => {
		expect(SettingsManager.inMemory().getThinkingViewMode()).toBe("summary");
		expect(SettingsManager.inMemory({ hideThinkingBlock: true }).getThinkingViewMode()).toBe("collapsed");
		for (const mode of ["collapsed", "summary", "expanded"] as const) {
			expect(
				SettingsManager.inMemory({ hideThinkingBlock: true, thinkingViewMode: mode }).getThinkingViewMode(),
			).toBe(mode);
		}
	});

	test("persists mode changes, preserves unrelated settings, and respects project overrides", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-thinking-settings-"));
		const project = join(directory, "project");
		const settingsPath = join(directory, "settings.json");
		mkdirSync(join(project, ".pi"), { recursive: true });
		try {
			writeFileSync(settingsPath, JSON.stringify({ hideThinkingBlock: false, theme: "dark" }));
			const manager = SettingsManager.create(project, directory);
			manager.setThinkingViewMode("expanded");
			await manager.flush();
			expect(SettingsManager.create(project, directory).getThinkingViewMode()).toBe("expanded");
			expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
				hideThinkingBlock: false,
				theme: "dark",
				thinkingViewMode: "expanded",
			});
			writeFileSync(join(project, ".pi", "settings.json"), JSON.stringify({ thinkingViewMode: "collapsed" }));
			await manager.reload();
			expect(manager.getThinkingViewMode()).toBe("collapsed");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("falls back to summary for an invalid mode loaded from disk", () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-thinking-invalid-"));
		try {
			writeFileSync(join(directory, "settings.json"), JSON.stringify({ thinkingViewMode: "invalid" }));
			const manager = SettingsManager.create(directory, directory);
			expect(manager.getThinkingViewMode()).toBe("summary");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
