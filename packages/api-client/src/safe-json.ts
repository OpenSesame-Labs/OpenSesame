import {
  type BoundaryValue,
  isBigint,
  isBoolean,
  isFunction,
  isJsonObject,
  isNumber,
  isString,
  isUndefined,
  overlapCast,
} from "@opensesame/os-domain";

const SENTINEL = "__opensesame_lossless_int__";

/**
 * Escape marker for user strings that already start with the sentinel. The
 * marker cannot be confused with a quoted integer literal because the integer
 * pattern never begins with it.
 */
const ESCAPE = "~";

const INTEGER_PATTERN = /^-?\d+$/;

/** Hide a caller's own sentinel-prefixed string from the reviver. */
function escapeSentinelString(value: string): string {
  return value.startsWith(SENTINEL)
    ? `${SENTINEL}${ESCAPE}${value.slice(SENTINEL.length)}`
    : value;
}

/**
 * Restore what the sentinel marks: an escaped caller string, or a quoted
 * unsafe integer. Anything else is a corrupt payload — strict parse refuses
 * it rather than silently coercing a signed digest input.
 */
function reviveSentinelString(value: string): BoundaryValue {
  const rest = value.slice(SENTINEL.length);
  if (rest.startsWith(ESCAPE)) {
    return `${SENTINEL}${rest.slice(ESCAPE.length)}`;
  }
  if (INTEGER_PATTERN.test(rest)) return BigInt(rest);
  throw new Error("lossless_json_sentinel_collision");
}

/**
 * Quote integer literals JavaScript cannot represent exactly so the reviver
 * can restore them as bigint. Scans raw text instead of trusting
 * `JSON.parse`, which rounds before any reviver runs.
 */
function quoteUnsafeIntegers(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index] ?? "";
    if (char === '"') {
      const { chunk, next } = copyStringLiteral(text, index);
      out += chunk;
      index = next;
      continue;
    }
    if (char === "-" || (char >= "0" && char <= "9")) {
      const { literal, next } = readNumberLiteral(text, index);
      out += quoteIfUnsafe(literal);
      index = next;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

/** Copy one string literal, opening quote through closing quote, verbatim. */
function copyStringLiteral(
  text: string,
  start: number,
): { chunk: string; next: number } {
  let index = start + 1;
  while (index < text.length) {
    const char = text[index] ?? "";
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === '"') {
      return { chunk: text.slice(start, index + 1), next: index + 1 };
    }
    index += 1;
  }
  return { chunk: text.slice(start), next: index };
}

/** Read one JSON number literal starting at `start`. */
function readNumberLiteral(
  text: string,
  start: number,
): { literal: string; next: number } {
  let end = start;
  if (text[end] === "-") end += 1;
  while (end < text.length && /[0-9]/.test(text[end] ?? "")) end += 1;
  const rest = text[end] ?? "";
  if (rest === "." || rest === "e" || rest === "E") {
    while (end < text.length && /[0-9.eE+-]/.test(text[end] ?? "")) end += 1;
  }
  return { literal: text.slice(start, end), next: end };
}

/** Only integer-shaped literals JavaScript cannot represent get quoted. */
function quoteIfUnsafe(literal: string): string {
  if (!INTEGER_PATTERN.test(literal) || Number.isSafeInteger(Number(literal))) {
    return literal;
  }
  return `"${SENTINEL}${literal}"`;
}

/**
 * Parse JSON without rounding integers outside the safe range: they arrive as
 * bigint and every other value follows ordinary JSON semantics. Pair with
 * {@link stringifyLosslessJson} so a saved payload round-trips byte-exact.
 */
export function parseLosslessJson(text: string): BoundaryValue {
  return JSON.parse(quoteUnsafeIntegers(text), (_key, value: BoundaryValue) =>
    isString(value) && value.startsWith(SENTINEL)
      ? reviveSentinelString(value)
      : value,
  );
}

function emit(value: BoundaryValue): string {
  if (isUndefined(value)) return "null";
  if (value === null) return "null";
  if (isBigint(value)) return value.toString();
  if (isString(value)) return JSON.stringify(escapeSentinelString(value));
  if (isBoolean(value)) return value ? "true" : "false";
  if (isNumber(value)) {
    if (!Number.isFinite(value)) return "null";
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => emit(entry)).join(",")}]`;
  }
  if (isJsonObject(value)) {
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
 * Serialize JSON carrying bigint integers as bare literals so the Host
 * receives the exact digits it originally signed over. Throws on values JSON
 * cannot express; silent coercion would corrupt a signed digest input.
 */
export function stringifyLosslessJson(value: unknown): string {
  const boundary: BoundaryValue = overlapCast(value);
  return emit(boundary);
}
