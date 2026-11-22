import {
  exportExpression,
  readPackedGeneratedData,
} from "./generated-data-read.mjs";

export function renderGeneratedDataModule(source, descriptor, referenceId) {
  const data = readPackedGeneratedData(source, descriptor);
  const reference = `import.meta.ROLLUP_FILE_URL_${referenceId}`;
  if (descriptor.kind === "embedded-array") {
    return renderEmbeddedArray(source, descriptor, reference, data);
  }
  if (descriptor.kind === "bundled-export") {
    return responseModule(
      descriptor,
      reference,
      `const { value } = await response.json();
export const ${descriptor.exportName} = value;`,
      data,
    );
  }
  if (descriptor.kind === "json-default") {
    return responseModule(
      descriptor,
      reference,
      `const { value } = await response.json();
export default value;`,
      data,
      descriptor.assetName,
    );
  }
  if (descriptor.kind === "pack-index") {
    return renderPackIndex(source, descriptor, reference, data);
  }
  if (descriptor.kind === "capability-catalog") {
    return renderCapabilityCatalog(source, descriptor, reference, data);
  }
  if (descriptor.kind === "literal-module") {
    const exports = descriptor.exportNames
      .map((name) => `export const ${name} = values.${name};`)
      .join("\n");
    return responseModule(
      descriptor,
      reference,
      `const { values } = await response.json();
${exports}`,
      data,
    );
  }
  if (descriptor.kind === "literal-array") {
    return renderLiteralArray(source, descriptor, reference, data);
  }
  if (descriptor.kind === "packed-string") {
    return renderPackedString(source, descriptor, reference, data);
  }
  return renderRows(source, descriptor, reference, data);
}

function renderEmbeddedArray(source, descriptor, reference, data) {
  const declarationStart = source.indexOf(descriptor.declaration);
  const expressionStart = declarationStart + descriptor.declaration.length;
  const expressionEnd = source.indexOf(
    descriptor.expressionEnd,
    expressionStart,
  );
  if (declarationStart < 0 || expressionEnd <= expressionStart) {
    throw new Error(`${descriptor.exportName} embedded boundary is missing`);
  }
  const prefix = source.slice(0, declarationStart).trimEnd();
  const declaration = source.slice(declarationStart, expressionStart).trimEnd();
  const suffix = source.slice(expressionEnd);
  return {
    code: `${prefix}\n\n${fetchBlock(descriptor, reference)}\nconst { value: __opensesameDataValue } = await response.json();\n${declaration} __opensesameDataValue${suffix}`,
    data,
    map: null,
  };
}

function renderLiteralArray(source, descriptor, reference, data) {
  const { exportStart, assignment } = exportExpression(source, descriptor);
  const prefix = source.slice(0, exportStart).trimEnd();
  const declaration = source.slice(exportStart, assignment + 1).trimEnd();
  return {
    code: `${prefix}

${fetchBlock(descriptor, reference)}
const { value } = await response.json();
${declaration} value;
`,
    data,
    map: null,
  };
}

function renderPackedString(source, descriptor, reference, data) {
  const importStart = source.indexOf(
    'import { unpackGeneratedJson } from "./generated-json.js";',
  );
  if (importStart < 0) {
    throw new Error(`${descriptor.exportName} unpack import is missing`);
  }
  const prefix = source.slice(0, importStart).trimEnd();
  return {
    code: `${prefix}

${fetchBlock(descriptor, reference, `${descriptor.exportName} generated data`)}
const { value } = await response.json();
export const ${descriptor.exportName} = value;
`,
    data,
    map: null,
  };
}

function renderRows(source, descriptor, reference, data) {
  const importStart = source.indexOf(
    'import { unpackGeneratedJson } from "./generated-json.js";',
  );
  if (importStart < 0) {
    throw new Error(`${descriptor.exportName} unpack import is missing`);
  }
  const prefix = source.slice(0, importStart).trimEnd();
  return {
    code: `${prefix}
import { unpackGeneratedJson } from "./generated-json.js";

${fetchBlock(descriptor, reference, `${descriptor.exportName} generated data`)}
const { dictionary, rows } = await response.json();
export const ${descriptor.exportName}: readonly string[] = rows.map((row) =>
  unpackGeneratedJson(row, dictionary),
);
`,
    data,
    map: null,
  };
}

function fetchBlock(
  descriptor,
  reference,
  subject = `${descriptor.exportName} static data`,
) {
  return `const response = await fetch(${reference});
if (!response.ok) {
  throw new Error(
    \`Unable to load ${subject} (\${response.status})\`,
  );
}`;
}

function responseModule(descriptor, reference, exports, data, subject) {
  return {
    code: `${fetchBlock(descriptor, reference, subject)}
${exports}
`,
    data,
    map: null,
  };
}

function renderPackIndex(source, descriptor, reference, data) {
  const exportStart = source.indexOf(`export const ${descriptor.exportName}`);
  const assignment = source.indexOf("=", exportStart);
  const tailStart = source.indexOf(
    "/** One dynamic import per pack",
    assignment,
  );
  if (exportStart < 0 || assignment < 0 || tailStart < 0) {
    throw new Error("PACK_INDEX generated boundary drifted");
  }
  const prefix = source.slice(0, exportStart).trimEnd();
  const declaration = source.slice(exportStart, assignment + 1).trimEnd();
  const tail = source.slice(tailStart);
  return {
    code: `${prefix}

${fetchBlock(descriptor, reference, `${descriptor.exportName} generated data`)}
const { values } = await response.json();
${declaration} values.${descriptor.exportName};

${tail}`,
    data,
    map: null,
  };
}

function renderCapabilityCatalog(source, descriptor, reference, data) {
  const authoredImport = source.indexOf(
    'import { BROWSER_LOCAL_DESCRIPTORS } from "./catalog-always-on-local.js";',
  );
  const catalogStart = source.indexOf(
    "export const CAPABILITY_CATALOG: CapabilityCatalog = buildCatalog(",
  );
  const catalogEnd = source.indexOf("\n);", catalogStart);
  if (authoredImport < 0 || catalogStart < 0 || catalogEnd < 0) {
    throw new Error("Capability catalog source boundary drifted");
  }
  const prefix = source.slice(0, authoredImport).trimEnd();
  const versionStart = source.indexOf(
    "export const CATALOG_VERSION",
    authoredImport,
  );
  const versionEnd = source.indexOf(";", versionStart) + 1;
  if (versionStart < 0 || versionEnd <= versionStart) {
    throw new Error("Capability catalog version boundary drifted");
  }
  const version = source.slice(versionStart, versionEnd);
  const tail = source.slice(catalogEnd + 3);
  return {
    code: `${prefix}

${fetchBlock(descriptor, reference)}
const { descriptors } = await response.json();
${version}
export const CAPABILITY_CATALOG: CapabilityCatalog = buildCatalog(
  descriptors,
  CATALOG_VERSION,
);${tail}`,
    data,
    map: null,
  };
}
