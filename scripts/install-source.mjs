import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { codingAgentName, smokeTestCodingAgent } from "./coding-agent-smoke.mjs";
import { installConsumer, smokeTestNpmConsumer } from "./local-package-install.mjs";
import { produceArtifactSet } from "./package-artifacts.mjs";
import { activateSourceInstall, checkSourceInstall, sourceInstallPaths } from "./source-install.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const paths = sourceInstallPaths();
checkSourceInstall(paths);
mkdirSync(paths.root, { recursive: true });
const directory = mkdtempSync(join(paths.root, "install-"));
try {
	const offlineModelData = spawnSync(process.execPath, [join(repoRoot, "packages", "ai", "scripts", "check-model-data.ts")], { timeout: 30_000 }).status === 0;
	const artifactSet = produceArtifactSet({ repoRoot, outDir: join(directory, "artifacts"), offlineModelData });
	installConsumer({ artifactSet, directory, packageNames: [codingAgentName] });
	smokeTestNpmConsumer({ artifactSet, directory, packageName: codingAgentName });
	smokeTestCodingAgent(directory);
	const packageDirectory = join(directory, "node_modules", codingAgentName);
	cpSync(join(repoRoot, ".pi", "themes", "grok.json"), join(directory, "grok.json"));
	writeFileSync(join(directory, "grok-ui.js"), `export { default } from "./node_modules/${codingAgentName}/examples/extensions/grok-ui.ts";\n`);
	const smokeHome = mkdtempSync(join(directory, "smoke-home-"));
	const smokePath = join(directory, "grok-smoke.mjs");
	try {
		cpSync(join(repoRoot, "scripts", "source-install-smoke.mjs"), smokePath);
		execFileSync(process.execPath, [smokePath], { cwd: directory, stdio: "inherit", timeout: 30_000,
			env: { ...process.env, PI_CODING_AGENT_DIR: smokeHome, PI_OFFLINE: "1", PI_TELEMETRY: "0" },
		});
	} finally {
		rmSync(smokePath, { force: true });
		rmSync(smokeHome, { recursive: true, force: true });
	}
	const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
	writeFileSync(join(directory, "pi"), `#!/usr/bin/env bash
set -euo pipefail
# pi-source-install: paths are pinned to this snapshot, including after an update.
exec ${quote(process.execPath)} ${quote(join(packageDirectory, "dist", "bundle", "cli.js"))} --theme ${quote(join(directory, "grok.json"))} --use-theme grok --tui-mode fullscreen "$@"
`, { mode: 0o755 });
	activateSourceInstall(paths, directory);
	console.log(`Installed ${paths.launcher} from ${artifactSet.source.commit}${artifactSet.source.dirty ? " (dirty checkout)" : ""}.`);
	console.log("Restart running Pi sessions after updating. Update this install with git pull and ./install.sh, not pi update.");
	if (!process.env.PATH?.split(":").includes(dirname(paths.launcher))) {
		console.log('Add ~/.local/bin to PATH: export PATH="$HOME/.local/bin:$PATH"');
	}
} catch (error) {
	if (!existsSync(paths.current) || readlinkSync(paths.current) !== directory) rmSync(directory, { recursive: true, force: true });
	if (!existsSync(paths.state) && !existsSync(paths.current)) rmSync(paths.root, { recursive: true, force: true });
	throw error;
}
