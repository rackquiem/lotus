import { Decoration, type EditorView } from "@codemirror/view";
import type { RangeSetBuilder } from "@codemirror/state";
import type { lotusCodeBlock } from "../engine/types";

interface LlvmToken {
  from: number;
  to: number;
  className: string;
}

const LLVM_KEYWORDS = new Map<string, string>([
  ...mapWords("lotus-llvm-keyword-control", [
    "ret", "br", "switch", "indirectbr", "invoke", "callbr", "resume", "unreachable", "cleanupret", "catchret", "catchswitch",
  ]),
  ...mapWords("lotus-llvm-keyword-declaration", [
    "define", "declare", "type", "global", "constant", "alias", "ifunc", "comdat", "attributes", "section", "gc", "prefix", "prologue",
    "personality", "uselistorder", "uselistorder_bb", "module", "asm", "source_filename", "target",
  ]),
  ...mapWords("lotus-llvm-keyword-memory", [
    "alloca", "load", "store", "getelementptr", "fence", "cmpxchg", "atomicrmw", "extractvalue", "insertvalue", "extractelement",
    "insertelement", "shufflevector",
  ]),
  ...mapWords("lotus-llvm-keyword-arithmetic", [
    "add", "sub", "mul", "udiv", "sdiv", "urem", "srem", "shl", "lshr", "ashr", "and", "or", "xor", "fneg", "fadd", "fsub", "fmul",
    "fdiv", "frem",
  ]),
  ...mapWords("lotus-llvm-keyword-comparison", ["icmp", "fcmp"]),
  ...mapWords("lotus-llvm-keyword-cast", [
    "trunc", "zext", "sext", "fptrunc", "fpext", "fptoui", "fptosi", "uitofp", "sitofp", "ptrtoint", "inttoptr", "bitcast", "addrspacecast",
  ]),
  ...mapWords("lotus-llvm-keyword-other", ["phi", "select", "freeze", "call", "landingpad", "catchpad", "cleanuppad", "va_arg"]),
  ...mapWords("lotus-llvm-keyword-modifier", [
    "private", "internal", "available_externally", "linkonce", "weak", "common", "appending", "extern_weak", "linkonce_odr", "weak_odr",
    "external", "default", "hidden", "protected", "dllimport", "dllexport", "dso_local", "dso_preemptable", "externally_initialized",
    "thread_local", "localdynamic", "initialexec", "localexec", "unnamed_addr", "local_unnamed_addr", "atomic", "unordered", "monotonic",
    "acquire", "release", "acq_rel", "seq_cst", "syncscope", "volatile", "singlethread", "ccc", "fastcc", "coldcc", "webkit_jscc",
    "anyregcc", "preserve_mostcc", "preserve_allcc", "cxx_fast_tlscc", "swiftcc", "tailcc", "cfguard_checkcc", "tail", "musttail", "notail",
    "fast", "nnan", "ninf", "nsz", "arcp", "contract", "afn", "reassoc", "nuw", "nsw", "exact", "inbounds", "to", "x",
  ]),
  ...mapWords("lotus-llvm-predicate", [
    "eq", "ne", "ugt", "uge", "ult", "ule", "sgt", "sge", "slt", "sle", "oeq", "ogt", "oge", "olt", "ole", "one", "ord", "ueq", "une",
    "uno",
  ]),
  ...mapWords("lotus-llvm-attribute", [
    "alwaysinline", "argmemonly", "builtin", "byref", "byval", "cold", "convergent", "dereferenceable", "dereferenceable_or_null", "distinct",
    "immarg", "inalloca", "inreg", "mustprogress", "nest", "noalias", "nocallback", "nocapture", "nofree", "noinline", "nonlazybind",
    "nonnull", "norecurse", "noredzone", "noreturn", "nosync", "nounwind", "null_pointer_is_valid", "opaque", "optnone", "optsize",
    "preallocated", "readnone", "readonly", "returned", "returns_twice", "sanitize_address", "sanitize_hwaddress", "sanitize_memory",
    "sanitize_thread", "signext", "speculatable", "sret", "ssp", "sspreq", "sspstrong", "swiftasync", "swiftself", "swifterror", "uwtable",
    "willreturn", "writeonly", "zeroext",
  ]),
  ...mapWords("lotus-llvm-constant", ["true", "false", "null", "none", "undef", "poison", "zeroinitializer"]),
]);

