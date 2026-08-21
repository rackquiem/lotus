import { join } from "path";
import { runProcess, withTempSourceFile } from "../execution/processRunner";
import { withMinimumTimeout } from "../utils/timeout";
import type { lotusCodeBlock, lotusPluginSettings, lotusRunContext, lotusRunResult, lotusRunner } from "../types";

export class RustRunner implements lotusRunner {
  id = "managed-compiled";
  displayName = "Managed compiler";
  languages = ["rust"] as const;

  canRun(block: lotusCodeBlock, settings: lotusPluginSettings): boolean {
    return block.language === "rust" && Boolean(settings.rustExecutable.trim());
  }

  run(block: lotusCodeBlock, context: lotusRunContext, settings: lotusPluginSettings): Promise<lotusRunResult> {
    return withTempSourceFile(".rs", block.content, async ({ tempDir, tempFile }) => {
      const binaryPath = join(tempDir, "snippet.out");
      const compileResult = await runProcess({
        runnerId: `${this.id}:rust:compile`,
        runnerName: "Rust",
        executable: settings.rustExecutable.trim(),
        args: [tempFile, "-o", binaryPath],
        workingDirectory: context.workingDirectory,
        timeoutMs: withMinimumTimeout(context.timeoutMs, 30_000),
        signal: context.signal,
      });
      if (!compileResult.success) return compileResult;
      return runProcess({
        runnerId: `${this.id}:rust:run`,
        runnerName: "Rust",
        executable: binaryPath,
        args: [],
        workingDirectory: context.workingDirectory,
        timeoutMs: withMinimumTimeout(context.timeoutMs, 30_000),
        signal: context.signal,
        stdin: context.stdin,
        stdinSession: context.stdinSession,
        onStdout: context.onStdout,
        onStderr: context.onStderr,
      });
    });
  }
}
