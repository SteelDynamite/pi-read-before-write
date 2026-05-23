import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import readBeforeWrite from "../dist/index.js";

async function createHarness() {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-rbw-test-"));
	const handlers = new Map();
	const notifications = [];
	const pi = {
		on(name, handler) {
			const existing = handlers.get(name) ?? [];
			existing.push(handler);
			handlers.set(name, existing);
		},
	};
	const ctx = {
		cwd,
		hasUI: true,
		ui: {
			notify(message, level) {
				notifications.push({ message, level });
			},
		},
	};

	readBeforeWrite(pi);

	return {
		cwd,
		notifications,
		async emit(name, event) {
			let result;
			for (const handler of handlers.get(name) ?? []) {
				result = await handler(event, ctx);
			}
			return result;
		},
		async cleanup() {
			await fs.rm(cwd, { recursive: true, force: true });
		},
	};
}

async function withHarness(fn) {
	const harness = await createHarness();
	try {
		await fn(harness);
	} finally {
		await harness.cleanup();
	}
}

async function readTool(harness, filePath) {
	await harness.emit("tool_result", { toolName: "read", input: { path: filePath }, isError: false });
}

async function successfulMutationTool(harness, toolName, filePath) {
	await harness.emit("tool_result", { toolName, input: { path: filePath }, isError: false });
}

test("edit without a prior read is blocked", async () => {
	await withHarness(async (harness) => {
		await fs.writeFile(path.join(harness.cwd, "file.txt"), "one");

		const result = await harness.emit("tool_call", { toolName: "edit", input: { path: "file.txt" } });

		assert.equal(result?.block, true);
		assert.match(result.reason, /file has not been read/);
		assert.equal(harness.notifications.at(-1)?.level, "warning");
	});
});

test("read then edit is allowed", async () => {
	await withHarness(async (harness) => {
		await fs.writeFile(path.join(harness.cwd, "file.txt"), "one");
		await readTool(harness, "file.txt");

		const result = await harness.emit("tool_call", { toolName: "edit", input: { path: "file.txt" } });

		assert.equal(result, undefined);
	});
});

test("read then external modify then edit is blocked", async () => {
	await withHarness(async (harness) => {
		const filePath = path.join(harness.cwd, "file.txt");
		await fs.writeFile(filePath, "one");
		await readTool(harness, "file.txt");
		await fs.writeFile(filePath, "two");

		const result = await harness.emit("tool_call", { toolName: "edit", input: { path: "file.txt" } });

		assert.equal(result?.block, true);
		assert.match(result.reason, /changed on disk/);
	});
});

test("write to a new file is allowed", async () => {
	await withHarness(async (harness) => {
		const result = await harness.emit("tool_call", { toolName: "write", input: { path: "new.txt" } });

		assert.equal(result, undefined);
	});
});

test("write to an existing file without a prior read is blocked", async () => {
	await withHarness(async (harness) => {
		await fs.writeFile(path.join(harness.cwd, "file.txt"), "one");

		const result = await harness.emit("tool_call", { toolName: "write", input: { path: "file.txt" } });

		assert.equal(result?.block, true);
		assert.match(result.reason, /file has not been read/);
	});
});

test("read then write to an existing file is allowed", async () => {
	await withHarness(async (harness) => {
		await fs.writeFile(path.join(harness.cwd, "file.txt"), "one");
		await readTool(harness, "file.txt");

		const result = await harness.emit("tool_call", { toolName: "write", input: { path: "file.txt" } });

		assert.equal(result, undefined);
	});
});

test("read then delete blocks edit and write", async () => {
	await withHarness(async (harness) => {
		const editPath = path.join(harness.cwd, "edit.txt");
		const writePath = path.join(harness.cwd, "write.txt");
		await fs.writeFile(editPath, "one");
		await fs.writeFile(writePath, "one");
		await readTool(harness, "edit.txt");
		await readTool(harness, "write.txt");
		await fs.rm(editPath);
		await fs.rm(writePath);

		const editResult = await harness.emit("tool_call", { toolName: "edit", input: { path: "edit.txt" } });
		const writeResult = await harness.emit("tool_call", { toolName: "write", input: { path: "write.txt" } });

		assert.equal(editResult?.block, true);
		assert.match(editResult.reason, /deleted since the last read/);
		assert.equal(writeResult?.block, true);
		assert.match(writeResult.reason, /deleted since the last read/);
	});
});