const LLVM_PRIMITIVE_TYPES = new Set([
  "void", "label", "token", "metadata", "x86_mmx", "x86_amx", "half", "bfloat", "float", "double", "fp128", "x86_fp80", "ppc_fp128", "ptr",
]);

const PUNCTUATION_CLASS = "lotus-llvm-punctuation";

export function highlightLlvmElement(codeElement: HTMLElement, source: string): void {
  codeElement.empty();
  codeElement.addClass("lotus-llvm-code");

  const lines = source.split("\n");
  lines.forEach((line, index) => {
    appendHighlightedLine(codeElement, line);
    if (index < lines.length - 1) {
      codeElement.appendText("\n");
    }
  });
}

export function addLlvmDecorations(
  builder: RangeSetBuilder<Decoration>,
  view: EditorView,
  block: lotusCodeBlock,
): void {
  const contentLineCount = getContentLineCount(block);
  if (!contentLineCount) {
    return;
  }

  const lines = block.content.split("\n");
  for (let index = 0; index < contentLineCount; index += 1) {
    const line = lines[index] ?? "";
    const tokens = tokenizeLlvmLine(line);
    if (!tokens.length) {
      continue;
    }

    const docLine = view.state.doc.line(block.startLine + 2 + index);
    for (const token of tokens) {
      if (token.from === token.to) {
        continue;
      }
      builder.add(
        docLine.from + token.from,
        docLine.from + token.to,
        Decoration.mark({ class: token.className }),
      );
    }
  }
}

function appendHighlightedLine(container: HTMLElement, line: string): void {
  let cursor = 0;

  for (const token of tokenizeLlvmLine(line)) {
    if (token.from > cursor) {
      container.appendText(line.slice(cursor, token.from));
    }

    const span = container.createSpan({ cls: token.className });
    span.setText(line.slice(token.from, token.to));
    cursor = token.to;
  }

  if (cursor < line.length) {
    container.appendText(line.slice(cursor));
  }
}

function tokenizeLlvmLine(line: string): LlvmToken[] {
  const tokens: LlvmToken[] = [];
  let index = 0;

  addLabelToken(line, tokens);

  while (index < line.length) {
    const current = line[index];
    if (current === ";") {
      tokens.push({ from: index, to: line.length, className: "lotus-llvm-comment" });
      break;
    }

    if (/\s/.test(current)) {
      index += 1;
      continue;
    }

    const stringToken = readStringToken(line, index);
    if (stringToken) {
      if (stringToken.prefixEnd > index) {
        tokens.push({ from: index, to: stringToken.prefixEnd, className: "lotus-llvm-string-prefix" });
      }
      tokens.push({ from: stringToken.valueStart, to: stringToken.valueEnd, className: "lotus-llvm-string" });
      index = stringToken.valueEnd;
      continue;
    }

    const matched =
      matchRegexToken(line, index, /@llvm\.[A-Za-z$._0-9]+/y, "lotus-llvm-intrinsic", tokens) ||
      matchRegexToken(line, index, /@[A-Za-z$._-][A-Za-z$._0-9-]*|@\d+\b/y, "lotus-llvm-global", tokens) ||
      matchRegexToken(line, index, /%[A-Za-z$._-][A-Za-z$._0-9-]*|%\d+\b/y, "lotus-llvm-local", tokens) ||
      matchRegexToken(line, index, /![A-Za-z$._-][A-Za-z$._0-9-]*|!\d+\b/y, "lotus-llvm-metadata", tokens) ||
      matchRegexToken(line, index, /\$[A-Za-z$._-][A-Za-z$._0-9-]*/y, "lotus-llvm-comdat", tokens) ||
      matchRegexToken(line, index, /#\d+\b/y, "lotus-llvm-attribute-group", tokens) ||
      matchRegexToken(line, index, /\baddrspace\s*\(\s*\d+\s*\)/y, "lotus-llvm-type", tokens) ||
      matchRegexToken(line, index, /[-+]?0x[0-9A-Fa-f]+\b/y, "lotus-llvm-number", tokens) ||
      matchRegexToken(line, index, /[-+]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][-+]?\d+)\b/y, "lotus-llvm-number", tokens) ||
      matchRegexToken(line, index, /[-+]?(?:\d+\.\d*|\.\d+)\b/y, "lotus-llvm-number", tokens) ||
      matchRegexToken(line, index, /[-+]?\d+\b/y, "lotus-llvm-number", tokens) ||
      matchRegexToken(line, index, /\.\.\./y, "lotus-llvm-punctuation", tokens);

    if (matched) {
      index = matched;
      continue;
    }

    const word = readWord(line, index);
    if (word) {
      tokens.push({
        from: index,
        to: word.end,
        className: classifyWord(word.value),
      });
      index = word.end;
      continue;
    }

    if ("()[]{}<>,:=*".includes(current)) {
      tokens.push({ from: index, to: index + 1, className: PUNCTUATION_CLASS });
      index += 1;
      continue;
    }

    index += 1;
  }

  return normalizeTokens(tokens);
}

