import { access, mkdir, mkdtemp, readFile as fsReadFile, readdir, rm, writeFile } from "fs/promises";
import { constants } from "fs";
import { delimiter } from "path";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "path";
import { pathToFileURL } from "url";
import { spawn } from "child_process";
import { createServer, request as httpRequest } from "http";
import { request as httpsRequest } from "https";
import { generateKeyPairSync } from "crypto";
import { tmpdir } from "os";
import { DEFAULT_SETTINGS } from "../src/engine/defaultSettings";
import { findEnabledCommandLanguage, normalizeLanguageConfiguration } from "../src/engine/languagePackages";
import { getLanguageCapability } from "../src/engine/languageCapabilities";
import { parseMarkdownCodeBlocks } from "../src/engine/parser";
import { resolveReferencedSource } from "../src/engine/sourceExtract";
import { runExternalSourcePreprocessorPipeline, type lotusExternalSourcePreprocessor } from "../src/engine/sourcePreprocess";
import { buildSourceReferenceHarness } from "../src/engine/sourceHarness";
import { createOpenSshSignature, createPassphraseSignature, createRsaSignature, readSignatureRecord, verifyOpenSshSignature, verifyPassphraseSignature, verifyRsaSignature } from "../src/engine/signing";
import { createBuiltInRunners } from "../src/engine/runners/builtIn";
import { CustomLanguageRunner } from "../src/engine/runners/custom";
import { lotusRunnerRegistry } from "../src/engine/runners/registry";
import { lotusContainerRunner } from "../src/engine/execution/containerRunner";
import { runProcess } from "../src/engine/execution/processRunner";
import { parseTimeoutMs } from "../src/engine/utils/timeout";
import { createSourceVisualizationDisplay, createStdoutVisualizationDisplay } from "../src/engine/visualization/codeGraph";
import { assertRunnableCodePackage } from "../src/engine/codePackage";
import type { lotusCodeBlock, lotusPluginSettings, lotusResolvedExecutionContext, lotusRunResult, lotusSourcePreview } from "../src/engine/types";

type SmokeProfile = "minimal" | "systems" | "proofs" | "ebpf" | "full";

interface SmokeBlockResult {
  profile: SmokeProfile;
  note: string;
  ordinal: number;
  language: string;
  status: "passed" | "failed" | "skipped";
  name: string;
  runnerName?: string;
  durationMs?: number;
  stdout?: string;
  stderr?: string;
  warning?: string;
  reason?: string;
  sourcePreview?: string;
}

interface NoteFile {
  path: string;
  absolutePath: string;
  source: string;
  frontmatter: Record<string, string>;
}

interface SmokeRequestUrlParam {
  url: string;
  method?: string;
  contentType?: string;
  body?: string | ArrayBuffer;
  headers?: Record<string, string>;
  throw?: boolean;
}

interface SmokeGodboltCompilerState {
  compiler?: string;
  id?: string;
  options?: string;
  filters?: Record<string, unknown>;
}

const argv = readArgs(process.argv.slice(2));
const vaultDir = resolve(requiredArg(argv, "vault"));
const artifactDir = resolve(requiredArg(argv, "artifacts"));
const profile = readProfile(argv.profile ?? "full");
const requirePdf = argv["require-pdf"] === "true";
const requireAll = argv["require-all"] === "true";
const configDir = readConfigDir(argv["config-dir"] ?? process.env.LOOM_OBSIDIAN_CONFIG_DIR);
const configRootDir = configDir.split("/")[0] ?? configDir;
const pluginDir = `${configDir}/plugins/lotus`;
const settings = await loadSettings(vaultDir, profile);
const registry = new lotusRunnerRegistry([
  ...createBuiltInRunners(),
  new CustomLanguageRunner(),
]);
const containerRunner = new lotusContainerRunner({ containersPath: join(vaultDir, pluginDir, "containers") }, smokeRequestUrl);
const notes = await readNotes(vaultDir);
const results: SmokeBlockResult[] = [];

for (const note of notes) {
  const blocks = parseMarkdownCodeBlocks(note.path, note.source, settings);
  for (const block of blocks.filter((block) => shouldRunForProfile(block, profile))) {
    results.push(await runBlock(note, block));
  }
}
results.push(...await runCodePackageSmoke());
results.push(...await runTransportSmoke());
results.push(...await runSigningSmoke());

await mkdir(artifactDir, { recursive: true });
await writeFile(join(artifactDir, "report.json"), JSON.stringify({
  generatedAt: new Date().toISOString(),
  profile,
  vault: vaultDir,
  results,
  totals: summarize(results),
}, null, 2), "utf8");
await writeFile(join(artifactDir, "report.md"), renderMarkdownReport(results), "utf8");
const htmlPath = join(artifactDir, "report.html");
await writeFile(htmlPath, renderHtmlReport(results), "utf8");
await renderPdfIfPossible(htmlPath, join(artifactDir, "report.pdf"), requirePdf);

const failed = results.filter((result) => result.status === "failed");
const skipped = results.filter((result) => result.status === "skipped");
console.log(`Smoke profile ${profile}: ${results.length} blocks, passed: ${results.length - failed.length - skipped.length}, skipped: ${skipped.length}, failed: ${failed.length}`);

if (failed.length) {
  for (const failure of failed) {
    console.error(`${failure.note}#${failure.ordinal} ${failure.language}: ${failure.reason ?? "failed"}`);
  }
  process.exitCode = 1;
}
if (requireAll && skipped.length) {
  for (const skip of skipped) {
    console.error(`${skip.note}#${skip.ordinal} ${skip.language}: skipped under --require-all (${skip.reason ?? "skipped"})`);
  }
  process.exitCode = 1;
}

