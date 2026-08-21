import { join } from "path";
import { assertRunnableCodePackage, getCodePackageTranslationUnits } from "../codePackage";
import { runProcess, withTempSourceFile, withTempSourceFiles } from "../execution/processRunner";
import { withMinimumTimeout } from "../utils/timeout";
import type { lotusCodeBlock, lotusNormalizedLanguage, lotusPluginSettings, lotusRunContext, lotusRunResult, lotusRunner } from "../types";

interface NativeCompilerRunnerSpec {
  language: lotusNormalizedLanguage;
  displayName: string;
  fileExtension: string;
  executable: (settings: lotusPluginSettings) => string;
}

export abstract class NativeCompilerRunner implements lotusRunner {
  readonly id: string;
  readonly displayName: string;
  readonly languages: readonly lotusNormalizedLanguage[];

  protected constructor(private readonly spec: NativeCompilerRunnerSpec) {
    this.id = "native-compiled";
    this.displayName = "Native compiler";
    this.languages = [spec.language];
  }

  canRun(block: lotusCodeBlock, settings: lotusPluginSettings): boolean {
    return block.language === this.spec.language && Boolean(this.spec.executable(settings).trim());
  }

  run(block: lotusCodeBlock, context: lotusRunContext, settings: lotusPluginSettings): Promise<lotusRunResult> {
    const compileTimeoutMs = withMinimumTimeout(context.timeoutMs, process.platform === "win32" ? 60_000 : 30_000);
    const runTimeoutMs = withMinimumTimeout(context.timeoutMs, 30_000);

    assertRunnableCodePackage(block);
    if (block.codePackage) {
      const translationUnits = getCodePackageTranslationUnits(block);
      return withTempSourceFiles(
        block.codePackage.files.map((file) => ({ path: file.path, source: file.content })),
        async ({ tempDir, files }) => this.compileAndRun(
          context,
          settings,
          tempDir,
          translationUnits.map((file) => files.get(file.path)!),
          ["-I", tempDir],
          compileTimeoutMs,
          runTimeoutMs,
        ),
      );
    }

    return withTempSourceFile(this.spec.fileExtension, block.content, async ({ tempDir, tempFile }) => {
      return this.compileAndRun(context, settings, tempDir, [tempFile], [], compileTimeoutMs, runTimeoutMs);
    });
  }

  private async compileAndRun(
    context: lotusRunContext,
    settings: lotusPluginSettings,
    tempDir: string,
    sourceFiles: string[],
    compileArgs: string[],
    compileTimeoutMs: lotusRunContext["timeoutMs"],
    runTimeoutMs: lotusRunContext["timeoutMs"],
  ): Promise<lotusRunResult> {
    const binaryPath = join(tempDir, process.platform === "win32" ? "snippet.exe" : "snippet.out");
    const compileResult = await runProcess({
      runnerId: `${this.id}:${this.spec.language}:compile`,
      runnerName: this.spec.displayName,
      executable: this.spec.executable(settings).trim(),
      args: [...compileArgs, ...sourceFiles, "-o", binaryPath],
      workingDirectory: context.workingDirectory,
      timeoutMs: compileTimeoutMs,
      signal: context.signal,
    });
    if (!compileResult.success) return compileResult;

    return runProcess({
      runnerId: `${this.id}:${this.spec.language}:run`,
      runnerName: this.spec.displayName,
      executable: binaryPath,
      args: [],
      workingDirectory: context.workingDirectory,
      timeoutMs: runTimeoutMs,
      signal: context.signal,
      stdin: context.stdin,
      stdinSession: context.stdinSession,
      onStdout: context.onStdout,
      onStderr: context.onStderr,
    });
  }
}
