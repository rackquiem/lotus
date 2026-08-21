import { runProcess, withNamedTempSourceFile } from "../execution/processRunner";
import { withMinimumTimeout } from "../utils/timeout";
import type { lotusCodeBlock, lotusPluginSettings, lotusRunContext, lotusRunResult, lotusRunner } from "../types";

export class JavaRunner implements lotusRunner {
  id = "managed-compiled";
  displayName = "Managed compiler";
  languages = ["java"] as const;

  canRun(block: lotusCodeBlock, settings: lotusPluginSettings): boolean {
    return block.language === "java" && Boolean(settings.javaExecutable.trim());
  }

  run(block: lotusCodeBlock, context: lotusRunContext, settings: lotusPluginSettings): Promise<lotusRunResult> {
    return withNamedTempSourceFile("Main.java", block.content, async ({ tempDir, tempFile }) => {
      if (!settings.javaCompilerExecutable.trim()) {
        return runProcess({
          runnerId: `${this.id}:java:source`,
          runnerName: "Java",
          executable: settings.javaExecutable.trim(),
          args: [tempFile],
          workingDirectory: context.workingDirectory,
          timeoutMs: withMinimumTimeout(context.timeoutMs, 30_000),
          signal: context.signal,
          stdin: context.stdin,
          stdinSession: context.stdinSession,
          onStdout: context.onStdout,
          onStderr: context.onStderr,
        });
      }
      const compileResult = await runProcess({
        runnerId: `${this.id}:java:compile`,
        runnerName: "Java",
        executable: settings.javaCompilerExecutable.trim(),
        args: [tempFile],
        workingDirectory: tempDir,
        timeoutMs: withMinimumTimeout(context.timeoutMs, 30_000),
        signal: context.signal,
      });
      if (!compileResult.success) return compileResult;
      return runProcess({
        runnerId: `${this.id}:java:run`,
        runnerName: "Java",
        executable: settings.javaExecutable.trim(),
        args: ["-cp", tempDir, "Main"],
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
