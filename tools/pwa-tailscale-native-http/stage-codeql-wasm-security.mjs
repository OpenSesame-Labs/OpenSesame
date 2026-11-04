/** Close the six upstream CodeQL findings after native SSH staging. */
import { join } from "node:path";

const paths = [
  "ipn/ipnlocal/c2n.go",
  "ipn/ipnlocal/peerapi.go",
  "ipn/ipnlocal/local.go",
  "control/controlclient/direct.go",
  "net/tlsdial/tlsdial.go",
  "net/dns/resolver/debug.go",
];

export async function stageCodeqlWasmSecurity({
  here,
  source,
  pins,
  execute,
  requireHash,
}) {
  const spec = pins.codeqlWasmSecurity;
  const patch = join(here, "codeql-wasm-security.patch");
  const wasm = join(source, "cmd/tsconnect/wasm/wasm_js.go");
  if (
    spec?.patch?.path !== "codeql-wasm-security.patch" ||
    spec?.stagingHelper?.path !== "stage-codeql-wasm-security.mjs" ||
    spec.patchTargets?.length !== paths.length ||
    spec.patchTargets.some((file, index) => file.path !== paths[index])
  )
    throw new Error("CodeQL WASM security fixed staging scope differs.");
  const verify = async () => {
    await requireHash(patch, spec.patch.sha256);
    await requireHash(
      join(here, "stage-codeql-wasm-security.mjs"),
      spec.stagingHelper.sha256,
    );
  };
  await verify();
  await requireHash(wasm, spec.patch.beforeSha256);
  for (const file of spec.patchTargets)
    await requireHash(join(source, file.path), file.beforeSha256);
  await execute(
    "patch",
    ["--batch", "--forward", "-p1", "-i", patch],
    "codeql-wasm-security-patch",
    verify,
  );
  await verify();
  await requireHash(wasm, spec.patch.afterSha256);
  for (const file of spec.patchTargets)
    await requireHash(join(source, file.path), file.afterSha256);
  return verify;
}
