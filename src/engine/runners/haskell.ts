import { TempFileRunner } from "./tempFile";

export class HaskellRunner extends TempFileRunner {
  constructor() {
    super({ id: "interpreted", displayName: "Interpreted", runnerId: () => "interpreted:haskell", runnerName: () => "Haskell", language: "haskell", executable: (settings) => settings.haskellExecutable, fileExtension: ".hs", minimumTimeoutMs: 30_000 });
  }
}