async function runBlock(note: NoteFile, block: lotusCodeBlock): Promise<SmokeBlockResult> {
  const directives = readSmokeDirectives(block);
  const name = block.attributes["lotus-smoke-name"] || `${note.path}#${block.ordinal}`;
  if (directives.has("skip")) {
    return { profile, note: note.path, ordinal: block.ordinal, language: block.language, status: "skipped", name, reason: "marked skip" };
  }

  const context = resolveCliExecutionContext(note, block, settings);
  const controller = new AbortController();
  let sourcePreview: lotusSourcePreview | undefined;
  let executableBlock = block;
  let preprocessDescription: string | undefined;
  try {
    const resolved = await resolveExecutableBlock(note, block);
    executableBlock = resolved.block;
    sourcePreview = resolved.sourcePreview;
    preprocessDescription = resolved.preprocessDescription;
  } catch (error) {
    return {
      profile,
      note: note.path,
      ordinal: block.ordinal,
      language: block.language,
      status: "failed",
      name,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  const runContext = {
    file: { path: note.path } as never,
    workingDirectory: context.workingDirectory,
    timeoutMs: context.timeoutMs,
    signal: controller.signal,
    stdin: await resolveBlockStdin(note, block),
  };

  if (context.containerGroup) {
    const result = await containerRunner.run(executableBlock, runContext, settings, context.containerGroup);
    if (sourcePreview) {
      const sourceNotice = `Ran extracted source from ${sourcePreview.description}.`;
      result.warning = result.warning ? `${sourceNotice}\n${result.warning}` : sourceNotice;
    }
    if (preprocessDescription) {
      const preprocessorNotice = `Ran preprocessed source with ${preprocessDescription}.`;
      result.warning = result.warning ? `${preprocessorNotice}\n${result.warning}` : preprocessorNotice;
    }
    return await classifyResult(note, executableBlock, name, directives, `Execution group ${context.containerGroup}`, result, sourcePreview);
  }

  const runner = registry.getRunnerForBlock(executableBlock, settings);
  if (!runner) {
    return {
      profile,
      note: note.path,
      ordinal: block.ordinal,
      language: block.language,
      status: directives.has("skip-missing") ? "skipped" : "failed",
      name,
      reason: "no configured runner",
    };
  }

  const result = await runner.run(executableBlock, runContext, settings);

  if (sourcePreview) {
    const sourceNotice = `Ran extracted source from ${sourcePreview.description}.`;
    result.warning = result.warning ? `${sourceNotice}\n${result.warning}` : sourceNotice;
  }
  if (preprocessDescription) {
    const preprocessorNotice = `Ran preprocessed source with ${preprocessDescription}.`;
    result.warning = result.warning ? `${preprocessorNotice}\n${result.warning}` : preprocessorNotice;
  }

  return await classifyResult(note, executableBlock, name, directives, runner.displayName, result, sourcePreview);
}

async function runSigningSmoke(): Promise<SmokeBlockResult[]> {
  if (profile !== "minimal" && profile !== "full") {
    return [];
  }

  const payload = JSON.stringify({
    version: 1,
    noteHash: "c0ffee",
    policy: { preset: "strict" },
    blocks: [{ id: "smoke", language: "python", hash: "deadbeef" }],
  });

  return [
    await runSyntheticSmoke("signing-passphrase", async () => {
      const signature = createPassphraseSignature(payload, "lotus smoke passphrase", "smoke");
      if (!verifyPassphraseSignature(signature, payload, "lotus smoke passphrase")) {
        throw new Error("passphrase signature did not verify");
      }
      if (verifyPassphraseSignature(signature, `${payload}!`, "lotus smoke passphrase")) {
        throw new Error("passphrase signature verified a modified payload");
      }
      if (!readSignatureRecord(JSON.parse(JSON.stringify(signature)))) {
        throw new Error("passphrase signature record did not parse");
      }
    }),
    await runSyntheticSmoke("signing-rsa-pss", async () => {
      const { privateKey, publicKey } = generateKeyPairSync("rsa", {
        modulusLength: 2048,
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      });
      const signature = createRsaSignature(payload, privateKey, undefined, "smoke");
      if (!verifyRsaSignature(signature, payload, publicKey)) {
        throw new Error("RSA-PSS signature did not verify");
      }
      if (verifyRsaSignature(signature, `${payload}!`, publicKey)) {
        throw new Error("RSA-PSS signature verified a modified payload");
      }
      if (!readSignatureRecord(JSON.parse(JSON.stringify(signature)))) {
        throw new Error("RSA-PSS signature record did not parse");
      }
    }),
    await runSyntheticSmoke("signing-openssh-sshsig", async () => {
      const sshKeygen = await findExecutable(["ssh-keygen"]);
      if (!sshKeygen) {
        return { skipped: true, reason: "ssh-keygen not available" };
      }

      const tempDir = await mkdtemp(join(tmpdir(), "lotus-smoke-sshsig-"));
      try {
        const keyPath = join(tempDir, "id_ed25519");
        const keygenExit = await runCommand(sshKeygen, ["-q", "-t", "ed25519", "-N", "", "-C", "lotus-smoke", "-f", keyPath]);
        if (keygenExit !== 0) {
          throw new Error("ssh-keygen failed to create a smoke signing key");
        }

        const namespace = "lotus-smoke@example.local";
        const signer = "lotus-smoke";
        const publicKey = await fsReadFile(`${keyPath}.pub`, "utf8");
        const signature = await createOpenSshSignature(payload, keyPath, namespace, signer, "ssh:smoke");
        const allowedSigners = `${signer} namespaces="${namespace}" ${publicKey}`;
        if (!await verifyOpenSshSignature(signature, payload, allowedSigners)) {
          throw new Error("OpenSSH SSHSIG signature did not verify");
        }
        if (await verifyOpenSshSignature(signature, `${payload}!`, allowedSigners)) {
          throw new Error("OpenSSH SSHSIG signature verified a modified payload");
        }
        if (!readSignatureRecord(JSON.parse(JSON.stringify(signature)))) {
          throw new Error("OpenSSH SSHSIG signature record did not parse");
        }
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    }),
  ];
}

async function runCodePackageSmoke(): Promise<SmokeBlockResult[]> {
  if (profile !== "systems" && profile !== "full") {
    return [];
  }

  return [
    await runSyntheticSmoke("code-package-c-multifile", async () => {
      const source = [
        "```h lotus-code-package=answer lotus-code-file=include/answer.h",
        "#ifndef ANSWER_H",
        "#define ANSWER_H",
        "int answer(void);",
        "#endif",
        "```",
        "",
        "```c lotus-code-package=answer lotus-code-file=answer.c",
        "#include \"include/answer.h\"",
        "int answer(void) { return 42; }",
        "```",
        "",
        "```c lotus-code-package=answer lotus-code-file=main.c",
        "#include <stdio.h>",
        "#include \"include/answer.h\"",
        "int main(void) {",
        "  printf(\"%d\\n\", answer());",
        "  return 0;",
        "}",
        "```",
      ].join("\n");
      const blocks = parseMarkdownCodeBlocks("Code Package Smoke.md", source, settings);
      if (blocks.length !== 3 || blocks.some((block) => !block.codePackage)) {
        throw new Error(`expected three packaged blocks, got ${blocks.length}`);
      }
      if (blocks.some((block) => block.sourceReference)) {
        throw new Error("lotus-code-file was incorrectly parsed as a source reference");
      }
      const paths = blocks[0].codePackage!.files.map((file) => file.path).join(",");
      if (paths !== "include/answer.h,answer.c,main.c") {
        throw new Error(`unexpected package files: ${paths}`);
      }

      const controller = new AbortController();
      for (const block of blocks) {
        const runner = registry.getRunnerForBlock(block, settings);
        if (!runner) {
          throw new Error("no configured C runner for code package smoke");
        }
        const result = await runner.run(block, {
          file: { path: "Code Package Smoke.md" } as never,
          workingDirectory: vaultDir,
          timeoutMs: 10_000,
          signal: controller.signal,
        }, settings);
        if (!result.success || result.stdout.trim() !== "42") {
          throw new Error(result.stderr || `code package returned ${JSON.stringify(result.stdout)}`);
        }
      }
    }),
    await runSyntheticSmoke("code-package-cpp-multifile", async () => {
      const source = [
        "```cpp lotus-code-package=answer-cpp lotus-code-file=answer.cc",
        "int answer() { return 42; }",
        "```",
        "",
        "```cpp lotus-code-package=answer-cpp lotus-code-file=main.cpp",
        "#include <iostream>",
        "int answer();",
        "int main() { std::cout << answer() << '\\n'; }",
        "```",
      ].join("\n");
      const blocks = parseMarkdownCodeBlocks("C++ Code Package Smoke.md", source, settings);
      const block = blocks[1];
      const runner = block ? registry.getRunnerForBlock(block, settings) : null;
      if (!block || !runner) {
        throw new Error("no configured C++ runner for code package smoke");
      }
      const result = await runner.run(block, {
        file: { path: "C++ Code Package Smoke.md" } as never,
        workingDirectory: vaultDir,
        timeoutMs: 10_000,
        signal: new AbortController().signal,
      }, settings);
      if (!result.success || result.stdout.trim() !== "42") {
        throw new Error(result.stderr || `C++ code package returned ${JSON.stringify(result.stdout)}`);
      }
    }),
    await runSyntheticSmoke("code-package-inferred-files-and-identity", async () => {
      const source = [
        "```h lotus-code-package=auto",
        "int answer(void);",
        "```",
        "",
        "```c lotus-code-package=auto",
        "int answer(void) { return 42; }",
        "```",
      ].join("\n");
      const blocks = parseMarkdownCodeBlocks("Inferred Package.md", source, settings);
      const paths = blocks[0]?.codePackage?.files.map((file) => file.path).join(",");
      if (paths !== "block-1.h,block-2.c") {
        throw new Error(`unexpected inferred package files: ${paths ?? "(none)"}`);
      }

      const changed = parseMarkdownCodeBlocks("Inferred Package.md", source.replace("return 42", "return 43"), settings);
      if (blocks.some((block, index) => block.id === changed[index]?.id)) {
        throw new Error("a sibling package edit did not invalidate every package block id");
      }

      const otherNote = parseMarkdownCodeBlocks("Other Note.md", [
        "```c lotus-code-package=auto",
        "int main(void) { return 0; }",
        "```",
      ].join("\n"), settings);
      if (otherNote[0]?.codePackage?.files.length !== 1) {
        throw new Error("same-named packages leaked across notes");
      }
    }),
    await runSyntheticSmoke("code-package-validation", async () => {
      const duplicate = parseMarkdownCodeBlocks("Duplicate Package.md", [
        "```c lotus-code-package=bad lotus-code-file=Main.c",
        "int main(void) { return 0; }",
        "```",
        "```c lotus-code-package=bad lotus-code-file=main.c",
        "int helper(void) { return 0; }",
        "```",
      ].join("\n"), settings)[0];
      expectCodePackageError(duplicate, "filename \"main.c\" is used by blocks 1 and 2");

      const unsafe = parseMarkdownCodeBlocks("Unsafe Package.md", [
        "```c lotus-code-package=bad lotus-code-file=../main.c",
        "int main(void) { return 0; }",
        "```",
      ].join("\n"), settings)[0];
      expectCodePackageError(unsafe, ".. path segments aren't allowed");

      const mixed = parseMarkdownCodeBlocks("Mixed Package.md", [
        "```c lotus-code-package=bad",
        "int c_helper(void) { return 0; }",
        "```",
        "```cpp lotus-code-package=bad",
        "int main() { return 0; }",
        "```",
      ].join("\n"), settings)[0];
      expectCodePackageError(mixed, "all blocks in a code package must use the same language");
    }),
  ];
}

function expectCodePackageError(block: lotusCodeBlock | undefined, expected: string): void {
  if (!block) {
    throw new Error("expected a parsed code package block");
  }
  try {
    assertRunnableCodePackage(block);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes(expected)) {
      return;
    }
    throw new Error(`expected package error containing ${JSON.stringify(expected)}, got ${JSON.stringify(message)}`);
  }
  throw new Error(`expected package error containing ${JSON.stringify(expected)}`);
}

async function runTransportSmoke(): Promise<SmokeBlockResult[]> {
  return [
    await runSyntheticSmoke("transport-http-container-group", async () => {
      const server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        request.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          const parsed = JSON.parse(body) as Record<string, unknown>;
          response.statusCode = 200;
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify({
            stdout: [
              request.url ?? "",
              request.headers["x-lotus-language"] ?? "",
              parsed.language,
              parsed.source,
              parsed.stdin,
              parsed.fileName,
              parsed.command,
            ].join("|"),
            stderr: "",
            exitCode: 0,
            success: true,
          }));
        });
      });
      const port = await listenOnLoopback(server);
      const tempVault = await mkdtemp(join(tmpdir(), "lotus-smoke-http-group-"));
      try {
        const groupDir = join(tempVault, pluginDir, "containers", "http-echo");
        await mkdir(groupDir, { recursive: true });
        await writeFile(join(groupDir, "config.json"), JSON.stringify({
          runtime: "http",
          http: {
            url: `http://127.0.0.1:${port}/run/{languageUri}`,
            method: "POST",
            headers: {
              "X-Lotus-Language": "{language}",
            },
            body: {
              source: "{source}",
              stdin: "{stdin}",
              language: "{language}",
              fileName: "{fileName}",
              command: "{command}",
            },
            successStatus: 200,
            stdoutPath: "stdout",
            stderrPath: "stderr",
            exitCodePath: "exitCode",
            successPath: "success",
          },
          languages: {
            python: {
              command: "python3 {file}",
              extension: ".py",
            },
          },
        }, null, 2), "utf8");

        const runner = new lotusContainerRunner({ containersPath: join(tempVault, pluginDir, "containers") }, smokeRequestUrl);
        const controller = new AbortController();
        const block: lotusCodeBlock = {
          id: "http-smoke",
          ordinal: 1,
          filePath: "HTTP Smoke.md",
          language: "python",
          languageAlias: "python",
          sourceLanguage: "python",
          content: "print('http smoke')",
          attributes: {},
          executionContext: {},
          startLine: 1,
          endLine: 1,
          fenceStart: 1,
          fenceEnd: 3,
        };
        const result = await runner.run(block, {
          file: { path: "HTTP Smoke.md" } as never,
          workingDirectory: tempVault,
          timeoutMs: 5000,
          signal: controller.signal,
          stdin: "stdin-smoke",
        }, settings, "http-echo");
        const expectedPieces = [
          "/run/python",
          "python",
          "python",
          "print('http smoke')",
          "stdin-smoke",
          ".py",
          "python3 {file}",
        ];
        if (!result.success || expectedPieces.some((piece) => !result.stdout.includes(piece))) {
          throw new Error(`HTTP container group smoke failed: stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`);
        }
      } finally {
        await closeServer(server);
        await rm(tempVault, { recursive: true, force: true });
      }
    }),
    await runSyntheticSmoke("transport-stdin-prefix", async () => {
      const controller = new AbortController();
      const expected = "lotus-source-user-input";
      const usesWindowsNodeHelper = process.platform === "win32";
      const result = await runProcess({
        runnerId: "synthetic:transport:stdin-prefix",
        runnerName: "Synthetic stdin prefix",
        executable: usesWindowsNodeHelper ? process.execPath : "cat",
        args: usesWindowsNodeHelper ? [
          "-e",
          [
            "let data = '';",
            "process.stdin.setEncoding('utf8');",
            "process.stdin.on('data', chunk => { data += chunk; });",
            "process.stdin.on('end', () => {",
            `  if (data !== ${JSON.stringify(expected)}) { process.stderr.write('stdin mismatch: ' + JSON.stringify(data)); process.exit(2); }`,
            "  process.stdout.write(data);",
            "});",
            "process.stdin.resume();",
          ].join("\n"),
        ] : [],
        workingDirectory: vaultDir,
        timeoutMs: 5000,
        signal: controller.signal,
        stdinPrefix: "lotus-source-",
        stdin: "user-input",
      });
      if (!result.success || result.stdout !== expected) {
        throw new Error(result.stderr || `stdin prefix smoke failed: ${result.stdout || `exit ${result.exitCode}`}`);
      }
    }),
    await runSyntheticSmoke("transport-display-jsonl", async () => {
      const controller = new AbortController();
      const svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 40 20\"><text x=\"4\" y=\"14\">ok</text></svg>";
      const result = await runProcess({
        runnerId: "synthetic:transport:display-jsonl",
        runnerName: "Synthetic display JSONL",
        executable: process.execPath,
        args: [
          "-e",
          [
            "const fs = require('fs');",
            `const record = ${JSON.stringify({ title: "Synthetic SVG", role: "visualization", data: { "image/svg+xml": svg, "text/plain": "synthetic svg" } })};`,
            "fs.appendFileSync(process.env.LOTUS_DISPLAY_JSONL, JSON.stringify(record) + '\\n', 'utf8');",
            "fs.writeSync(1, 'display-ok');",
          ].join("\n"),
        ],
        workingDirectory: vaultDir,
        timeoutMs: 5000,
        signal: controller.signal,
      });
      const display = result.displays?.[0];
      if (!result.success || result.stdout.trim() !== "display-ok" || display?.data["image/svg+xml"] !== svg) {
        throw new Error(result.stderr || `display JSONL smoke failed: stdout=${JSON.stringify(result.stdout)} displays=${JSON.stringify(result.displays ?? [])}`);
      }
    }),
    await runSyntheticSmoke("source-visualization-llvm-cfg", async () => {
      const block = createSyntheticBlock("llvm-ir", [
        "@ok = private unnamed_addr constant [9 x i8] c\"llvm ok\\0A\\00\"",
        "declare i32 @puts(ptr)",
        "define i32 @main() {",
        "entry:",
        "  %x = add i32 20, 22",
        "  %is_answer = icmp eq i32 %x, 42",
        "  br i1 %is_answer, label %ok_block, label %bad_block",
        "ok_block:",
        "  ret i32 0",
        "bad_block:",
        "  ret i32 1",
        "}",
      ].join("\n"));
      const display = createSourceVisualizationDisplay(block);
      const dot = display.data["text/vnd.graphviz"];
      if (typeof dot !== "string" || !dot.includes("ok_block") || !dot.includes("bad_block") || !dot.includes("then") || !dot.includes("else")) {
        throw new Error(`LLVM CFG visualization smoke failed: ${JSON.stringify(display.data)}`);
      }
      if (createStdoutVisualizationDisplay("llvm ok", "graphviz")) {
        throw new Error("plain stdout was incorrectly accepted as Graphviz DOT");
      }
      if (!createStdoutVisualizationDisplay("digraph g { a -> b; }", "graphviz")) {
        throw new Error("Graphviz stdout was not accepted");
      }
    }),
  ];
}

