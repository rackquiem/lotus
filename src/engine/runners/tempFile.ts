import { runTempFileProcess } from "../execution/processRunner";
import { withMinimumTimeout } from "../utils/timeout";
import type { lotusCodeBlock, lotusNormalizedLanguage, lotusPluginSettings, lotusRunContext, lotusRunResult, lotusRunner } from "../types";

export interface TempFileRunnerSpec {
  id: string;
  displayName: string;
  language: lotusNormalizedLanguage;
  executable: (settings: lotusPluginSettings) => string;
  fileExtension: string;
  args?: (settings: lotusPluginSettings) => string[];
  env?: NodeJS.ProcessEnv;
  minimumTimeoutMs?: number;
  runnerId?: (settings: lotusPluginSettings) => string;
  runnerName?: (settings: lotusPluginSettings) => string;
}

export abstract class TempFileRunner implements lotusRunner {
  readonly id: string;
  readonly displayName: string;
  readonly languages: readonly lotusNormalizedLanguage[];

  protected constructor(private readonly spec: TempFileRunnerSpec) {
    this.id = spec.id;
    this.displayName = spec.displayName;
    this.languages = [spec.language];
  }

  canRun(block: lotusCodeBlock, settings: lotusPluginSettings): boolean {
    return block.language === this.spec.language && Boolean(this.spec.executable(settings).trim());
  }

  run(block: lotusCodeBlock, context: lotusRunContext, settings: lotusPluginSettings): Promise<lotusRunResult> {
    return runTempFileProcess({
      runnerId: this.spec.runnerId?.(settings) ?? this.id,
      runnerName: this.spec.runnerName?.(settings) ?? this.displayName,
      executable: this.spec.executable(settings).trim(),
      args: this.spec.args?.(settings) ?? ["{file}"],
      fileExtension: this.spec.fileExtension,
      source: block.content,
      workingDirectory: context.workingDirectory,
      timeoutMs: withMinimumTimeout(context.timeoutMs, this.spec.minimumTimeoutMs ?? 0),
      signal: context.signal,
      stdin: context.stdin,
      stdinSession: context.stdinSession,
      onStdout: context.onStdout,
      onStderr: context.onStderr,
      env: this.spec.env,
    });
  }
}
