import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(import.meta.dirname, "..");

function getNpmInvocation(args) {
	if (process.platform !== "win32") return { command: "npm", args };

	const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
	return { command: process.execPath, args: [npmCli, ...args] };
}

async function runNpm(args, options = {}) {
	const invocation = getNpmInvocation(args);
	return execFileAsync(invocation.command, invocation.args, {
		cwd: projectRoot,
		maxBuffer: 1024 * 1024 * 10,
		...options,
	});
}

const rootManifest = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));
const { stdout } = await runNpm(["pack", "--json"]);
const packInfo = JSON.parse(stdout).at(0);
assert.ok(packInfo?.filename, "npm pack did not return a tarball filename");

const tarball = path.join(projectRoot, packInfo.filename);
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-rbw-pack-"));

try {
	await runNpm(["init", "-y"], { cwd: tempDir });
	await runNpm(["install", "--omit=dev", tarball], { cwd: tempDir });

	const importCheck = await execFileAsync(
		"node",
		[
			"--input-type=module",
			"-e",
			"const pkg = await import('pi-read-before-write'); if (typeof pkg.default !== 'function') throw new Error('missing default export'); if (typeof pkg.resolveTrackedPath !== 'function') throw new Error('missing resolveTrackedPath export');",
		],
		{ cwd: tempDir, maxBuffer: 1024 * 1024 * 10 },
	);
	assert.equal(importCheck.stderr, "");

	const manifestText = await fs.readFile(path.join(tempDir, "node_modules/pi-read-before-write/package.json"), "utf8");
	const manifest = JSON.parse(manifestText);
	assert.deepEqual(manifest.pi?.extensions, rootManifest.pi?.extensions);
	assert.equal(manifest.version, rootManifest.version);
} finally {
	await fs.rm(tempDir, { recursive: true, force: true });
	await fs.rm(tarball, { force: true });
}

console.log(`pack smoke passed: ${packInfo.filename}`);