async function listenOnLoopback(server: ReturnType<typeof createServer>): Promise<number> {
  return await new Promise<number>((resolvePromise, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      const address = server.address();
      if (address && typeof address === "object" && typeof address.port === "number") {
        resolvePromise(address.port);
        return;
      }
      reject(new Error("HTTP smoke server did not expose a port."));
    });
  });
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolvePromise, reject) => {
    server.close((error?: Error) => {
      if (error) {
        reject(error);
        return;
      }
      resolvePromise();
    });
  });
}

function createSyntheticBlock(language: string, content: string): lotusCodeBlock {
  return {
    id: `synthetic:${language}`,
    ordinal: 0,
    filePath: "(synthetic)",
    language,
    languageAlias: language,
    sourceLanguage: language,
    content,
    attributes: {},
    executionContext: {},
    startLine: 0,
    endLine: content.split(/\r?\n/).length + 1,
    fenceStart: 0,
    fenceEnd: 3,
  };
}

async function runSyntheticSmoke(
  name: string,
  callback: () => Promise<void | { skipped: true; reason: string }>,
): Promise<SmokeBlockResult> {
  const started = Date.now();
  try {
    const result = await callback();
    if (result?.skipped) {
      return {
        profile,
        note: "(synthetic)",
        ordinal: 0,
        language: "signing",
        status: "skipped",
        name,
        runnerName: "Signing smoke",
        durationMs: Date.now() - started,
        reason: result.reason,
      };
    }
    return {
      profile,
      note: "(synthetic)",
      ordinal: 0,
      language: "signing",
      status: "passed",
      name,
      runnerName: "Signing smoke",
      durationMs: Date.now() - started,
    };
  } catch (error) {
    return {
      profile,
      note: "(synthetic)",
      ordinal: 0,
      language: "signing",
      status: "failed",
      name,
      runnerName: "Signing smoke",
      durationMs: Date.now() - started,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function classifyResult(
  note: NoteFile,
  block: lotusCodeBlock,
  name: string,
  directives: Set<string>,
  runnerName: string,
  result: lotusRunResult,
  sourcePreview: lotusSourcePreview | undefined,
): Promise<SmokeBlockResult> {
  const base = {
    profile,
    note: note.path,
    ordinal: block.ordinal,
    language: block.language,
    name,
    runnerName,
    durationMs: result.durationMs,
    stdout: result.stdout,
    stderr: result.stderr,
    warning: result.warning,
    sourcePreview: sourcePreview?.content,
  };

  if (directives.has("skip-missing") && isMissingExecutable(result)) {
    return { ...base, status: "skipped", reason: result.stderr.trim() };
  }

  if (directives.has("expect-fail")) {
    return result.success
      ? { ...base, status: "failed", reason: "expected failure but block succeeded" }
      : { ...base, status: "passed" };
  }

  if (!result.success) {
    return { ...base, status: "failed", reason: result.stderr || result.stdout || `exit ${result.exitCode}` };
  }

  const assertionFailure = await checkAssertions(block, result);
  if (assertionFailure) {
    return { ...base, status: "failed", reason: assertionFailure };
  }

  return { ...base, status: "passed" };
}

async function checkAssertions(block: lotusCodeBlock, result: lotusRunResult): Promise<string | null> {
  const exactStdout = block.attributes["lotus-smoke-stdout"];
  if (exactStdout != null && result.stdout.trim() !== exactStdout) {
    return `stdout mismatch: expected ${JSON.stringify(exactStdout)}, got ${JSON.stringify(result.stdout.trim())}`;
  }
  const stdoutContains = block.attributes["lotus-smoke-stdout-contains"];
  if (stdoutContains != null && !result.stdout.includes(stdoutContains)) {
    return `stdout did not contain ${JSON.stringify(stdoutContains)}`;
  }
  const stderrContains = block.attributes["lotus-smoke-stderr-contains"];
  if (stderrContains != null && !result.stderr.includes(stderrContains)) {
    return `stderr did not contain ${JSON.stringify(stderrContains)}`;
  }
  const godboltAssertion = await checkGodboltAssertions(block, result);
  if (godboltAssertion) {
    return godboltAssertion;
  }
  return null;
}

async function checkGodboltAssertions(block: lotusCodeBlock, result: lotusRunResult): Promise<string | null> {
  const expectedCompiler = block.attributes["lotus-smoke-godbolt-compiler"];
  const expectedCompilerPattern = block.attributes["lotus-smoke-godbolt-compiler-matches"];
  const expectedOptions = block.attributes["lotus-smoke-godbolt-options"];
  const expectedFilters = Object.entries(block.attributes)
    .filter(([name]) => name.startsWith("lotus-smoke-godbolt-filter-"))
    .map(([name, value]) => [name.slice("lotus-smoke-godbolt-filter-".length), value] as const);
  if (!expectedCompiler && !expectedCompilerPattern && expectedOptions == null && !expectedFilters.length) {
    return null;
  }

  const url = result.stdout.trim().split(/\s+/)[0];
  if (!/^https?:\/\/\S+/.test(url)) {
    return `godbolt assertion expected url in stdout, got ${JSON.stringify(result.stdout)}`;
  }

  const response = await smokeRequestUrl({
    url,
    method: "GET",
    headers: {
      "Accept": "text/html",
    },
    throw: false,
  });
  if (response.status < 200 || response.status >= 300) {
    return `godbolt expanded link returned HTTP ${response.status}`;
  }

  const compilers = readGodboltCompilerStates(response.text);
  if (!compilers.length) {
    return "godbolt expanded layout did not contain a compiler pane";
  }

  if (expectedCompiler && !compilers.some((compiler) => (compiler.compiler ?? compiler.id) === expectedCompiler)) {
    return `godbolt compiler mismatch: expected ${JSON.stringify(expectedCompiler)}, got ${JSON.stringify(compilers.map((compiler) => compiler.compiler ?? compiler.id))}`;
  }
  if (expectedCompilerPattern) {
    const regex = new RegExp(expectedCompilerPattern);
    if (!compilers.some((compiler) => regex.test(String(compiler.compiler ?? compiler.id ?? "")))) {
      return `godbolt compiler pattern mismatch: expected ${JSON.stringify(expectedCompilerPattern)}, got ${JSON.stringify(compilers.map((compiler) => compiler.compiler ?? compiler.id))}`;
    }
  }
  if (expectedOptions != null && !compilers.some((compiler) => compiler.options === expectedOptions)) {
    return `godbolt options mismatch: expected ${JSON.stringify(expectedOptions)}, got ${JSON.stringify(compilers.map((compiler) => compiler.options ?? ""))}`;
  }
  for (const [filterName, expectedValue] of expectedFilters) {
    const parsedExpected = parseSmokeBoolean(expectedValue);
    if (!compilers.some((compiler) => compiler.filters?.[filterName] === parsedExpected)) {
      return `godbolt filter mismatch for ${filterName}: expected ${JSON.stringify(parsedExpected)}, got ${JSON.stringify(compilers.map((compiler) => compiler.filters?.[filterName]))}`;
    }
  }
  return null;
}

function readGodboltCompilerStates(html: string): SmokeGodboltCompilerState[] {
  const match = html.match(/\bextraOptions="([^"]+)"/);
  if (!match) {
    return [];
  }
  const decoded = decodeURIComponent(decodeHtmlAttribute(match[1]));
  const parsed: unknown = JSON.parse(decoded);
  const config = isRecord(parsed) ? parsed.config : undefined;
  const states: SmokeGodboltCompilerState[] = [];
  collectGodboltCompilerStates(config, states);
  return states;
}

function collectGodboltCompilerStates(value: unknown, states: SmokeGodboltCompilerState[]): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectGodboltCompilerStates(item, states);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  if (value.componentName === "compiler" && isRecord(value.componentState)) {
    states.push(readSmokeGodboltCompilerState(value.componentState));
  }
  for (const child of Object.values(value)) {
    collectGodboltCompilerStates(child, states);
  }
}

function readSmokeGodboltCompilerState(value: Record<string, unknown>): SmokeGodboltCompilerState {
  return {
    compiler: typeof value.compiler === "string" ? value.compiler : undefined,
    id: typeof value.id === "string" ? value.id : undefined,
    options: typeof value.options === "string" ? value.options : undefined,
    filters: isRecord(value.filters) ? value.filters : undefined,
  };
}

function decodeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'")
    .replaceAll("&#x27;", "'")
    .replaceAll("&amp;", "&");
}

