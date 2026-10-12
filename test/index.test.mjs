import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

test("extension instances do not share read authorization", async () => {
	await withHarness(async (first) => {
		await withHarness(async (second) => {
			const filePath = path.join(first.cwd, "file.txt");
			await fs.writeFile(filePath, "one");
			await readTool(first, filePath);
			for (const toolName of ["edit", "write"]) {
				const result = await second.emit("tool_call", { toolName, input: { path: filePath } });
				assert.equal(result?.block, true);
				assert.match(result.reason, /file has not been read/);
			}
		});
	});
});

for (const reason of ["startup", "reload", "new", "resume", "fork"]) {
	test(`session_start (${reason}) clears read authorization and symlink aliases`, async () => {
		await withHarness(async (harness) => {
			const target = path.join(harness.cwd, "target.txt");
			await fs.writeFile(target, "one");
			await fs.symlink(target, path.join(harness.cwd, "link.txt"));
			await readTool(harness, "link.txt");
			await harness.emit("session_start", { reason });
			for (const toolName of ["edit", "write"]) {
				const result = await harness.emit("tool_call", { toolName, input: { path: "target.txt" } });
				assert.equal(result?.block, true);
				assert.match(result.reason, /file has not been read/);
			}
			await readTool(harness, "target.txt");
			await fs.rm(path.join(harness.cwd, "link.txt"));
			assert.equal(await harness.emit("tool_call", { toolName: "write", input: { path: "link.txt" } }), undefined);
		});
	});
}

for (const toolName of ["read", "edit", "write"]) {
	test(`in-flight ${toolName} results cannot authorize a replacement session`, async (t) => {
		await withHarness(async (harness) => {
			const target = path.join(harness.cwd, "target.txt");
			await fs.writeFile(target, "one");
			await fs.symlink(target, path.join(harness.cwd, "link.txt"));
			const original = fs.realpath;
			let entered;
			let release;
			const started = new Promise(resolve => { entered = resolve; });
			const paused = new Promise(resolve => { release = resolve; });
			t.mock.method(fs, "realpath", async (...args) => {
				entered();
				await paused;
				return original(...args);
			});
			const pending = harness.emit("tool_result", { toolName, input: { path: "link.txt" }, isError: false });
			await started;
			await harness.emit("session_start", { reason: "new" });
			release();
			await pending;
			for (const file of ["target.txt", "link.txt"]) {
				const result = await harness.emit("tool_call", { toolName: "write", input: { path: file } });
				assert.equal(result?.block, true);
				assert.match(result.reason, /file has not been read/);
			}
		});
	});
}

for (const code of ["EIO", "EACCES", "EPERM"]) {
	test(`existence check ${code} cannot authorize an unread overwrite`, async (t) => {
		await withHarness(async (harness) => {
			await fs.writeFile(path.join(harness.cwd, "file.txt"), "unread");
			const error = Object.assign(new Error("existence check failed"), { code });
			t.mock.method(fs, "access", async () => { throw error; });
			await assert.rejects(harness.emit("tool_call", { toolName: "write", input: { path: "file.txt" } }), { code });
			assert.equal(await fs.readFile(path.join(harness.cwd, "file.txt"), "utf8"), "unread");
		});
	});
}

test("caught hash failures do not leave an unhandled queue rejection", () => {
	const child = spawnSync(process.execPath, ["--unhandled-rejections=strict", "--input-type=module", "-e", `
		import assert from 'node:assert/strict';
		import { promises as fs } from 'node:fs';
		import readBeforeWrite from './dist/index.js';
		const handlers = new Map();
		readBeforeWrite({ on: (name, handler) => handlers.set(name, handler) });
		const ctx = { cwd: process.cwd() };
		const input = { path: 'package.json' };
		await handlers.get('tool_result')({ toolName: 'read', input }, ctx);
		const original = fs.readFile;
		fs.readFile = async () => { throw Object.assign(new Error('hash failed'), { code: 'EIO' }); };
		await assert.rejects(handlers.get('tool_call')({ toolName: 'edit', input }, ctx), { code: 'EIO' });
		await new Promise(resolve => setImmediate(resolve));
		fs.readFile = original;
		assert.equal(await handlers.get('tool_call')({ toolName: 'edit', input }, ctx), undefined);
	`], { cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8" });
	assert.equal(child.status, 0, child.stderr);
});

test("settled operations release both queue maps", () => {
	const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
		import assert from 'node:assert/strict';
		import { promises as fs } from 'node:fs';
		import readBeforeWrite from './dist/index.js';
		const handlers = new Map();
		readBeforeWrite({ on: (name, handler) => handlers.set(name, handler) });
		const file = await fs.realpath('package.json');
		const queues = new Set();
		const original = Map.prototype.set;
		Map.prototype.set = function(key, value) {
			if (key === file && value instanceof Promise) queues.add(this);
			return original.call(this, key, value);
		};
		try {
			await handlers.get('tool_result')({ toolName: 'read', input: { path: file } }, { cwd: process.cwd() });
			await new Promise(resolve => setImmediate(resolve));
		} finally { Map.prototype.set = original; }
		assert.equal(queues.size, 2);
		for (const queue of queues) assert.equal(queue.size, 0);
	`], { cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8" });
	assert.equal(child.status, 0, child.stderr);
});

test("concurrent same-file guards serialize fingerprint reads", async (t) => {
	await withHarness(async (harness) => {
		await fs.writeFile(path.join(harness.cwd, "file.txt"), "one");
		await readTool(harness, "file.txt");
		const original = fs.readFile;
		let active = 0;
		let maxActive = 0;
		t.mock.method(fs, "readFile", async (...args) => {
			maxActive = Math.max(maxActive, ++active);
			try {
				await new Promise(resolve => setImmediate(resolve));
				return await original(...args);
			} finally {
				active--;
			}
		});
		const results = await Promise.all(Array.from({ length: 8 }, () =>
			harness.emit("tool_call", { toolName: "edit", input: { path: "file.txt" } })));
		assert.deepEqual(results, Array(8).fill(undefined));
		assert.equal(maxActive, 1);
	});
});

test("edit without a prior read is blocked", async () => {
	await withHarness(async (harness) => {
		await fs.writeFile(path.join(harness.cwd, "file.txt"), "one");

		const result = await harness.emit("tool_call", { toolName: "edit", input: { path: "file.txt" } });

		assert.equal(result?.block, true);
		assert.match(result.reason, /file has not been read/);
		assert.deepEqual(harness.notifications, []);
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
