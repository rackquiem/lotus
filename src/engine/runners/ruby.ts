import { TempFileRunner } from "./tempFile";

export class RubyRunner extends TempFileRunner {
  constructor() {
    super({ id: "interpreted", displayName: "Interpreted", runnerId: () => "interpreted:ruby", runnerName: () => "Ruby", language: "ruby", executable: (settings) => settings.rubyExecutable, fileExtension: ".rb" });
  }
}
