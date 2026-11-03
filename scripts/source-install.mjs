import { randomUUID } from "node:crypto";
import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	readlinkSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function writeSourceGrokEntry(directory) {
	// Jiti resolves imports relative to the user-directory symlink, not its target.
	const extension = pathToFileURL(join(directory, "node_modules", "@earendil-works", "pi-coding-agent", "examples", "extensions", "grok-ui.ts"));
	writeFileSync(join(directory, "grok-ui.js"), `export { default } from ${JSON.stringify(extension.href)};\n`);
}

export function writeSourceLauncher(directory, nodeExecutable = process.execPath) {
	const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
	const command = `${quote(nodeExecutable)} ${quote(join(directory, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js"))}`;
	writeFileSync(join(directory, "pi"), `#!/usr/bin/env bash
set -euo pipefail
# pi-source-install: paths are pinned to this snapshot, including after an update.
# CLI subcommands must stay first and do not accept interactive theme options.
case "\${1-}" in
  install|remove|uninstall|update|list|config|auth|mcp) exec ${command} "$@" ;;
esac
exec ${command} --use-theme grok --tui-mode fullscreen "$@"
`, { mode: 0o755 });
}

export function sourceInstallPaths(homeDirectory = homedir(), agentDirectory = process.env.PI_CODING_AGENT_DIR) {
	const root = join(homeDirectory, ".local", "share", "pi-source");
	return {
		root,
		current: join(root, "current"),
		state: join(root, "installation.json"),
		launcher: join(homeDirectory, ".local", "bin", "pi"),
		legacyLauncher: join(homeDirectory, ".bun", "bin", "pi"),
		agentDirectory: resolve(agentDirectory || join(homeDirectory, ".pi", "agent")),
		legacyAgentDirectories: [join(homeDirectory, ".pi", "agent"), join(homeDirectory, ".tpi", "agent")],
	};
}

function pathExists(path) {
	try {
		lstatSync(path);
		return true;
	} catch (error) {
		if (error.code === "ENOENT") return false;
		throw error;
	}
}

function isManagedLink(path, target) {
	return pathExists(path) && lstatSync(path).isSymbolicLink() && readlinkSync(path) === target;
}

function readState(paths) {
	if (!existsSync(paths.state)) return undefined;
	const state = JSON.parse(readFileSync(paths.state, "utf8"));
	if (state.version !== 1 || state.agentDirectory !== paths.agentDirectory || !Array.isArray(state.links)) {
		throw new Error(`Unrecognized source installation or changed PI_CODING_AGENT_DIR: ${paths.state}`);
	}
	const allowedPaths = new Map(resourceLinks(paths, true).map((link) => [link.path, link.target]));
	if (typeof state.installDirectory !== "string" || dirname(state.installDirectory) !== paths.root || !basename(state.installDirectory).startsWith("install-")) {
		throw new Error(`Invalid installation directory in ${paths.state}`);
	}
	for (const link of state.links) {
		if (
			allowedPaths.get(link.path) !== link.target ||
			(link.backup !== undefined && dirname(link.backup) !== join(paths.root, "backups"))
		) throw new Error(`Invalid source installation record: ${paths.state}`);
	}
	return state;
}

function resourceLinks(paths, includeMissing = false) {
	const links = [{ path: paths.launcher, target: join(paths.current, "pi") }];
	let migrateLauncher = isManagedLink(paths.legacyLauncher, join(paths.current, "pi"));
	if (!migrateLauncher && pathExists(paths.legacyLauncher)) {
		const stat = lstatSync(paths.legacyLauncher);
		if (stat.isFile() && stat.size < 4096) {
			const script = readFileSync(paths.legacyLauncher, "utf8");
			// Only adopt the old local-release wrapper, not arbitrary Bun executables or package-manager links.
			migrateLauncher = script.includes(`${join(dirname(paths.root), "pi", "releases")}/`) &&
				/^#!\/bin\/sh\nexec [^\n]+\/node_modules\/@earendil-works\/pi-coding-agent\/dist\/bundle\/cli\.js['"]? "\$@"\n?$/.test(script);
		}
	}
	if (includeMissing || migrateLauncher) links.push({ path: paths.legacyLauncher, target: join(paths.current, "pi") });
	const agentDirectories = new Set([paths.agentDirectory, ...paths.legacyAgentDirectories]);
	for (const directory of agentDirectories) {
		const primary = directory === paths.agentDirectory;
		for (const name of ["grok-ui.ts", "grok-ui.js"]) {
			const path = join(directory, "extensions", name);
			if (includeMissing || (primary && name === "grok-ui.ts") || pathExists(path)) {
				links.push({ path, target: join(paths.current, "grok-ui.js") });
			}
		}
		const path = join(directory, "themes", "grok.json");
		if (includeMissing || primary || pathExists(path)) links.push({ path, target: join(paths.current, "grok.json") });
	}
	return links;
}

