import { runProcess, withTempSourceFile } from "../execution/processRunner";
import { splitCommandLine } from "../utils/command";
import { withMinimumTimeout } from "../utils/timeout";
import type { lotusCodeBlock, lotusPluginSettings, lotusRunContext, lotusRunResult, lotusRunner } from "../types";
import { readListAttribute, readStringAttribute } from "./ebpfUtils";

export class BpftraceRunner implements lotusRunner {
  id = "ebpf";
  displayName = "eBPF";
  languages = ["bpftrace"] as const;

  canRun(block: lotusCodeBlock, settings: lotusPluginSettings): boolean {
    return block.language === "bpftrace" && Boolean(settings.bpftraceExecutable.trim());
  }

  run(block: lotusCodeBlock, context: lotusRunContext, settings: lotusPluginSettings): Promise<lotusRunResult> {
    const mode = readBpftraceMode(block);
    const extraArgs = readListAttribute(block, "lotus-bpftrace-args", "bpftrace-args").flatMap(splitCommandLine);
    const executable = settings.bpftraceExecutable.trim();
    return withTempSourceFile(".bt", block.content, async ({ tempFile }) => {
      if (mode === "run") return runProcess({
        runnerId: `${this.id}:bpftrace:${mode}`, runnerName: "bpftrace", executable, args: [...extraArgs, tempFile],
        workingDirectory: context.workingDirectory, timeoutMs: withMinimumTimeout(context.timeoutMs, 30_000), signal: context.signal,
        stdin: context.stdin, stdinSession: context.stdinSession, onStdout: context.onStdout, onStderr: context.onStderr,
      });
      const result = await runProcess({ runnerId: `${this.id}:bpftrace:${mode}`, runnerName: "bpftrace check", executable, args: ["--dry-run", ...extraArgs, tempFile], workingDirectory: context.workingDirectory, timeoutMs: withMinimumTimeout(context.timeoutMs, 30_000), signal: context.signal });
      if (!result.success && isUnsupportedDryRun(result)) return runProcess({ runnerId: `${this.id}:bpftrace:${mode}:legacy-debug`, runnerName: "bpftrace check", executable, args: ["-d", ...extraArgs, tempFile], workingDirectory: context.workingDirectory, timeoutMs: withMinimumTimeout(context.timeoutMs, 30_000), signal: context.signal });
      return result;
    });
  }
}

function readBpftraceMode(block: lotusCodeBlock): "check" | "run" {
  const value = readStringAttribute(block, "lotus-bpftrace-mode", "bpftrace-mode") || "check";
  if (value === "check" || value === "run") return value;
  throw new Error(`Unsupported bpftrace mode: ${value}. Use check or run.`);
}

function isUnsupportedDryRun(result: lotusRunResult): boolean {
  const output = `${result.stderr}\n${result.stdout}`.toLowerCase();
  return output.includes("--dry-run") && (output.includes("unrecognized option") || output.includes("unknown option") || output.includes("invalid option")) || output.includes("usage:") && !output.includes("--dry-run");
}
