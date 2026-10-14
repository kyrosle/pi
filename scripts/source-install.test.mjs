import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { activateSourceInstall, checkSourceInstall, sourceInstallPaths, uninstallSourceInstall, writeSourceGrokEntry } from "./source-install.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function fixture(t) {
	const home = mkdtempSync(join(tmpdir(), "pi source '#?install-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const paths = sourceInstallPaths(home, join(home, ".pi", "agent"));
	return { home, paths };
}

function write(path, contents, mode) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, contents, { mode });
}

function snapshot(paths, marker) {
	mkdirSync(paths.root, { recursive: true });
	const directory = mkdtempSync(join(paths.root, "install-"));
	write(join(directory, "pi"), `#!/bin/sh\nprintf '%s\\n' '${marker}' "$@"\n`, 0o755);
	const extensions = join(directory, "node_modules", "@earendil-works", "pi-coding-agent", "examples", "extensions");
	writeSourceGrokEntry(directory);
	write(join(extensions, "grok-ui.ts"), 'import { PreviewPanel } from "./grok-ui/preview-panel.ts";\nexport default new PreviewPanel();\n');
	write(join(extensions, "grok-ui", "preview-panel.ts"), `export class PreviewPanel { constructor() { this.marker = ${JSON.stringify(marker)}; console.log(this.marker); } }\n`);
	write(join(directory, "grok.json"), JSON.stringify({ name: "grok", marker }));
	write(join(directory, "package.json"), '{"type":"module"}\n');
	return directory;
}

test("Jiti loads the installed Grok entry through user-directory symlinks", async (t) => {
	const { home, paths } = fixture(t);
	write(join(home, ".tpi", "agent", "extensions", "grok-ui.js"), "old copy");
	activateSourceInstall(paths, snapshot(paths, "linked preview"));
	for (const alias of [
		join(paths.agentDirectory, "extensions", "grok-ui.ts"),
		join(home, ".tpi", "agent", "extensions", "grok-ui.js"),
	]) {
		const jiti = createJiti(import.meta.url, { moduleCache: false, fsCache: false, tryNative: false });
		const preview = await jiti.import(alias, { default: true });
		assert.equal(preview.marker, "linked preview");
	}
});

test("installs coherent UI links, updates snapshots, and restores legacy files without touching user data", async (t) => {
	const { home, paths } = fixture(t);
	const oldTs = join(paths.agentDirectory, "extensions", "grok-ui.ts");
	const oldJs = join(paths.agentDirectory, "extensions", "grok-ui.js");
	const oldTheme = join(paths.agentDirectory, "themes", "grok.json");
	const legacy = join(home, ".tpi", "agent", "extensions", "grok-ui.ts");
	write(paths.launcher, "original launcher", 0o755);
	write(oldTs, "old extension");
	symlinkSync("grok-ui.ts", oldJs);
	write(legacy, "other old extension");
	write(oldTheme, "original theme");
	const data = ["settings.json", "auth.json", "sessions/session.jsonl", "extensions/custom.ts", "grok-ui.json"];
	for (const name of data) write(join(paths.agentDirectory, name), name);
	checkSourceInstall(paths);
	const first = snapshot(paths, "first");
	activateSourceInstall(paths, first);
	assert.equal(execFileSync(paths.launcher, ["argument with spaces"], { encoding: "utf8" }), "first\nargument with spaces\n");
	assert.equal(realpathSync(oldTs), realpathSync(oldJs));
	assert.equal(realpathSync(legacy), realpathSync(oldTs));
	const jiti = createJiti(import.meta.url, { moduleCache: false, fsCache: false, tryNative: false });
	assert.equal((await jiti.import(oldTs, { default: true })).marker, "first");
	checkSourceInstall(paths);
	const second = snapshot(paths, "second");
	activateSourceInstall(paths, second);
	assert.equal(readlinkSync(paths.current), second);
	assert.equal((await jiti.import(oldTs, { default: true })).marker, "second");
	assert.equal(JSON.parse(readFileSync(oldTheme, "utf8")).marker, "second");
	const state = JSON.parse(readFileSync(paths.state, "utf8"));
	assert.equal(readFileSync(state.links.find((link) => link.path === oldTs).backup, "utf8"), "old extension");
	// Simulate a deleted optional alias: uninstall must still restore its original symlink.
	rmSync(oldJs);
	uninstallSourceInstall(paths);
	assert.equal(existsSync(paths.root), false);
	assert.equal(readFileSync(paths.launcher, "utf8"), "original launcher");
	assert.equal(lstatSync(paths.launcher).mode & 0o777, 0o755);
	assert.equal(readFileSync(oldTs, "utf8"), "old extension");
	assert.equal(readlinkSync(oldJs), "grok-ui.ts");
	assert.equal(readFileSync(legacy, "utf8"), "other old extension");
	assert.equal(readFileSync(oldTheme, "utf8"), "original theme");
	for (const name of data) assert.equal(readFileSync(join(paths.agentDirectory, name), "utf8"), name);
	uninstallSourceInstall(paths);
});

