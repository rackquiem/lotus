import { join } from "path";
import { runProcess, withTempSourceFile } from "../execution/processRunner";
import { splitCommandLine } from "../utils/command";
import { withMinimumTimeout } from "../utils/timeout";
import type { lotusCodeBlock, lotusPluginSettings, lotusRunContext, lotusRunResult, lotusRunner } from "../types";
import { appendLine, appendSection, readListAttribute, readStringAttribute, splitCsv } from "./ebpfUtils";

export class EbpfCRunner implements lotusRunner {
  id = "ebpf";
  displayName = "eBPF";
  languages = ["ebpf-c"] as const;

  canRun(block: lotusCodeBlock, settings: lotusPluginSettings): boolean {
    return block.language === "ebpf-c" && Boolean(settings.ebpfClangExecutable.trim());
  }

  run(block: lotusCodeBlock, context: lotusRunContext, settings: lotusPluginSettings): Promise<lotusRunResult> {
    const mode = readEbpfCMode(block);
    const cflags = readListAttribute(block, "lotus-ebpf-cflags", "ebpf-cflags").flatMap(splitCommandLine);
    const includePaths = [...splitCsv(settings.ebpfIncludePaths), ...readListAttribute(block, "lotus-ebpf-includes", "ebpf-includes")];

    return withTempSourceFile(".bpf.c", block.content, async ({ tempDir, tempFile }) => {
      const objectPath = join(tempDir, "snippet.bpf.o");
      const compileResult = await runProcess({
        runnerId: `${this.id}:clang`, runnerName: "eBPF clang", executable: settings.ebpfClangExecutable.trim(),
        args: ["-target", "bpf", "-O2", "-g", "-Wall", ...includePaths.flatMap((path) => ["-I", path]), ...cflags, "-c", tempFile, "-o", objectPath],
        workingDirectory: context.workingDirectory, timeoutMs: withMinimumTimeout(context.timeoutMs, 30_000), signal: context.signal,
      });
      if (!compileResult.success) return compileResult;
      compileResult.stdout = appendSection(compileResult.stdout, "Compile", `eBPF object compiled successfully: ${objectPath}`);
      await this.appendObjectInspection(compileResult, objectPath, context, settings);
      return mode === "compile" ? compileResult : this.loadObject(block, objectPath, context, settings, compileResult);
    });
  }

  private async appendObjectInspection(result: lotusRunResult, objectPath: string, context: lotusRunContext, settings: lotusPluginSettings): Promise<void> {
    const executable = settings.ebpfLlvmObjdumpExecutable.trim();
    if (!executable) {
      result.warning = appendLine(result.warning, "eBPF object inspection skipped because no object inspector is configured.");
      return;
    }
    const inspect = await runProcess({ runnerId: `${this.id}:objdump`, runnerName: "eBPF object inspection", executable, args: ["-h", objectPath], workingDirectory: context.workingDirectory, timeoutMs: withMinimumTimeout(context.timeoutMs, 30_000), signal: context.signal });
    if (inspect.success) result.stdout = appendSection(result.stdout, "Object sections", inspect.stdout.trim() || "(no sections reported)");
    else result.warning = appendLine(result.warning, `eBPF object inspection failed: ${inspect.stderr || inspect.stdout || `exit ${inspect.exitCode}`}`);
  }

  private async loadObject(block: lotusCodeBlock, objectPath: string, context: lotusRunContext, settings: lotusPluginSettings, compileResult: lotusRunResult): Promise<lotusRunResult> {
    if (!settings.ebpfAllowKernelLoad) return { ...compileResult, success: false, exitCode: -1, stderr: appendLine(compileResult.stderr, "eBPF kernel loading is disabled. Enable Allow eBPF kernel load in settings before using lotus-ebpf-mode=load.") };
    const pinPath = readStringAttribute(block, "lotus-ebpf-pin", "ebpf-pin");
    if (!pinPath) return { ...compileResult, success: false, exitCode: -1, stderr: appendLine(compileResult.stderr, "lotus-ebpf-mode=load requires lotus-ebpf-pin=/sys/fs/bpf/<path>.") };
    const load = await runProcess({ runnerId: `${this.id}:bpftool:load`, runnerName: "bpftool eBPF load", executable: settings.ebpfBpftoolExecutable.trim() || "bpftool", args: ["-d", "prog", "loadall", objectPath, pinPath], workingDirectory: context.workingDirectory, timeoutMs: withMinimumTimeout(context.timeoutMs, 30_000), signal: context.signal });
    load.stdout = appendSection(compileResult.stdout, "bpftool stdout", load.stdout.trim());
    load.stderr = appendSection(compileResult.stderr, "bpftool stderr", load.stderr.trim());
    load.warning = appendLine(compileResult.warning, `eBPF object load requested with pin path ${pinPath}.`);
    return load;
  }
}

function readEbpfCMode(block: lotusCodeBlock): "compile" | "load" {
  const value = readStringAttribute(block, "lotus-ebpf-mode", "ebpf-mode") || "compile";
  if (value === "compile" || value === "load") return value;
  throw new Error(`Unsupported eBPF mode: ${value}. Use compile or load.`);
}
