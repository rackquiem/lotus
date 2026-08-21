import { TempFileRunner } from "./tempFile";

export class SmtlibRunner extends TempFileRunner {
  constructor() {
    super({ id: "proof", displayName: "Proof checker", runnerId: () => "proof:smtlib", runnerName: () => "SMT-LIB (Z3)", language: "smtlib", executable: (settings) => settings.smtExecutable, fileExtension: ".smt2", minimumTimeoutMs: 30_000 });
  }
}
