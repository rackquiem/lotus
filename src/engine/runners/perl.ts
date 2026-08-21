import { TempFileRunner } from "./tempFile";

export class PerlRunner extends TempFileRunner {
  constructor() {
    super({ id: "interpreted", displayName: "Interpreted", runnerId: () => "interpreted:perl", runnerName: () => "Perl", language: "perl", executable: (settings) => settings.perlExecutable, fileExtension: ".pl" });
  }
}
