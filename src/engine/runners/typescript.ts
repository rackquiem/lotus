import { TempFileRunner } from "./tempFile";

export class TypeScriptRunner extends TempFileRunner {
  constructor() {
    super({
      id: "node",
      displayName: "Node.js",
      language: "typescript",
      executable: (settings) => settings.typescriptTranspilerExecutable,
      fileExtension: ".ts",
      runnerId: (settings) => `node:${settings.typescriptMode}`,
      runnerName: (settings) => settings.typescriptMode === "tsx" ? "TypeScript (tsx)" : "TypeScript (ts-node)",
    });
  }
}
