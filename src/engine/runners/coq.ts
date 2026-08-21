import { existsSync } from "fs";
import { join } from "path";
import type { lotusPluginSettings } from "../types";
import { TempFileRunner } from "./tempFile";

export class CoqRunner extends TempFileRunner {
  constructor() {
    super({ id: "proof", displayName: "Proof checker", runnerId: () => "proof:coq", runnerName: () => "Coq", language: "coq", executable: resolveCoqExecutable, fileExtension: ".v", args: () => ["-q", "{file}"], minimumTimeoutMs: 30_000 });
  }
}

function resolveCoqExecutable(settings: lotusPluginSettings): string {
  const configured = settings.coqExecutable.trim();
  if (configured && configured !== "coqc") return configured;
  const opamCoqc = join(process.env.HOME ?? "", ".opam", "default", "bin", "coqc");
  return existsSync(opamCoqc) ? opamCoqc : configured || "coqc";
}
