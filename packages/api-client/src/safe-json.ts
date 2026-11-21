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
 * Quote integer literals JavaScript cannot represent exactly so the reviver
 * can restore them as bigint. Scans raw text instead of trusting
 * `JSON.parse`, which rounds before any reviver runs.
 */
function quoteUnsafeIntegers(text: string): string {
  let out = "";
  let index = 0;
  let inString = false;
  while (index < text.length) {
    const char = text[index] ?? "";
    if (inString) {
      out += char;
      if (char === "\\") {
        out += text[index + 1] ?? "";
        index += 2;
        continue;
      }
      if (char === '"') inString = false;
      index += 1;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      index += 1;
      continue;
    }
    if (char === "-" || (char >= "0" && char <= "9")) {
      let end = index;
      if (text[end] === "-") end += 1;
      while (end < text.length && /[0-9]/.test(text[end] ?? "")) end += 1;
      const integer = text.slice(index, end);
      const rest = text[end] ?? "";
      const isIntegerLiteral = rest !== "." && rest !== "e" && rest !== "E";
      if (isIntegerLiteral && !Number.isSafeInteger(Number(integer))) {
        out += `"${SENTINEL}${integer}"`;
        index = end;
        continue;
      }
      if (!isIntegerLiteral) {
        while (end < text.length && /[0-9.eE+-]/.test(text[end] ?? ""))
          end += 1;
      }
      out += text.slice(index, end);
      index = end;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

/**
 * Parse JSON without rounding integers outside the safe range: they arrive as
 * bigint and every other value follows ordinary JSON semantics. Pair with
 * {@link stringifyLosslessJson} so a saved payload round-trips byte-exact.
 */
export function parseLosslessJson(text: string): BoundaryValue {
  return JSON.parse(quoteUnsafeIntegers(text), (_key, value: BoundaryValue) =>
    isString(value) && value.startsWith(SENTINEL)
      ? BigInt(value.slice(SENTINEL.length))
      : value,
  );
}

function emit(value: BoundaryValue): string {
  if (isUndefined(value)) return "null";
  if (value === null) return "null";
  if (isBigint(value)) return value.toString();
  if (isString(value)) return JSON.stringify(value);
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