function parseSmokeBoolean(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  throw new Error(`Expected boolean smoke value, got ${JSON.stringify(value)}`);
}

async function resolveExecutableBlock(note: NoteFile, block: lotusCodeBlock): Promise<{ block: lotusCodeBlock; sourcePreview?: lotusSourcePreview; preprocessDescription?: string }> {
  assertRunnableCodePackage(block);
  let executableBlock = block;
  let sourcePreview: lotusSourcePreview | undefined;

  if (block.sourceReference) {
    const referencePath = resolveReferencedVaultPath(note.path, block.sourceReference.filePath);
    const source = await readVaultText(referencePath);
    if (source == null) {
      throw new Error(`Referenced source file not found: ${referencePath}`);
    }

    const resolved = await resolveReferencedSource(
      source,
      { ...block.sourceReference, filePath: referencePath },
      block.language,
      buildSourceReferenceHarness(block),
      {
        pythonExecutable: settings.pythonExecutable.trim() || "python3",
        readFile: readVaultHostFile,
        resolvePythonImport,
      },
    );

    const capability = getLanguageCapability(block.language);
    executableBlock = { ...block, content: resolved.content };
    sourcePreview = {
      description: resolved.description,
      language: block.language,
      content: resolved.content,
      capability,
      expanded: true,
      showCapabilityMetadata: true,
    };
  }

  const preprocessor = resolveCustomLanguagePreprocessor(note, executableBlock);
  if (!preprocessor) {
    return { block: executableBlock, sourcePreview };
  }

  const preprocessed = await runExternalSourcePreprocessorPipeline(executableBlock.content, executableBlock, preprocessor);
  const preprocessDescription = `${preprocessed.description || preprocessor.languageName} (artifacts: ${preprocessed.artifactDirectory})`;
  const capability = getLanguageCapability(preprocessed.block.language);
  return {
    block: preprocessed.block,
    sourcePreview: {
      description: sourcePreview
        ? `${sourcePreview.description}; preprocessed by ${preprocessed.description || preprocessor.languageName}`
        : `preprocessed by ${preprocessed.description || preprocessor.languageName}`,
      language: preprocessed.block.language,
      content: preprocessed.block.content,
      capability,
      stages: preprocessed.stages,
      expanded: true,
      showCapabilityMetadata: true,
    },
    preprocessDescription,
  };
}

