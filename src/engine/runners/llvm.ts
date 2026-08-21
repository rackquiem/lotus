import { runTempFileProcess } from "../execution/processRunner";
import { withMinimumTimeout } from "../utils/timeout";
import type { lotusCodeBlock, lotusPluginSettings, lotusRunContext, lotusRunResult, lotusRunner } from "../types";

export class LlvmRunner implements lotusRunner {
  id = "llvm-ir";
  displayName = "LLVM IR";
  languages = ["llvm-ir"] as const;

  canRun(block: lotusCodeBlock, settings: lotusPluginSettings): boolean {
    return block.language === "llvm-ir" && Boolean(settings.llvmInterpreterExecutable.trim());
  }

  async run(block: lotusCodeBlock, context: lotusRunContext, settings: lotusPluginSettings): Promise<lotusRunResult> {
    const result = await runTempFileProcess({
      runnerId: this.id,
      runnerName: this.displayName,
      executable: settings.llvmInterpreterExecutable.trim(),
      args: ["{file}"],
      fileExtension: ".ll",
      source: block.content,
      workingDirectory: context.workingDirectory,
      timeoutMs: withMinimumTimeout(context.timeoutMs, 30_000),
      signal: context.signal,
      stdin: context.stdin,
      stdinSession: context.stdinSession,
      onStdout: context.onStdout,
      onStderr: context.onStderr,
    });

    if (!result.timedOut && !result.cancelled && result.exitCode != null && !result.stderr.trim()) {
      if (result.exitCode !== 0) {
        result.success = true;
        result.warning = `Program returned i32 ${result.exitCode}. Under lli, that becomes the process exit status.`;
      }

      if (!result.stdout.trim()) {
        result.stdout = result.exitCode === 0
          ? "LLVM program exited with code 0."
          : `LLVM program returned i32 ${result.exitCode}.\nUse stdout in the IR itself if you want printable program output.`;
      }
    }

    return result;
  }
}
