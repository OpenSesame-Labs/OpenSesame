import { createRequire } from "node:module";

/** Resolve the CLI's declared loader whether the package manager hoists it or not. */
export const tsxLoader = createRequire(import.meta.url).resolve("tsx");