function resolveCustomLanguagePreprocessor(note: NoteFile, block: lotusCodeBlock) {
  const language = findEnabledCommandLanguage(settings, block.language, block.languageAlias);
  if (!language) {
    return undefined;
  }

  const stages = getPreprocessorStages(language);
  if (!stages.length) {
    return undefined;
  }
  const context = resolveCliExecutionContext(note, block, settings);
  return {
    languageName: language.name,
    initialExtension: language.extension || language.name,
    stages,
    artifactDirectory: join(vaultDir, ".lotus", "preprocess", sanitizeArtifactSegment(note.path), `block-${block.ordinal}-${sanitizeArtifactSegment(block.sourceLanguage || block.language)}`),
    workingDirectory: context.workingDirectory,
    timeoutMs: context.timeoutMs,
  };
}

function getPreprocessorStages(language: NonNullable<ReturnType<typeof findEnabledCommandLanguage>>): lotusExternalSourcePreprocessor[] {
  const stages = (language.preprocessors ?? [])
    .filter((stage) => stage.executable.trim())
    .map((stage, index) => ({
      name: stage.name.trim() || `stage-${index + 1}`,
      executable: stage.executable.trim(),
      args: stage.args || "{request}",
      language: stage.language?.trim(),
      extension: stage.extension?.trim(),
    }));
  if (stages.length) {
    return stages;
  }

  const executable = language.preprocessorExecutable?.trim();
  if (!executable) {
    return [];
  }

  return [{
    name: "preprocess",
    executable,
    args: language.preprocessorArgs || "{request}",
    language: language.preprocessorLanguage?.trim(),
    extension: language.preprocessorExtension?.trim(),
  }];
}

