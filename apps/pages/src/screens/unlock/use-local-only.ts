import { useState } from "react";
import { usePendingImport } from "../../bindings/pending-import.js";

export function useLocalOnly(firstRun: boolean) {
  const [chosen, setLocalOnly] = useState(false);
  const startsFromFile = usePendingImport() !== null && firstRun;
  const localOnly = chosen || startsFromFile;
  return {
    startsFromFile,
    localOnly,
    setLocalOnly,
    signInStage: firstRun && !localOnly,
  };
}