function addLabelToken(line: string, tokens: LlvmToken[]): void {
  const match = line.match(/^(\s*)(?:([A-Za-z$._-][A-Za-z$._0-9-]*|\d+)|(%[A-Za-z$._-][A-Za-z$._0-9-]*|%\d+))(:)/);
  if (!match || match.index == null) {
    return;
  }

  const labelStart = match[1].length;
  const labelText = match[2] ?? match[3];
  if (!labelText) {
    return;
  }

  tokens.push({
    from: labelStart,
    to: labelStart + labelText.length,
    className: "lotus-llvm-label",
  });
  tokens.push({
    from: labelStart + labelText.length,
    to: labelStart + labelText.length + 1,
    className: PUNCTUATION_CLASS,
  });
}

function classifyWord(word: string): string {
  if (/^i\d+$/.test(word) || LLVM_PRIMITIVE_TYPES.has(word)) {
    return "lotus-llvm-type";
  }

  return LLVM_KEYWORDS.get(word) ?? "lotus-llvm-plain";
}

function readWord(line: string, index: number): { value: string; end: number } | null {
  const match = /[A-Za-z_][A-Za-z0-9_.-]*/y;
  match.lastIndex = index;
  const result = match.exec(line);
  if (!result) {
    return null;
  }

  return {
    value: result[0],
    end: match.lastIndex,
  };
}

function readStringToken(line: string, index: number): { prefixEnd: number; valueStart: number; valueEnd: number } | null {
  let cursor = index;
  if (line[cursor] === "c" && line[cursor + 1] === "\"") {
    cursor += 1;
  }

  if (line[cursor] !== "\"") {
    return null;
  }

  const valueStart = cursor;
  cursor += 1;
  while (cursor < line.length) {
    if (line[cursor] === "\\") {
      cursor += 2;
      continue;
    }
    if (line[cursor] === "\"") {
      cursor += 1;
      break;
    }
    cursor += 1;
  }

  return {
    prefixEnd: valueStart,
    valueStart,
    valueEnd: cursor,
  };
}

function matchRegexToken(
  line: string,
  index: number,
  regex: RegExp,
  className: string,
  tokens: LlvmToken[],
): number | null {
  regex.lastIndex = index;
  const match = regex.exec(line);
  if (!match) {
    return null;
  }

  tokens.push({ from: index, to: regex.lastIndex, className });
  return regex.lastIndex;
}

function normalizeTokens(tokens: LlvmToken[]): LlvmToken[] {
  tokens.sort((left, right) => left.from - right.from || left.to - right.to);
  const normalized: LlvmToken[] = [];
  let cursor = 0;

  for (const token of tokens) {
    if (token.to <= cursor) {
      continue;
    }

    const from = Math.max(token.from, cursor);
    normalized.push({ ...token, from });
    cursor = token.to;
  }

  return normalized;
}

function getContentLineCount(block: lotusCodeBlock): number {
  if (block.endLine === block.startLine) {
    return 0;
  }

  if (block.content.length === 0) {
    return block.endLine > block.startLine + 1 ? 1 : 0;
  }

  return block.content.split("\n").length;
}

function mapWords(className: string, words: string[]): Array<[string, string]> {
  return words.map((word) => [word, className]);
}
