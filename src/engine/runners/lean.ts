import { TempFileRunner } from "./tempFile";

export class LeanRunner extends TempFileRunner {
  constructor() {
    super({ id: "proof", displayName: "Proof checker", runnerId: () => "proof:lean", runnerName: () => "Lean", language: "lean", executable: (settings) => settings.leanExecutable, fileExtension: ".lean", minimumTimeoutMs: 30_000 });
  }
}