async function loadSettings(vaultPath: string): Promise<lotusPluginSettings> {
  const dataPath = join(vaultPath, pluginDir, "data.json");
  let saved: Partial<lotusPluginSettings> = {};
  try {
    saved = readSettingsJson(await fsReadFile(dataPath, "utf8"));
  } catch {
    saved = {};
  }
  const merged = {
    ...DEFAULT_SETTINGS,
    ...saved,
    enableLocalExecution: true,
    hasAcknowledgedExecutionRisk: true,
    writeOutputToNote: false,
  };
  applySmokeExecutableOverrides(merged);
  applySmokeProfile(merged, profile);
  normalizeLanguageConfiguration(merged);
  return merged;
}

function readSettingsJson(raw: string): Partial<lotusPluginSettings> {
  const parsed: unknown = JSON.parse(raw);
  return isRecord(parsed) ? parsed : {};
}

async function smokeRequestUrl(request: SmokeRequestUrlParam | string): Promise<{ status: number; text: string }> {
  const params = typeof request === "string" ? { url: request } : request;
  const url = new URL(params.url);
  const requester = url.protocol === "http:" ? httpRequest : url.protocol === "https:" ? httpsRequest : null;
  if (!requester) {
    throw new Error(`Unsupported smoke request protocol: ${url.protocol}`);
  }

  const body = typeof params.body === "string"
    ? Buffer.from(params.body, "utf8")
    : params.body
      ? Buffer.from(params.body)
      : undefined;
  const headers: Record<string, string> = {
    ...params.headers,
    ...(params.contentType ? { "Content-Type": params.contentType } : {}),
    ...(body ? { "Content-Length": String(body.length) } : {}),
  };

  return await new Promise((resolvePromise, reject) => {
    const req = requester(url, {
      method: params.method ?? "GET",
      headers,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      response.on("end", () => {
        const status = response.statusCode ?? 0;
        const text = Buffer.concat(chunks).toString("utf8");
        if (params.throw !== false && status >= 400) {
          reject(new Error(`HTTP ${status}: ${text}`));
          return;
        }
        resolvePromise({ status, text });
      });
    });
    req.on("error", reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

function applySmokeExecutableOverrides(settings: lotusPluginSettings): void {
  const pythonExecutable = process.env.LOTUS_SMOKE_PYTHON?.trim();
  if (pythonExecutable) {
    settings.pythonExecutable = pythonExecutable;
  } else if (process.platform === "win32" && settings.pythonExecutable === DEFAULT_SETTINGS.pythonExecutable) {
    settings.pythonExecutable = "python";
  }

  const cExecutable = process.env.LOTUS_SMOKE_C?.trim();
  if (cExecutable) {
    settings.cExecutable = cExecutable;
  } else if (process.platform === "win32" && settings.cExecutable === DEFAULT_SETTINGS.cExecutable) {
    settings.cExecutable = "gcc";
  }

  const cppExecutable = process.env.LOTUS_SMOKE_CPP?.trim();
  if (cppExecutable) {
    settings.cppExecutable = cppExecutable;
  } else if (process.platform === "win32" && settings.cppExecutable === DEFAULT_SETTINGS.cppExecutable) {
    settings.cppExecutable = "g++";
  }
}

function applySmokeProfile(settings: lotusPluginSettings, selectedProfile: SmokeProfile): void {
  const config = smokeProfileConfig(selectedProfile);
  if (!config) {
    return;
  }
  settings.enabledLanguagePacks = config.enabledLanguagePacks;
  settings.enabledLanguages = config.enabledLanguages;
}

function smokeProfileConfig(selectedProfile: SmokeProfile): Pick<lotusPluginSettings, "enabledLanguagePacks" | "enabledLanguages"> | null {
  switch (selectedProfile) {
    case "minimal":
      return {
        enabledLanguagePacks: ["interpreted"],
        enabledLanguages: ["python", "shell"],
      };
    case "systems":
      return {
        enabledLanguagePacks: ["interpreted", "native-compiled"],
        enabledLanguages: ["shell", "c", "cpp"],
      };
    case "proofs":
      return {
        enabledLanguagePacks: ["proofs"],
        enabledLanguages: ["lean", "coq", "smtlib"],
      };
    case "ebpf":
      return {
        enabledLanguagePacks: ["ebpf"],
        enabledLanguages: ["ebpf-c", "bpftrace"],
      };
    case "full":
      return null;
  }
}

function resolveCliExecutionContext(note: NoteFile, block: lotusCodeBlock, pluginSettings: lotusPluginSettings): lotusResolvedExecutionContext {
  const noteContainer = note.frontmatter["lotus-execution"] ?? note.frontmatter["lotus-container"];
  const noteCwd = note.frontmatter["lotus-cwd"] ?? note.frontmatter["lotus-working-directory"];
  const noteTimeout = note.frontmatter["lotus-timeout"] ? parseTimeoutMs(note.frontmatter["lotus-timeout"]) : undefined;
  const blockCwd = block.executionContext.workingDirectory;
  const blockTimeout = block.executionContext.timeoutMs;
  const blockContainer = block.executionContext.disableContainer ? undefined : block.executionContext.containerGroup;
  const globalContainer = pluginSettings.defaultContainerGroup.trim() || undefined;
  const containerGroup = block.executionContext.disableContainer
    ? undefined
    : blockContainer ?? (isDisabledValue(noteContainer) ? undefined : noteContainer) ?? globalContainer;

  const rawWorkingDirectory = blockCwd ?? noteCwd ?? pluginSettings.workingDirectory;
  const workingDirectory = rawWorkingDirectory?.trim()
    ? resolveVaultLocalPath(rawWorkingDirectory.trim())
    : dirname(join(vaultDir, note.path));

  return {
    containerGroup,
    workingDirectory,
    timeoutMs: blockTimeout ?? noteTimeout ?? pluginSettings.defaultTimeoutMs,
    source: {
      container: block.executionContext.disableContainer || blockContainer ? "block" : noteContainer ? "note" : pluginSettings.defaultContainerGroup.trim() ? "global" : "none",
      workingDirectory: blockCwd ? "block" : noteCwd ? "note" : pluginSettings.workingDirectory.trim() ? "global" : "default",
      timeout: blockTimeout !== undefined ? "block" : noteTimeout !== undefined ? "note" : "global",
    },
  };
}

async function readNotes(baseDir: string): Promise<NoteFile[]> {
  const files = await listMarkdownFiles(baseDir);
  return Promise.all(files.map(async (absolutePath) => {
    const source = await fsReadFile(absolutePath, "utf8");
    return {
      absolutePath,
      path: toVaultPath(absolutePath),
      source,
      frontmatter: parseFrontmatter(source),
    };
  }));
}

async function listMarkdownFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === configRootDir || entry.name === ".lotus") {
      continue;
    }
    const absolutePath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listMarkdownFiles(absolutePath));
    } else if (entry.isFile() && extname(entry.name).toLowerCase() === ".md") {
      files.push(absolutePath);
    }
  }
  return files.sort();
}

