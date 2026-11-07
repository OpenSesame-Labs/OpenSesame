export { convertLegacyMethod, isLegacyMethod } from "./legacy.js";
export type {
  GeneratorDescriptor,
  OfferedGeneratorId,
} from "./registry.js";
export {
  GENERATORS,
  defaultGenerator,
  generateStored,
  generatorEntropyBits,
  newSecretFor,
  offeredGenerators,
} from "./registry.js";
