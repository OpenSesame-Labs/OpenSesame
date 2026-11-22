import {
  type BoundaryValue,
  type Jsonable,
  isBigint,
  isBoolean,
  isFunction,
  isJsonObject,
  isNumber,
  isString,
  isUndefined,
  overlapCast,
} from "@opensesame/os-domain";

const INTEGER_PATTERN = /^-?\d+$/;
const WHITESPACE = new Set([" ", "\t", "\n", "\r"]);
const NUMBER_CHAR = /[0-9.eE+-]/;

/** Read position over JSON text that `JSON.parse` has already accepted. */
type Cursor = { readonly text: string; index: number };

function skipWhitespace(cursor: Cursor): void {
  while (WHITESPACE.has(cursor.text[cursor.index] ?? "")) cursor.index += 1;
}

/**
 * Decode one string literal. The literal's bytes are handed to `JSON.parse`
 * unchanged, so escapes and every string value are decoded exactly as plain
 * JSON decodes them: no prefix or marker is special.
 */
function readString(cursor: Cursor): string {
  const { text } = cursor;
  const start = cursor.index;
  let index = start + 1;
  while (index < text.length && text[index] !== '"') {
    index += text[index] === "\\" ? 2 : 1;
  }
  cursor.index = index + 1;
  return JSON.parse(text.slice(start, cursor.index));
}

/**
 * Decode one number token. Only an integer token JavaScript cannot represent
 * exactly becomes a bigint; every other number is what `JSON.parse` yields.
 */
function readNumber(cursor: Cursor): number | bigint {
  const { text } = cursor;
  const start = cursor.index;
  while (NUMBER_CHAR.test(text[cursor.index] ?? "")) cursor.index += 1;
  const literal = text.slice(start, cursor.index);
  const value = Number(literal);
  if (INTEGER_PATTERN.test(literal) && !Number.isSafeInteger(value)) {
    return BigInt(literal);
  }
  return value;
}

/** Define a member the way `JSON.parse` does, `__proto__` included. */
function defineMember(
  target: Record<string, BoundaryValue>,
  key: string,
  value: BoundaryValue,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function readObject(cursor: Cursor): Record<string, BoundaryValue> {
  const result: Record<string, BoundaryValue> = {};
  cursor.index += 1;
  skipWhitespace(cursor);
  if (cursor.text[cursor.index] === "}") {
    cursor.index += 1;
    return result;
  }
  for (;;) {
    skipWhitespace(cursor);
    const key = readString(cursor);
    skipWhitespace(cursor);
    cursor.index += 1; // ':'
    defineMember(result, key, readValue(cursor));
    skipWhitespace(cursor);
    const separator = cursor.text[cursor.index];
    cursor.index += 1;
    if (separator === "}") return result;
  }
}

function readArray(cursor: Cursor): BoundaryValue[] {
  const result: BoundaryValue[] = [];
  cursor.index += 1;
  skipWhitespace(cursor);
  if (cursor.text[cursor.index] === "]") {
    cursor.index += 1;
    return result;
  }
  for (;;) {
    result.push(readValue(cursor));
    skipWhitespace(cursor);
    const separator = cursor.text[cursor.index];
    cursor.index += 1;
    if (separator === "]") return result;
  }
}

function readLiteral(cursor: Cursor, word: string, value: BoundaryValue) {
  cursor.index += word.length;
  return value;
}

function readValue(cursor: Cursor): BoundaryValue {
  skipWhitespace(cursor);
  const char = cursor.text[cursor.index];
  if (char === "{") return readObject(cursor);
  if (char === "[") return readArray(cursor);
  if (char === '"') return readString(cursor);
  if (char === "t") return readLiteral(cursor, "true", true);
  if (char === "f") return readLiteral(cursor, "false", false);
  if (char === "n") return readLiteral(cursor, "null", null);
  return readNumber(cursor);
}

/**
 * Parse JSON without rounding integers outside the safe range: they arrive as
 * bigint and every other value — every string included — is exactly what
 * `JSON.parse` yields. `JSON.parse` validates the text first, so malformed
 * input fails with its ordinary error; the walk then reads number tokens from
 * the raw text, which `JSON.parse` would round before any reviver runs.
 */
export function parseLosslessJson(text: string): BoundaryValue {
  JSON.parse(text);
  return readValue({ text, index: 0 });
}

function emit(value: BoundaryValue): string {
  if (isUndefined(value) || isFunction(value)) return "null";
  if (value === null) return "null";
  if (isBigint(value)) return value.toString();
  if (isString(value) || isBoolean(value) || isNumber(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => emit(entry)).join(",")}]`;
  }
  if (isJsonObject(value)) {
    const candidate: Jsonable = overlapCast(value);
    if (isFunction(candidate.toJSON)) return emit(candidate.toJSON());
    const entries: string[] = [];
    for (const [key, entry] of Object.entries(value)) {
      if (isUndefined(entry) || isFunction(entry)) continue;
      entries.push(`${JSON.stringify(key)}:${emit(entry)}`);
    }
    return `{${entries.join(",")}}`;
  }
  throw new Error("lossless_json_unsupported_value");
}

/**
 * Serialize JSON carrying bigint integers as bare number tokens so the Host
 * receives the exact digits it originally signed over. Every other value is
 * written as `JSON.stringify` writes it — strings byte-identical, never
 * escaped or marked — because the Host decodes this as ordinary JSON.
 */
export function stringifyLosslessJson(value: BoundaryValue): string {
  const boundary: BoundaryValue = overlapCast(value);
  return emit(boundary);
}