function parseFrontmatter(source: string): Record<string, string> {
  const lines = source.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    return {};
  }
  const data: Record<string, string> = {};
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "---") {
      break;
    }
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (match) {
      data[match[1].toLowerCase()] = match[2].trim().replace(/^["']|["']$/g, "");
    }
  }
  return data;
}

async function readVaultText(vaultPath: string): Promise<string | null> {
  try {
    return await fsReadFile(join(vaultDir, vaultPath), "utf8");
  } catch {
    return null;
  }
}

async function readVaultHostFile(filePath: string): Promise<string | null> {
  return readVaultText(filePath);
}

async function resolvePythonImport(fromFilePath: string, moduleName: string, level: number): Promise<string | null> {
  const modulePath = moduleName.split(".").map((part) => part.trim()).filter(Boolean).join("/");
  const fromDir = dirname(fromFilePath);
  const baseDirs = level > 0
    ? [ascendVaultPath(fromDir === "." ? "" : fromDir, level - 1)]
    : [fromDir === "." ? "" : fromDir, ""];

  for (const baseDir of baseDirs) {
    const prefix = baseDir ? `${baseDir}/` : "";
    const candidates = modulePath
      ? [`${prefix}${modulePath}.py`, `${prefix}${modulePath}/__init__.py`]
      : [`${prefix}__init__.py`];
    for (const candidate of candidates) {
      if (await vaultFileExists(candidate)) {
        return normalizeVaultPath(candidate);
      }
    }
  }
  return null;
}

