import { TempFileRunner } from "./tempFile";

export class ShellRunner extends TempFileRunner {
  constructor() {
    super({ id: "interpreted", displayName: "Interpreted", runnerId: () => "interpreted:shell", runnerName: () => "Shell", language: "shell", executable: (settings) => settings.shellExecutable, fileExtension: ".sh" });
  }
}