test("read via symlink allows edit via real path", async () => {
	await withHarness(async (harness) => {
		const targetPath = path.join(harness.cwd, "target.txt");
		const linkPath = path.join(harness.cwd, "link.txt");
		await fs.writeFile(targetPath, "one");
		await fs.symlink(targetPath, linkPath);
		await readTool(harness, "link.txt");

		const result = await harness.emit("tool_call", { toolName: "edit", input: { path: "target.txt" } });

		assert.equal(result, undefined);
	});
});

test("read path with leading at-sign allows normal path edit", async () => {
	await withHarness(async (harness) => {
		await fs.writeFile(path.join(harness.cwd, "file.txt"), "one");
		await readTool(harness, "@file.txt");

		const result = await harness.emit("tool_call", { toolName: "edit", input: { path: "file.txt" } });

		assert.equal(result, undefined);
	});
});

test("file URL read allows normal path edit", async () => {
	await withHarness(async (harness) => {
		const filePath = path.join(harness.cwd, "file-url.txt");
		await fs.writeFile(filePath, "one");
		await readTool(harness, new URL(`file://${filePath}`).href);

		const result = await harness.emit("tool_call", { toolName: "edit", input: { path: "file-url.txt" } });

		assert.equal(result, undefined);
	});
});

test("unicode spaces in paths normalize to regular spaces", async () => {
	await withHarness(async (harness) => {
		await fs.writeFile(path.join(harness.cwd, "space file.txt"), "one");
		await readTool(harness, "space\u202Ffile.txt");

		const result = await harness.emit("tool_call", { toolName: "edit", input: { path: "space file.txt" } });

		assert.equal(result, undefined);
	});
});

test("successful edit refreshes the fingerprint", async () => {
	await withHarness(async (harness) => {
		const filePath = path.join(harness.cwd, "file.txt");
		await fs.writeFile(filePath, "one");
		await readTool(harness, "file.txt");
		assert.equal(await harness.emit("tool_call", { toolName: "edit", input: { path: "file.txt" } }), undefined);

		await fs.writeFile(filePath, "two");
		await successfulMutationTool(harness, "edit", "file.txt");

		assert.equal(await harness.emit("tool_call", { toolName: "edit", input: { path: "file.txt" } }), undefined);
	});
});

test("successful write refreshes the fingerprint", async () => {
	await withHarness(async (harness) => {
		const filePath = path.join(harness.cwd, "file.txt");
		await fs.writeFile(filePath, "one");
		await readTool(harness, "file.txt");
		assert.equal(await harness.emit("tool_call", { toolName: "write", input: { path: "file.txt" } }), undefined);

		await fs.writeFile(filePath, "two");
		await successfulMutationTool(harness, "write", "file.txt");

		assert.equal(await harness.emit("tool_call", { toolName: "write", input: { path: "file.txt" } }), undefined);
	});
});

test("fingerprint cache evicts least recently used entries", async () => {
	await withHarness(async (harness) => {
		for (let i = 0; i < 101; i++) {
			const fileName = `file-${i}.txt`;
			await fs.writeFile(path.join(harness.cwd, fileName), String(i));
			await readTool(harness, fileName);
		}

		const evictedResult = await harness.emit("tool_call", { toolName: "edit", input: { path: "file-0.txt" } });
		const retainedResult = await harness.emit("tool_call", { toolName: "edit", input: { path: "file-100.txt" } });

		assert.equal(evictedResult?.block, true);
		assert.match(evictedResult.reason, /file has not been read/);
		assert.equal(retainedResult, undefined);
	});
});

test("fingerprint cache access refreshes recency", async () => {
	await withHarness(async (harness) => {
		for (let i = 0; i < 100; i++) {
			const fileName = `file-${i}.txt`;
			await fs.writeFile(path.join(harness.cwd, fileName), String(i));
			await readTool(harness, fileName);
		}

		assert.equal(await harness.emit("tool_call", { toolName: "edit", input: { path: "file-0.txt" } }), undefined);
		await fs.writeFile(path.join(harness.cwd, "file-100.txt"), "100");
		await readTool(harness, "file-100.txt");

		const evictedResult = await harness.emit("tool_call", { toolName: "edit", input: { path: "file-1.txt" } });
		const retainedResult = await harness.emit("tool_call", { toolName: "edit", input: { path: "file-0.txt" } });

		assert.equal(evictedResult?.block, true);
		assert.match(evictedResult.reason, /file has not been read/);
		assert.equal(retainedResult, undefined);
	});
});