test("removes only installer-created links on a fresh uninstall", (t) => {
	const { paths } = fixture(t);
	checkSourceInstall(paths);
	activateSourceInstall(paths, snapshot(paths, "fresh"));
	uninstallSourceInstall(paths);
	assert.equal(existsSync(paths.launcher), false);
	assert.equal(existsSync(join(paths.agentDirectory, "extensions", "grok-ui.ts")), false);
	assert.equal(existsSync(paths.root), false);
});

test("refuses changed links before updating or uninstalling", (t) => {
	const { paths } = fixture(t);
	activateSourceInstall(paths, snapshot(paths, "first"));
	rmSync(paths.launcher);
	write(paths.launcher, "user replacement");
	assert.throws(() => checkSourceInstall(paths), /Installed link was changed/);
	assert.throws(() => uninstallSourceInstall(paths), /all backups intact/);
	assert.equal(readFileSync(paths.launcher, "utf8"), "user replacement");
	assert.equal(existsSync(paths.state), true);
});

test("failed activation rolls back the current snapshot and any newly migrated resources", (t) => {
	const { paths } = fixture(t);
	const first = snapshot(paths, "first");
	activateSourceInstall(paths, first);
	const oldJs = join(paths.agentDirectory, "extensions", "grok-ui.js");
	write(oldJs, "newly discovered old copy");
	const second = snapshot(paths, "second");
	// Force the final state rename to fail after switching the current pointer and new alias.
	mkdirSync(`${paths.state}.tmp`);
	assert.throws(() => activateSourceInstall(paths, second));
	assert.equal(readlinkSync(paths.current), first);
	assert.equal(readFileSync(oldJs, "utf8"), "newly discovered old copy");
	assert.equal(JSON.parse(readFileSync(paths.state, "utf8")).installDirectory, first);
});

test("rejects unmanaged install directories and resource directories", (t) => {
	const { paths } = fixture(t);
	write(join(paths.root, "unrelated"), "keep");
	assert.throws(() => checkSourceInstall(paths), /unmanaged directory/);
	rmSync(paths.root, { recursive: true });
	mkdirSync(paths.launcher, { recursive: true });
	assert.throws(() => checkSourceInstall(paths), /replace a directory/);
});

test("shell entrypoints resolve from another cwd and uninstall needs no npm dependencies", (t) => {
	const { home } = fixture(t);
	const env = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: join(home, ".pi", "agent") };
	for (const name of ["install.sh", "uninstall.sh"]) {
		const result = spawnSync("bash", [join(repoRoot, name), "unknown"], { cwd: home, env, encoding: "utf8" });
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /Usage:/);
	}
	const result = spawnSync("bash", [join(repoRoot, "uninstall.sh")], { cwd: home, env, encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /No managed source installation/);
});
