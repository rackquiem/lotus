import { TempFileRunner } from "./tempFile";

export class PhpRunner extends TempFileRunner {
  constructor() {
    super({ id: "interpreted", displayName: "Interpreted", runnerId: () => "interpreted:php", runnerName: () => "PHP", language: "php", executable: (settings) => settings.phpExecutable, fileExtension: ".php" });
  }
}
