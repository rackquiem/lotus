import { NativeCompilerRunner } from "./nativeCompiler";

export class CRunner extends NativeCompilerRunner {
  constructor() {
    super({ language: "c", displayName: "C (GCC)", fileExtension: ".c", executable: (settings) => settings.cExecutable });
  }
}
