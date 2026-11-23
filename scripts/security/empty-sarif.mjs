#!/usr/bin/env node
// Writes a complete SARIF 2.1.0 log that reports no findings.
//
//   node scripts/security/empty-sarif.mjs <report.sarif>
//
// Code scanning closes an alert as fixed when a later analysis in the same
// category, from the same tool, no longer reports it. When an artifact that
// was scanned no longer exists (a deleted registry tag), there is nothing left
// to scan, and its alerts would otherwise stay open forever. Uploading this
// log to that artifact's category records "nothing is left here".
//
// The driver name matches what OSV-Scanner writes, so the empty analysis
// replaces the scanner's earlier one. The file is created, never overwritten:
// a real report already at the path is kept and the command fails.
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const OSV_SCANNER_DRIVER = "osv-scanner";

/** A SARIF 2.1.0 log with one OSV-Scanner run and no results. */
export function emptySarif() {
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: OSV_SCANNER_DRIVER,
            informationUri: "https://github.com/google/osv-scanner",
            rules: [],
          },
        },
        results: [],
      },
    ],
  };
}

function main(path) {
  if (!path) {
    console.error("usage: empty-sarif.mjs REPORT.sarif");
    process.exit(2);
  }
  try {
    writeFileSync(path, `${JSON.stringify(emptySarif(), null, 2)}\n`, {
      flag: "wx",
    });
  } catch (error) {
    console.error(`Did not write ${path}: ${error.code ?? error.message}`);
    process.exit(1);
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url))
  main(process.argv[2]);
