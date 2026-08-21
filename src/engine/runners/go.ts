import { TempFileRunner } from "./tempFile";

export class GoRunner extends TempFileRunner {
  constructor() {
    super({
      id: "interpreted",
      displayName: "Interpreted",
      runnerId: () => "interpreted:go",
      runnerName: () => "Go",
      language: "go",
      executable: (settings) => settings.goExecutable,
      fileExtension: ".go",
      args: () => ["run", "{file}"],
      env: { GOCACHE: "{tempDir}/gocache" },
      minimumTimeoutMs: 30_000,
    });
  }
}