export function checkSourceInstall(paths) {
	if (process.platform === "win32") throw new Error("Source install.sh supports macOS and Linux.");
	const [major, minor] = process.versions.node.split(".").map(Number);
	if (major < 22 || (major === 22 && minor < 19)) throw new Error("Pi requires Node.js 22.19 or newer.");
	const state = readState(paths);
	if (!state && pathExists(paths.root) && readdirSync(paths.root).length > 0) {
		throw new Error(`Refusing to replace an unmanaged directory: ${paths.root}`);
	}
	if (state && !isManagedLink(paths.current, state.installDirectory)) {
		throw new Error(`Source installation entry was changed: ${paths.current}`);
	}
	for (const link of state?.links ?? []) {
		if (!isManagedLink(link.path, link.target)) {
			throw new Error(`Installed link was changed; preserve or restore it before updating: ${link.path}`);
		}
	}
	for (const link of resourceLinks(paths)) {
		if (pathExists(link.path) && !lstatSync(link.path).isFile() && !lstatSync(link.path).isSymbolicLink()) {
			throw new Error(`Refusing to replace a directory: ${link.path}`);
		}
	}
}

function replaceLink(path, target) {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = join(dirname(path), `.${basename(path)}-${randomUUID()}`);
	try {
		symlinkSync(target, temporary);
		renameSync(temporary, path);
	} finally {
		rmSync(temporary, { force: true });
	}
}

function copyOriginal(source, target) {
	if (lstatSync(source).isSymbolicLink()) symlinkSync(readlinkSync(source), target);
	else cpSync(source, target, { preserveTimestamps: true });
}

function restoreLink(link) {
	if (!link.backup) {
		rmSync(link.path, { force: true });
		return;
	}
	const temporary = join(dirname(link.path), `.${basename(link.path)}-${randomUUID()}`);
	try {
		copyOriginal(link.backup, temporary);
		renameSync(temporary, link.path);
	} finally {
		rmSync(temporary, { force: true });
	}
}

export function activateSourceInstall(paths, installDirectory) {
	if (dirname(installDirectory) !== paths.root || !basename(installDirectory).startsWith("install-")) {
		throw new Error(`Installation must be a snapshot inside ${paths.root}`);
	}
	for (const name of ["pi", "grok-ui.js", "grok.json"]) {
		if (!existsSync(join(installDirectory, name))) throw new Error(`Missing installed resource: ${name}`);
	}
	const previous = readState(paths);
	if (previous) checkSourceInstall(paths);
	const links = resourceLinks(paths).map((link) => {
		const existing = previous?.links.find((entry) => entry.path === link.path);
		if (existing) return existing;
		if (!pathExists(link.path)) return link;
		const backup = join(paths.root, "backups", randomUUID());
		mkdirSync(dirname(backup), { recursive: true });
		copyOriginal(link.path, backup);
		return { ...link, backup };
	});
	const replaced = [];
	try {
		replaceLink(paths.current, installDirectory);
		for (const link of links) {
			if (previous?.links.some((entry) => entry.path === link.path)) continue;
			replaceLink(link.path, link.target);
			replaced.push(link);
		}
		const state = { version: 1, agentDirectory: paths.agentDirectory, installDirectory, links };
		const temporary = `${paths.state}.tmp`;
		writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
		renameSync(temporary, paths.state);
	} catch (error) {
		for (const link of replaced.reverse()) restoreLink(link);
		if (previous) replaceLink(paths.current, previous.installDirectory);
		else rmSync(paths.current, { force: true });
		for (const link of links) {
			if (link.backup && !previous?.links.some((entry) => entry.path === link.path)) rmSync(link.backup);
		}
		rmSync(`${paths.state}.tmp`, { force: true });
		if (!previous) rmSync(join(paths.root, "backups"), { recursive: true, force: true });
		throw error;
	}
	for (const link of links.filter((entry) => entry.backup)) {
		console.log(`Original ${link.path} preserved in ${link.backup}`);
	}
}

export function uninstallSourceInstall(paths) {
	const state = readState(paths);
	if (!state) {
		console.log("No managed source installation found.");
		return;
	}
	for (const link of state.links) {
		if (pathExists(link.path) && !isManagedLink(link.path, link.target)) {
			throw new Error(`Installed link was changed; uninstall left it and all backups intact: ${link.path}`);
		}
		if (link.backup && !pathExists(link.backup)) throw new Error(`Missing original backup: ${link.backup}`);
	}
	for (const link of state.links) restoreLink(link);
	rmSync(paths.root, { recursive: true });
	console.log("Source installation removed; original launchers and Grok resources restored. User data retained.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const paths = sourceInstallPaths();
	if (process.argv[2] === "preflight") checkSourceInstall(paths);
	else if (process.argv[2] === "uninstall") uninstallSourceInstall(paths);
	else throw new Error("Usage: node scripts/source-install.mjs preflight|uninstall");
}
