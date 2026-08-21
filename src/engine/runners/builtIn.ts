import type { lotusRunner } from "../types";
import { BpftraceRunner } from "./bpftrace";
import { CoqRunner } from "./coq";
import { CRunner } from "./c";
import { CppRunner } from "./cpp";
import { EbpfCRunner } from "./ebpfC";
import { GoRunner } from "./go";
import { HaskellRunner } from "./haskell";
import { JavaRunner } from "./java";
import { JavaScriptRunner } from "./javascript";
import { LeanRunner } from "./lean";
import { LlvmRunner } from "./llvm";
import { LuaRunner } from "./lua";
import { OcamlRunner } from "./ocaml";
import { PerlRunner } from "./perl";
import { PhpRunner } from "./php";
import { PythonRunner } from "./python";
import { RubyRunner } from "./ruby";
import { RustRunner } from "./rust";
import { ShellRunner } from "./shell";
import { SmtlibRunner } from "./smtlib";
import { TypeScriptRunner } from "./typescript";

export function createBuiltInRunners(): lotusRunner[] {
  return [
    new PythonRunner(),
    new JavaScriptRunner(),
    new TypeScriptRunner(),
    new OcamlRunner(),
    new CRunner(),
    new CppRunner(),
    new ShellRunner(),
    new RubyRunner(),
    new PerlRunner(),
    new LuaRunner(),
    new PhpRunner(),
    new GoRunner(),
    new HaskellRunner(),
    new RustRunner(),
    new JavaRunner(),
    new EbpfCRunner(),
    new BpftraceRunner(),
    new LlvmRunner(),
    new LeanRunner(),
    new CoqRunner(),
    new SmtlibRunner(),
  ];
}
