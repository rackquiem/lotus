import { runTempFileProcess } from "../execution/processRunner";
import type { lotusCodeBlock, lotusPluginSettings, lotusRunContext, lotusRunResult, lotusRunner } from "../types";

export class PythonRunner implements lotusRunner {
  id = "python";
  displayName = "Python";
  languages = ["python"] as const;

  canRun(block: lotusCodeBlock, settings: lotusPluginSettings): boolean {
    return block.language === "python" && Boolean(settings.pythonExecutable.trim());
  }

  run(block: lotusCodeBlock, context: lotusRunContext, settings: lotusPluginSettings): Promise<lotusRunResult> {
    return runTempFileProcess({
      runnerId: this.id,
      runnerName: this.displayName,
      executable: settings.pythonExecutable.trim(),
      args: ["{file}"],
      fileExtension: ".py",
      source: block.content,
      workingDirectory: context.workingDirectory,
      timeoutMs: context.timeoutMs,
      signal: context.signal,
      stdin: context.stdin,
      stdinSession: context.stdinSession,
      onStdout: context.onStdout,
      onStderr: context.onStderr,
    });
  }
}
