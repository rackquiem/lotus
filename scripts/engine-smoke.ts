import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { load as parseYaml } from "js-yaml";
import { DEFAULT_SETTINGS } from "../src/engine/defaultSettings";
import { lotusEventLog } from "../src/engine/eventLog";
import { lotusContainerRunner } from "../src/engine/execution/containerRunner";
import { lotusLogger } from "../src/engine/logging";
import { parseMarkdownCodeBlocks } from "../src/engine/parser";
import { setFrontmatterYamlParser } from "../src/engine/reproducibility";
import { lotusReproducibilityService } from "../src/engine/reproducibilityService";
import { lotusRunCoordinator } from "../src/engine/runCoordinator";
import { createBuiltInRunners } from "../src/engine/runners/builtIn";
import { CustomLanguageRunner } from "../src/engine/runners/custom";
import { lotusRunnerRegistry } from "../src/engine/runners/registry";
import type { lotusPluginSettings } from "../src/engine/types";
import type { lotusNoteInfo, lotusVaultHost } from "../src/engine/vaultHost";

setFrontmatterYamlParser((input) => parseYaml(input));

function createFsVaultHost(root: string, notes: string[]): lotusVaultHost {
  const abs = (path: string) => join(root, path);
  const info = (path: string): lotusNoteInfo => ({
    path,
    name: path.split("/").pop() ?? path,
    basename: (path.split("/").pop() ?? path).replace(/\.md$/, ""),
    extension: "md",
    stat: { mtime: Date.now() },
  });
  const readText = async (path: string) => readFile(abs(path), "utf8");
  return {
    configDir: ".obsidian",
    vaultBasePath: root,
    listNotes: () => notes.map(info),
    noteExists: (path) => notes.includes(path) && existsSync(abs(path)),
    readNote: async (path) => notes.includes(path) && existsSync(abs(path)) ? readText(path) : null,
    processNote: async (path, transform) => writeFile(abs(path), transform(await readText(path)), "utf8"),
    writeNote: async (path, content) => writeFile(abs(path), content, "utf8"),
    readFrontmatter: () => undefined,
    processFrontmatter: async () => undefined,
    exists: async (path) => existsSync(abs(path)),
    read: readText,
    write: async (path, content) => {
      await mkdir(dirname(abs(path)), { recursive: true });
      await writeFile(abs(path), content, "utf8");
    },
    mkdir: async (path) => {
      await mkdir(abs(path), { recursive: true });
    },
  };
}

const root = await mkdtemp(join(tmpdir(), "lotus-engine-smoke-"));
try {
  const notePath = "smoke.md";
  await writeFile(join(root, notePath), [
    "# engine smoke",
    "",
    "```python lotus-output-file=\"out/result.txt\"",
    "print('hello from the engine')",
    "```",
    "",
  ].join("\n"), "utf8");

  const settings: lotusPluginSettings = {
    ...DEFAULT_SETTINGS,
    enableLocalExecution: true,
    hasAcknowledgedExecutionRisk: true,
    pythonExecutable: process.env.LOTUS_SMOKE_PYTHON ?? "python3",
  };
  const vault = createFsVaultHost(root, [notePath]);
  const messages: string[] = [];
  const changed: string[] = [];
  const host = {
    vault,
    getSettings: () => settings,
    notify: (message: string) => {
      messages.push(message);
    },
    ensureExecutionEnabled: async () => true,
    onOutputChanged: (blockId: string) => {
      changed.push(blockId);
    },
    onRunStateChanged: () => undefined,
    currentNotePath: () => notePath,
  };
  const events = new lotusEventLog(new lotusLogger({
    vaultName: "engine-smoke",
    configDir: ".obsidian",
    vaultBasePath: root,
    exists: (path) => vault.exists(path),
    read: (path) => vault.read(path),
    append: async (path, content) => vault.write(path, (existsSync(join(root, path)) ? await vault.read(path) : "") + content),
    write: (path, content) => vault.write(path, content),
    mkdir: (path) => vault.mkdir(path),
    postJson: async () => undefined,
  }, () => settings), vault);
  const registry = new lotusRunnerRegistry([...createBuiltInRunners(), new CustomLanguageRunner()]);
  const containerRunner = new lotusContainerRunner({ containersPath: join(root, ".obsidian", "plugins", "lotus", "containers") });
  const reproducibility = new lotusReproducibilityService(host, events);
  const runs = new lotusRunCoordinator(host, registry, containerRunner, events, reproducibility);

  const blocks = parseMarkdownCodeBlocks(notePath, await readFile(join(root, notePath), "utf8"), settings);
  assert.equal(blocks.length, 1, "expected one runnable block");

  const output = await runs.runBlock(vault.listNotes()[0], blocks[0]);
  assert.ok(output, "run produced a stored output");
  assert.equal(output.result.success, true, output.result.stderr);
  assert.equal(output.result.stdout.trim(), "hello from the engine");
  assert.equal(await readFile(join(root, "out", "result.txt"), "utf8"), "hello from the engine\n");
  assert.ok(changed.includes(blocks[0].id), "host was told the output changed");
  assert.ok(messages.some((message) => message.includes("lotus ran")), `expected a completion notice, got ${JSON.stringify(messages)}`);

  const apiRuns = await runs.listApiRuns();
  assert.equal(apiRuns.length, 1);
  assert.equal(apiRuns[0].status, "succeeded");

  console.log("engine smoke passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
