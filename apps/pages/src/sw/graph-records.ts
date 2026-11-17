/** Lossless source-record encoding with a v1-compatible ownership projection. */
import type {
  BoundaryValue,
  JsonObject,
  JsonValue,
} from "@opensesame/os-domain";

const FORMAT = "opensesame-capability-graph/2";

type Source = {
  id: string;
  classification: "core" | "shared" | "optional";
  capability: string | null;
  rationale: string;
  size: number;
  moduleId?: string | null;
};

function object(value: BoundaryValue): value is JsonObject {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function isString(value: BoundaryValue): value is string {
  return (
    Object(value) !== value &&
    Object.prototype.toString.call(value) === "[object String]"
  );
}

function isNumber(value: BoundaryValue): value is number {
  return (
    Object(value) !== value &&
    Object.prototype.toString.call(value) === "[object Number]"
  );
}

function isClassification(
  value: BoundaryValue,
): value is Source["classification"] {
  return value === "core" || value === "shared" || value === "optional";
}

function isNullableString(value: BoundaryValue): value is string | null {
  return value === null || isString(value);
}

function isOptionalString(
  value: BoundaryValue,
): value is string | null | undefined {
  return value === undefined || isNullableString(value);
}

function isSourceSize(value: BoundaryValue): value is number {
  return isNumber(value) && Number.isSafeInteger(value) && value >= 0;
}

function hasOnlySourceKeys(value: JsonObject): boolean {
  const allowed = [
    "id",
    "classification",
    "capability",
    "rationale",
    "size",
    "moduleId",
  ];
  return Object.keys(value).every((key) => allowed.includes(key));
}

function source(value: BoundaryValue): Source | null {
  if (!object(value)) return null;
  const { id, classification, capability, rationale, size, moduleId } = value;
  if (
    !isString(id) ||
    !isClassification(classification) ||
    !isNullableString(capability) ||
    !isString(rationale) ||
    !isSourceSize(size) ||
    !isOptionalString(moduleId) ||
    !hasOnlySourceKeys(value)
  )
    return null;
  const record: Source = {
    id,
    classification,
    capability,
    rationale,
    size,
  };
  if (moduleId !== undefined) record.moduleId = moduleId;
  return record;
}

/** The old service worker makes only some/every queries over these fields. */
function ownership(records: readonly Source[]): JsonObject[] {
  const seen = new Set<string>();
  const result: JsonObject[] = [];
  for (const record of records) {
    const key = JSON.stringify([
      record.classification,
      record.capability,
      record.moduleId ?? null,
    ]);
    if (seen.has(key)) continue;
    seen.add(key);
    const projected: JsonObject = {
      classification: record.classification,
      capability: record.capability,
    };
    if (record.moduleId != null) projected.moduleId = record.moduleId;
    result.push(projected);
  }
  return result;
}

/** Fail if a future graph has fields this codec cannot faithfully preserve. */
export function encodeGraph(value: BoundaryValue): JsonObject {
  if (
    !object(value) ||
    !Array.isArray(value.chunks) ||
    value.graphFormat !== undefined ||
    value.sourceCapabilities !== undefined ||
    value.sourceRationales !== undefined
  )
    throw new Error("Invalid source capability graph");
  const capabilities: (string | null)[] = [];
  const rationales: string[] = [];
  const capIndex = new Map<string | null, number>();
  const reasonIndex = new Map<string, number>();
  const intern = <T extends string | null>(
    item: T,
    list: T[],
    index: Map<T, number>,
  ): number => {
    const found = index.get(item);
    if (found !== undefined) return found;
    const next = list.length;
    list.push(item);
    index.set(item, next);
    return next;
  };
  const chunks = value.chunks.map((chunk): JsonObject => {
    if (
      !object(chunk) ||
      !Array.isArray(chunk.modules) ||
      chunk.sourceModules !== undefined
    )
      throw new Error("Invalid capability chunk");
    const records = chunk.modules.map((entry) => {
      const result = source(entry);
      if (!result) throw new Error("Invalid capability source record");
      return result;
    });
    const sourceModules: JsonValue[] = records.map((entry) => {
      const row: JsonValue[] = [
        entry.id,
        entry.classification,
        intern(entry.capability, capabilities, capIndex),
        intern(entry.rationale, rationales, reasonIndex),
        entry.size,
      ];
      if (entry.moduleId !== undefined) row.push(entry.moduleId);
      return row;
    });
    return { ...chunk, modules: ownership(records), sourceModules };
  });
  return {
    ...value,
    graphFormat: FORMAT,
    sourceCapabilities: capabilities,
    sourceRationales: rationales,
    chunks,
  };
}

function validIndex(value: BoundaryValue, length: number): value is number {
  return (
    isNumber(value) &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value < length
  );
}

function decodeSource(
  row: BoundaryValue,
  capabilities: JsonValue[],
  rationales: JsonValue[],
): Source | null {
  if (!Array.isArray(row) || (row.length !== 5 && row.length !== 6))
    return null;
  const [id, classification, cap, reason, size, moduleId] = row;
  if (
    !isString(id) ||
    !isClassification(classification) ||
    !isSourceSize(size) ||
    !isOptionalString(moduleId) ||
    !validIndex(cap, capabilities.length) ||
    !validIndex(reason, rationales.length)
  )
    return null;
  const input: JsonObject = {
    id,
    classification,
    capability: capabilities[cap],
    rationale: rationales[reason],
    size,
  };
  if (row.length === 6) {
    if (moduleId === undefined) return null;
    input.moduleId = moduleId;
  }
  return source(input);
}

function matchesProjection(modules: JsonValue[], records: Source[]): boolean {
  const expected = ownership(records);
  if (modules.length !== expected.length) return false;
  for (let i = 0; i < expected.length; i++) {
    const actual = modules[i];
    const projected = expected[i];
    if (
      !object(actual) ||
      Object.keys(actual).some(
        (key) => !["classification", "capability", "moduleId"].includes(key),
      ) ||
      actual.classification !== projected.classification ||
      actual.capability !== projected.capability ||
      (actual.moduleId ?? null) !== (projected.moduleId ?? null)
    )
      return false;
  }
  return true;
}

function decodeChunk(
  chunk: BoundaryValue,
  capabilities: JsonValue[],
  rationales: JsonValue[],
): JsonObject | null {
  if (
    !object(chunk) ||
    !Array.isArray(chunk.sourceModules) ||
    !Array.isArray(chunk.modules)
  )
    return null;
  const records: Source[] = [];
  for (const row of chunk.sourceModules) {
    const record = decodeSource(row, capabilities, rationales);
    if (!record) return null;
    records.push(record);
  }
  if (!matchesProjection(chunk.modules, records)) return null;
  const { sourceModules: _sourceModules, ...rest } = chunk;
  return { ...rest, modules: records };
}

function validTables(
  capabilities: JsonValue[],
  rationales: JsonValue[],
): boolean {
  return (
    capabilities.every(isNullableString) &&
    rationales.every(isString) &&
    new Set(capabilities).size === capabilities.length &&
    new Set(rationales).size === rationales.length
  );
}

/** Reconstruct every source record; malformed or inconsistent v2 data is rejected. */
export function decodeGraph(value: BoundaryValue): JsonObject | null {
  if (!object(value) || !Array.isArray(value.chunks)) return null;
  if (value.graphFormat === undefined) {
    if (
      value.sourceCapabilities !== undefined ||
      value.sourceRationales !== undefined ||
      value.chunks.some(
        (chunk) => object(chunk) && chunk.sourceModules !== undefined,
      )
    )
      return null;
    return value;
  }
  if (
    value.graphFormat !== FORMAT ||
    !Array.isArray(value.sourceCapabilities) ||
    !Array.isArray(value.sourceRationales) ||
    !validTables(value.sourceCapabilities, value.sourceRationales)
  )
    return null;
  const chunks: JsonObject[] = [];
  for (const chunk of value.chunks) {
    const decoded = decodeChunk(
      chunk,
      value.sourceCapabilities,
      value.sourceRationales,
    );
    if (!decoded) return null;
    chunks.push(decoded);
  }
  const {
    graphFormat: _graphFormat,
    sourceCapabilities: _sourceCapabilities,
    sourceRationales: _sourceRationales,
    ...rest
  } = value;
  return { ...rest, chunks };
}
