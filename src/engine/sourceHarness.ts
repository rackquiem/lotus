import type { lotusCodeBlock } from "./types";

export function buildSourceReferenceHarness(block: lotusCodeBlock, inputOverride?: string): string {
  const call = block.sourceReference?.call;
  if (!call) {
    return block.content;
  }

  const symbolName = block.sourceReference?.symbolName?.trim();
  const input = inputOverride ?? block.content.trim();
  const expression = call.expression?.trim()
    ? renderSourceCallTemplate(call.expression, input, symbolName)
    : renderDefaultSourceCall(symbolName, call.args, input);

  return renderLanguageCallHarness(block.language, expression, call.print);
}

function renderDefaultSourceCall(symbolName: string | undefined, args: string | undefined, input: string): string {
  if (!symbolName) {
    throw new Error("lotus-call needs lotus-symbol when no call expression is provided.");
  }

  const renderedArgs = renderSourceCallTemplate(args?.trim() || "{input}", input, symbolName);
  return `${symbolName}(${renderedArgs})`;
}

function renderSourceCallTemplate(template: string, input: string, symbolName: string | undefined): string {
  return template
    .replaceAll("{input}", input)
    .replaceAll("{symbol}", symbolName ?? "");
}

function renderLanguageCallHarness(language: string, expression: string, print: boolean): string {
  if (!print) {
    return renderExpressionStatement(language, expression);
  }

  switch (language) {
    case "python":
      return `print(${expression})`;
    case "javascript":
    case "obsidian-js":
    case "typescript":
      return `console.log(${expression});`;
    case "c":
      return `#include <stdio.h>\nint main(void) { printf("%d\\n", ${expression}); return 0; }`;
    case "cpp":
      return `#include <iostream>\nint main() { std::cout << (${expression}) << "\\n"; return 0; }`;
    case "ocaml":
      return `let () = print_endline (${expression})`;
    default:
      throw new Error(`lotus-call cannot generate a printed harness for ${language}. Use lotus-print=false or write the harness in the block body.`);
  }
}

function renderExpressionStatement(language: string, expression: string): string {
  switch (language) {
    case "python":
    case "ocaml":
      return expression;
    default:
      return expression.endsWith(";") ? expression : `${expression};`;
  }
}