async function vaultFileExists(vaultPath: string): Promise<boolean> {
  try {
    await access(join(vaultDir, normalizeVaultPath(vaultPath)), constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveReferencedVaultPath(notePath: string, referencePath: string): string {
  const trimmed = referencePath.trim();
  if (trimmed.startsWith("/")) {
    return normalizeVaultPath(trimmed.slice(1));
  }
  const baseDir = dirname(notePath);
  return normalizeVaultPath(baseDir === "." ? trimmed : `${baseDir}/${trimmed}`);
}

async function resolveBlockStdin(note: NoteFile, block: lotusCodeBlock): Promise<string | undefined> {
  const inline = block.attributes["lotus-stdin"] ?? block.attributes.stdin;
  if (inline != null) {
    return decodeEscapedAttribute(inline);
  }

  const stdinFile = block.attributes["lotus-stdin-file"] ?? block.attributes["stdin-file"];
  if (!stdinFile?.trim()) {
    return undefined;
  }

  const stdinPath = resolveReferencedVaultPath(note.path, stdinFile);
  return fsReadFile(join(vaultDir, stdinPath), "utf8");
}

function decodeEscapedAttribute(value: string): string {
  return value.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
}

function resolveVaultLocalPath(value: string): string {
  const normalized = normalizeVaultPath(value.trim());
  if (normalized === ".") {
    return vaultDir;
  }
  if (isAbsolute(value)) {
    return value;
  }
  return join(vaultDir, normalized);
}

function toVaultPath(absolutePath: string): string {
  return normalizeVaultPath(relative(vaultDir, absolutePath));
}

function normalizeVaultPath(value: string): string {
  return value.split(sep).join("/");
}

function readConfigDir(value: string | undefined): string {
  const fallback = [".", "obsidian"].join("");
  const normalized = normalizeVaultPath((value ?? fallback).trim()).replace(/^\/+|\/+$/g, "");
  return normalized || fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function ascendVaultPath(pathValue: string, levels: number): string {
  let current = pathValue;
  for (let index = 0; index < levels; index += 1) {
    const next = dirname(current);
    current = next === "." ? "" : next;
  }
  return current;
}

function readSmokeDirectives(block: lotusCodeBlock): Set<string> {
  return new Set((block.attributes["lotus-smoke"] || "").split(",").map((value) => value.trim()).filter(Boolean));
}

function shouldRunForProfile(block: lotusCodeBlock, selectedProfile: SmokeProfile): boolean {
  if (selectedProfile === "full") {
    return true;
  }
  const profiles = splitAttributeList(block.attributes["lotus-smoke-profiles"]);
  return profiles.includes(selectedProfile);
}

function splitAttributeList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function isMissingExecutable(result: lotusRunResult): boolean {
  return /Executable not found:/i.test(result.stderr);
}

function isDisabledValue(value: string | undefined): boolean {
  return Boolean(value && ["0", "false", "no", "off", "none", "native"].includes(value.trim().toLowerCase()));
}

function summarize(blocks: SmokeBlockResult[]): Record<string, number> {
  return {
    total: blocks.length,
    passed: blocks.filter((block) => block.status === "passed").length,
    failed: blocks.filter((block) => block.status === "failed").length,
    skipped: blocks.filter((block) => block.status === "skipped").length,
  };
}

function renderMarkdownReport(blocks: SmokeBlockResult[]): string {
  const lines = ["# Lotus Smoke Report", "", `Profile: ${profile}`, `Generated: ${new Date().toISOString()}`, "", "| Status | Note | Lang | Name |", "| --- | --- | --- | --- |"];
  for (const block of blocks) {
    lines.push(`| ${block.status} | ${block.note}#${block.ordinal} | ${block.language} | ${block.name} |`);
    if (block.reason) {
      lines.push("", `Reason: ${block.reason}`, "");
    }
  }
  return `${lines.join("\n")}\n`;
}

function renderHtmlReport(blocks: SmokeBlockResult[]): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Lotus Smoke Report</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 32px; color: #1f2937; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
    th, td { border-bottom: 1px solid #d1d5db; padding: 8px; text-align: left; vertical-align: top; }
    .passed { color: #166534; }
    .failed { color: #991b1b; }
    .skipped { color: #92400e; }
    pre { background: #f3f4f6; padding: 12px; white-space: pre-wrap; border-radius: 6px; }
    section { break-inside: avoid; page-break-inside: avoid; }
  </style>
</head>
<body>
  <h1>Lotus Smoke Report</h1>
  <p>Profile: ${escapeHtml(profile)}</p>
  <p>${escapeHtml(new Date().toISOString())}</p>
  <table>
    <thead><tr><th>Status</th><th>Note</th><th>Language</th><th>Name</th><th>Runner</th><th>Duration</th></tr></thead>
    <tbody>
      ${blocks.map((block) => `<tr>
        <td class="${block.status}">${block.status}</td>
        <td>${escapeHtml(block.note)}#${block.ordinal}</td>
        <td>${escapeHtml(block.language)}</td>
        <td>${escapeHtml(block.name)}</td>
        <td>${escapeHtml(block.runnerName ?? "")}</td>
        <td>${block.durationMs ?? ""} ms</td>
      </tr>`).join("\n")}
    </tbody>
  </table>
  ${blocks.map(renderHtmlBlock).join("\n")}
</body>
</html>`;
}

function renderHtmlBlock(block: SmokeBlockResult): string {
  return `<section>
    <h2 class="${block.status}">${escapeHtml(block.status)} ${escapeHtml(block.name)}</h2>
    ${block.reason ? `<p>${escapeHtml(block.reason)}</p>` : ""}
    ${block.warning ? `<h3>Warning</h3><pre>${escapeHtml(block.warning)}</pre>` : ""}
    ${block.stdout ? `<h3>stdout</h3><pre>${escapeHtml(block.stdout)}</pre>` : ""}
    ${block.stderr ? `<h3>stderr</h3><pre>${escapeHtml(block.stderr)}</pre>` : ""}
    ${block.sourcePreview ? `<h3>extracted source</h3><pre>${escapeHtml(block.sourcePreview)}</pre>` : ""}
  </section>`;
}

async function renderPdfIfPossible(htmlPath: string, pdfPath: string, mustRender: boolean): Promise<void> {
  const configuredChrome = process.env.LOTUS_CHROME_PATH?.trim();
  if (configuredChrome) {
    if (await renderPdfWithCommand(configuredChrome, ["--headless", "--disable-gpu", "--no-sandbox", `--print-to-pdf=${pdfPath}`, pathToFileURL(htmlPath).href], pdfPath, mustRender)) {
      return;
    }
    return;
  }

  const chromium = await findExecutable(["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]);
  if (chromium) {
    if (await renderPdfWithCommand(chromium, ["--headless", "--disable-gpu", "--no-sandbox", `--print-to-pdf=${pdfPath}`, pathToFileURL(htmlPath).href], pdfPath, mustRender)) {
      return;
    }
  }

  const wkhtmltopdf = await findExecutable(["wkhtmltopdf"]);
  if (wkhtmltopdf) {
    if (await renderPdfWithCommand(wkhtmltopdf, [htmlPath, pdfPath], pdfPath, mustRender)) {
      return;
    }
  }

  const message = "No PDF renderer found. Install chromium, google chrome, or wkhtmltopdf to emit report.pdf.";
  await writeFile(join(dirname(pdfPath), "pdf-skipped.txt"), message, "utf8");
  if (mustRender) {
    throw new Error(message);
  }
}

async function renderPdfWithCommand(command: string, commandArgs: string[], pdfPath: string, mustRender: boolean): Promise<boolean> {
  const exitCode = await runCommand(command, commandArgs);
  if (exitCode === 0) {
    return true;
  }

  const message = `PDF export failed with ${command}`;
  if (mustRender) {
    throw new Error(message);
  }
  await writeFile(join(dirname(pdfPath), "pdf-skipped.txt"), message, "utf8");
  return false;
}

async function findExecutable(names: string[]): Promise<string | null> {
  for (const name of names) {
    for (const searchPath of (process.env.PATH ?? "").split(delimiter)) {
      const candidate = join(searchPath, name);
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        continue;
      }
    }
  }
  return null;
}

async function runCommand(command: string, commandArgs: string[]): Promise<number> {
  const child = spawn(command, commandArgs, { stdio: "ignore", shell: command === "command" });
  return await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
}

function readArgs(values: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) {
      continue;
    }
    const [key, inlineValue] = value.slice(2).split("=", 2);
    parsed[key] = inlineValue ?? (values[index + 1]?.startsWith("--") ? "true" : values[++index] ?? "true");
  }
  return parsed;
}

function readProfile(value: string): SmokeProfile {
  if (value === "minimal" || value === "systems" || value === "proofs" || value === "ebpf" || value === "full") {
    return value;
  }
  throw new Error(`Unknown smoke profile ${value}. Use minimal, systems, proofs, ebpf, or full.`);
}

function requiredArg(values: Record<string, string>, key: string): string {
  const value = values[key];
  if (!value) {
    throw new Error(`Missing --${key}`);
  }
  return value;
}

function sanitizeArtifactSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, "-")
    .replace(/^-+|-+$/g, "") || "note";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
