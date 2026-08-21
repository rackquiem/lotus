export type lotusDynamicInputKind = "slider" | "number" | "text" | "checkbox" | "select" | "button";

export interface lotusDynamicInputOption {
  label: string;
  value: string;
}

export interface lotusDynamicInput {
  kind: lotusDynamicInputKind;
  name?: string;
  label: string;
  defaultValue: string;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  options?: lotusDynamicInputOption[];
  checkedValue?: string;
  uncheckedValue?: string;
  runOnChange: boolean;
  line: number;
}

export interface lotusDynamicInputParseResult {
  source: string;
  inputs: lotusDynamicInput[];
  errors: string[];
}

const DIRECTIVE = /^\s*(?:(?:#|\/\/|--|;|%)\s*|(?:\/\*|\(\*)\s*)?@lotus-(slider|number|text|checkbox|select|button)\b(.*?)(?:\s*(?:\*\/|\*\)))?\s*$/i;
const NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}/g;

export function parseDynamicInputDirectives(source: string): lotusDynamicInputParseResult {
  const inputs: lotusDynamicInput[] = [];
  const errors: string[] = [];
  const outputLines = source.replace(/\r\n?/g, "\n").split("\n");

  for (let index = 0; index < outputLines.length; index += 1) {
    const match = outputLines[index].match(DIRECTIVE);
    if (!match) {
      continue;
    }

    outputLines[index] = "";
    const line = index + 1;
    const kind = match[1].toLowerCase() as lotusDynamicInputKind;
    const parsedAttributes = parseAttributes(match[2].trim());
    if ("error" in parsedAttributes) {
      errors.push(`dynamic input on line ${line}: ${parsedAttributes.error}`);
      continue;
    }

    const parsed = createDynamicInput(kind, parsedAttributes.attributes, line);
    if ("error" in parsed) {
      errors.push(`dynamic input on line ${line}: ${parsed.error}`);
      continue;
    }
    inputs.push(parsed.input);
  }

  const namedInputs = new Map<string, lotusDynamicInput>();
  for (const input of inputs) {
    if (!input.name) {
      continue;
    }
    const existing = namedInputs.get(input.name);
    if (existing && (existing.kind !== "button" || input.kind !== "button")) {
      errors.push(`dynamic input on line ${input.line}: duplicate name ${JSON.stringify(input.name)}`);
      continue;
    }
    namedInputs.set(input.name, input);
  }

  return {
    source: outputLines.join("\n"),
    inputs,
    errors,
  };
}

export function resolveDynamicInputValues(
  inputs: lotusDynamicInput[],
  current: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const values = Object.create(null) as Record<string, string>;
  for (const input of inputs) {
    if (!input.name || input.name in values) {
      continue;
    }
    values[input.name] = current[input.name] ?? input.defaultValue;
  }
  return values;
}

export function substituteDynamicInputValues(source: string, values: Readonly<Record<string, string>>): string {
  return source.replace(PLACEHOLDER, (placeholder, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? values[name] : placeholder);
}

function createDynamicInput(
  kind: lotusDynamicInputKind,
  attributes: Record<string, string>,
  line: number,
): { input: lotusDynamicInput; error?: never } | { input?: never; error: string } {
  const name = attributes.name?.trim();
  if (kind !== "button" && !name) {
    return { error: `${kind} requires name=<placeholder>` };
  }
  if (name && !NAME.test(name)) {
    return { error: `invalid name ${JSON.stringify(name)}` };
  }

  const label = attributes.label?.trim() || name || "Run";
  const runOnChange = readBoolean(attributes.run ?? attributes.autorun);
  const common = {
    kind,
    name,
    label,
    runOnChange,
    line,
  };

  if (kind === "slider" || kind === "number") {
    const min = readFiniteNumber(attributes.min, kind === "slider" ? 0 : undefined);
    const max = readFiniteNumber(attributes.max, kind === "slider" ? 100 : undefined);
    const step = readFiniteNumber(attributes.step, kind === "slider" ? 1 : undefined);
    if (min.error || max.error || step.error) {
      return { error: min.error || max.error || step.error! };
    }
    if (min.value != null && max.value != null && min.value > max.value) {
      return { error: "min must be less than or equal to max" };
    }
    if (step.value != null && step.value <= 0) {
      return { error: "step must be greater than zero" };
    }

    const fallback = min.value ?? 0;
    const defaultValue = attributes.default ?? attributes.value ?? String(fallback);
    const numericDefault = Number(defaultValue);
    if (!Number.isFinite(numericDefault)) {
      return { error: `default must be a finite number, got ${JSON.stringify(defaultValue)}` };
    }
    if (min.value != null && numericDefault < min.value) {
      return { error: "default must be greater than or equal to min" };
    }
    if (max.value != null && numericDefault > max.value) {
      return { error: "default must be less than or equal to max" };
    }

    return {
      input: {
        ...common,
        defaultValue,
        min: min.value,
        max: max.value,
        step: step.value,
      },
    };
  }

  if (kind === "checkbox") {
    const checkedValue = attributes.value ?? attributes.checkedValue ?? "true";
    const uncheckedValue = attributes.unchecked ?? attributes.uncheckedValue ?? "false";
    const checked = readBoolean(attributes.checked ?? attributes.default);
    return {
      input: {
        ...common,
        defaultValue: checked ? checkedValue : uncheckedValue,
        checkedValue,
        uncheckedValue,
      },
    };
  }

  if (kind === "select") {
    const options = parseOptions(attributes.options ?? "");
    if (!options.length) {
      return { error: "select requires a comma-separated options list" };
    }
    const defaultValue = attributes.default ?? attributes.value ?? options[0].value;
    if (!options.some((option) => option.value === defaultValue)) {
      return { error: `default ${JSON.stringify(defaultValue)} is not in options` };
    }
    return {
      input: {
        ...common,
        defaultValue,
        options,
      },
    };
  }

  return {
    input: {
      ...common,
      defaultValue: attributes.default ?? attributes.value ?? "",
      placeholder: attributes.placeholder,
    },
  };
}

function parseAttributes(input: string): { attributes: Record<string, string>; error?: never } | { attributes: Record<string, string>; error: string } {
  const attributes: Record<string, string> = {};
  let cursor = 0;

  while (cursor < input.length) {
    while (cursor < input.length && /\s/.test(input[cursor])) {
      cursor += 1;
    }
    if (cursor >= input.length) {
      break;
    }

    const keyMatch = input.slice(cursor).match(/^([A-Za-z][A-Za-z0-9_-]*)/);
    if (!keyMatch) {
      return { attributes, error: `expected an attribute at ${JSON.stringify(input.slice(cursor))}` };
    }
    const key = keyMatch[1];
    cursor += key.length;
    while (cursor < input.length && /\s/.test(input[cursor])) {
      cursor += 1;
    }
    if (input[cursor] !== "=") {
      return { attributes, error: `attribute ${JSON.stringify(key)} requires =<value>` };
    }
    cursor += 1;
    while (cursor < input.length && /\s/.test(input[cursor])) {
      cursor += 1;
    }
    if (cursor >= input.length) {
      return { attributes, error: `attribute ${JSON.stringify(key)} has no value` };
    }

    const quote = input[cursor] === "'" || input[cursor] === "\"" ? input[cursor] : null;
    let value = "";
    if (quote) {
      cursor += 1;
      let closed = false;
      while (cursor < input.length) {
        const char = input[cursor];
        if (char === quote) {
          cursor += 1;
          closed = true;
          break;
        }
        if (char === "\\" && cursor + 1 < input.length && (input[cursor + 1] === quote || input[cursor + 1] === "\\")) {
          value += input[cursor + 1];
          cursor += 2;
          continue;
        }
        value += char;
        cursor += 1;
      }
      if (!closed) {
        return { attributes, error: `unterminated quoted value for ${JSON.stringify(key)}` };
      }
    } else {
      const valueStart = cursor;
      while (cursor < input.length && !/\s/.test(input[cursor])) {
        cursor += 1;
      }
      value = input.slice(valueStart, cursor);
    }
    attributes[key] = value;
  }

  return { attributes };
}

function parseOptions(input: string): lotusDynamicInputOption[] {
  return input
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf(":");
      return separator < 0
        ? { label: entry, value: entry }
        : { label: entry.slice(0, separator).trim(), value: entry.slice(separator + 1).trim() };
    })
    .filter((option) => option.label && option.value);
}

function readBoolean(value: string | undefined): boolean {
  return value != null && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function readFiniteNumber(
  value: string | undefined,
  fallback: number | undefined,
): { value: number | undefined; error?: never } | { value?: never; error: string } {
  if (value == null || !value.trim()) {
    return { value: fallback };
  }
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? { value: parsed }
    : { error: `expected a finite number, got ${JSON.stringify(value)}` };
}
