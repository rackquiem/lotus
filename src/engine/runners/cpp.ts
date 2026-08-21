import { NativeCompilerRunner } from "./nativeCompiler";

export class CppRunner extends NativeCompilerRunner {
  constructor() {
    super({ language: "cpp", displayName: "C++ (G++)", fileExtension: ".cpp", executable: (settings) => settings.cppExecutable });
  }
}
