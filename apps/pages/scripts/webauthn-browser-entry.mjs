import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import {
  dependencyRoot,
  extractModuleSpecifiers,
} from "./lib/dependency-root.mjs";

export { extractModuleSpecifiers } from "./lib/dependency-root.mjs";

const pagesPackage = fileURLToPath(new URL("../package.json", import.meta.url));
const seamPath = fileURLToPath(
  new URL(
    "../../../packages/auth-upstream/src/simplewebauthn.ts",
    import.meta.url,
  ),
).replaceAll("\\", "/");
const virtualId = "\0opensesame-simplewebauthn-browser";

// Pins cover the leaves' import closure; the barrel pin proves its exclusion.
const verificationLeaves = Object.freeze([
  "esm/authentication/verifyAuthenticationResponse.js",
  "esm/registration/verifyRegistrationResponse.js",
]);

const pins = Object.freeze({
  "package.json":
    "2ecc3776356abc3180e27f16fd32b3680daaa68183f9716533d086dd326e903b",
  "esm/index.js":
    "eb81c4ce867adf3f51feea07eea2c1721373e4f0182eaaca00a402dec31b4ad9",
  "esm/authentication/verifyAuthenticationResponse.js":
    "f81ad465889e3bef9931191f3dbcb1f786828a8baf7571242c8889c65e373278",
  "esm/errors/index.js":
    "9f45b801a3e6e8591fc64707d891c161579565ff7552a19d9c81a5dd00afb166",
  "esm/helpers/assertValidExpectedOrigin.js":
    "2b28589147dddfce6a900871a495519db40b6910a0e265d7977fe144575f760a",
  "esm/helpers/assertValidExpectedRPID.js":
    "c4a27d85c8c43831c2ae35abc7c178d0aec07e205abb5b632c039c579a4d44bd",
  "esm/helpers/convertAAGUIDToString.js":
    "d9bfaa99758ce36138ddf93eb96254bc0ea0448b38834de6a6e9b8154a776c07",
  "esm/helpers/convertCOSEtoPKCS.js":
    "909d8f9f9f4b7ba0328a4ee85b5f7253f6de1c1123535ccd64e729d42c80346e",
  "esm/helpers/convertCertBufferToPEM.js":
    "9bce7921364b2e71bce740ba62be11a2a8f93b61a3a013db3752fb3e4f22c98b",
  "esm/helpers/convertPEMToBytes.js":
    "ae48e84d5a784878b0da6fd34d968fd65d23bc5a7118d0cd944446bc2b0d16f9",
  "esm/helpers/convertX509PublicKeyToCOSE.js":
    "0ae43b1bb9328ddec1a8b71ece9c4ec89cd0473921b3877a351a6e411d859a20",
  "esm/helpers/cose.js":
    "91da47c289c3d6aa09b6e1b8d0bff801dbe1b5462000a2c338c8ddec8af1f7c4",
  "esm/helpers/decodeAttestationObject.js":
    "0050c2992a0f70af7bf6f830a6de648cd05d202a452d85301aea22288205d96a",
  "esm/helpers/decodeAuthenticatorExtensions.js":
    "5c806a3164793a10635d40a145b6bfc2ba026198d689a91053984c44edefbebc",
  "esm/helpers/decodeClientDataJSON.js":
    "79c9d0b62c0718b5555e3ea1b843058d4d7c6d4d28620bd278543f2a6979f99a",
  "esm/helpers/decodeCredentialPublicKey.js":
    "d7060eff6acd7d0baffcd899a83bb7981cb4bc6ae6b61120e5860ebcfa7de16a",
  "esm/helpers/fetch.js":
    "964f332f128a5b352a1767a02458e033955b0c41d4a4a24995b7eba6ad46919e",
  "esm/helpers/generateChallenge.js":
    "832c2a2a89900ec3dcd437a1c3889927cc740fde788c217d090c721ae3a59aa2",
  "esm/helpers/generateUserID.js":
    "f62c4f995ab11fc122071b8ad571cb81498db6e6c3fe25d49248936d020f202e",
  "esm/helpers/getCertificateInfo.js":
    "72b13c5c089f930b42ede0e7b6fde3010b8f26ff7907858f4b1096c2173ec072",
  "esm/helpers/index.js":
    "b3abae2d911758735765149f6ed58dbbabb26d9cbba77f66edb8b080df99f298",
  "esm/helpers/isCertRevoked.js":
    "43b58af606ddd941fbb1dff7d76c7304246599e0357add9c1c041b63d74f6374",
  "esm/helpers/iso/index.js":
    "699d37620459b2637fbfee4e1fee6271000573627af75cecf595d9750dd62f26",
  "esm/helpers/iso/isoBase64URL.js":
    "a685371c7b24632baddde3b1c94a975681a80a9c179c8304a6ec446ed8f6421d",
  "esm/helpers/iso/isoCBOR.js":
    "24b68194e824a80c7ae32926d91596908ea7cfe028d5301145b5b536d99d62dd",
  "esm/helpers/iso/isoCrypto/digest.js":
    "5b454d2059083dc3ecde62068987334f99a2efe8dba8517a236b30b441be00fc",
  "esm/helpers/iso/isoCrypto/getRandomValues.js":
    "c05cfd78f377dcc045f8a4368ecdf9af6dc517682f0ebbbbc84f54c2f777ed0c",
  "esm/helpers/iso/isoCrypto/getWebCrypto.js":
    "f96adcc92393bb33a49e7c478268a29d5f267546a281cb2c5a8aae4bc4067c91",
  "esm/helpers/iso/isoCrypto/importJWKKey.js":
    "93358e533dde773e7c32f106af59790439e8c000c42418c935497660cbd8dd32",
  "esm/helpers/iso/isoCrypto/index.js":
    "da913d7ec24596831089e779c7570711dabc688bf66f7aaf20ddee2e57e23e7c",
  "esm/helpers/iso/isoCrypto/mapCoseAlgToWebCryptoHashAlgName.js":
    "fcebbaaf7b691bb10d29b72720c9219673468962070f37852457300ff1745bb6",
  "esm/helpers/iso/isoCrypto/mapCoseAlgToWebCryptoKeyAlgName.js":
    "4a07b0be6e799588732d52e5f47f1728a90dbf90f2636992840c03cbfa9d207f",
  "esm/helpers/iso/isoCrypto/runtimeSupportsWebCryptoKeyAlg.js":
    "4ddd00b737c1e11eb903b9598242bba94e4826e9c73865d9211f1e00b1fa06d8",
  "esm/helpers/iso/isoCrypto/unwrapEC2Signature.js":
    "a344d0387a95c09a37a405c908007f566e81fa6802f5b7d3070f35b940d560cb",
  "esm/helpers/iso/isoCrypto/verify.js":
    "97591d7b0bb539885710ec5ac8071b324cea36c0a64170e8585e8fc12fe4707e",
  "esm/helpers/iso/isoCrypto/verifyAKP.js":
    "9d4fce8e1d56543f514fcdee4695d0bd6594fe6c10afb701bee1f9ae5b14de01",
  "esm/helpers/iso/isoCrypto/verifyEC2.js":
    "16d4cb6b599d0d2cf034068f325b68f0b3e88f866ccb4651628df26b06899270",
  "esm/helpers/iso/isoCrypto/verifyOKP.js":
    "987a661bf6d2826fd4f0585f8a252e9f34a120165866511b29aaa237e8f12fcc",
  "esm/helpers/iso/isoCrypto/verifyRSA.js":
    "23eaa61a3fc80e3d05987fc3cd50a9baef75932b4893efbc4f53e2dcad8de22c",
  "esm/helpers/iso/isoUint8Array.js":
    "b64d20eb3b57f7bca0fcd7a8a3f8e0a03ce61ef9b517fe5a8d6e8c7b5df0d2e1",
  "esm/helpers/logging.js":
    "e9c9d74e5a9124b35667da94e6136d52c2be3f9bf22f20754d245bab5e25e14b",
  "esm/helpers/mapJWSAlgToCOSEAlg.js":
    "f130b22100ce0a07aeda9a4cfc30af8968b6442ed6d718c0d5a7cdecea921663",
  "esm/helpers/mapX509SignatureAlgToCOSEAlg.js":
    "f1ea158e78ae77f3aaf8c56f9b57b9902320e5f0497f24db55abf1164b51e2b4",
  "esm/helpers/matchExpectedOrigin.js":
    "0556fce3302a7b2f0026e239fbd532b9425158556593c44b976bdc6c9c85809e",
  "esm/helpers/matchExpectedRPID.js":
    "98d90fcf92bcb488978ae7a6f904adf220e2a3f75db63207462c431c52bf7f9e",
  "esm/helpers/parseAuthenticatorData.js":
    "625f27deea6f080a883351a2e444061526d420004bcac313d3cd1f035a9bf433",
  "esm/helpers/parseBackupFlags.js":
    "ed181732eac4c1607ef72ff785acf0ab04ca99978f0a30afd0ea81284240efdb",
  "esm/helpers/toHash.js":
    "b66f273f2d0a0973570b1886cdc6c391e967def5ad649b9fb0aa76f5dce00646",
  "esm/helpers/validateCertificatePath.js":
    "d9d42ffe4d65458591a3c0c002ade28e0b665761f65504cb3833004ab70517a4",
  "esm/helpers/validateExtFIDOGenCEAAGUID.js":
    "5ed42afa8a43104630a3817dbfe0563f9629c398a55cbf404c6ab7072a555d2b",
  "esm/helpers/verifySignature.js":
    "2a3773967ddda8f044afa1e3419e70c2f94936f5f2da86bdb22d5731f93d0ba1",
  "esm/metadata/parseJWT.js":
    "9da5376585c861d3033c0a99a9f9d24dc3c761ef0e2f092571eeed7d344ec41a",
  "esm/metadata/verifyAttestationWithMetadata.js":
    "892c6180c0a60ecb937e08cc6706acb15ffe428dd5308b574926921a6ac8dd5d",
  "esm/metadata/verifyJWT.js":
    "a337a0bb1943c181a3177a2b27d5a050f5f4c7701bbcafa9f3f0e42f02080328",
  "esm/metadata/verifyMDSBlob.js":
    "ecd0654833be5dcf542daa37360b724d55d6baf48be16d94e7b3a711bcb77a18",
  "esm/registration/generateRegistrationOptions.js":
    "155ae163749d61dfb831bd780c290ec3c1bd63e7ddc726f15da09818ad3491b1",
  "esm/registration/verifications/tpm/constants.js":
    "cb9dc43aacfbd3647b56556a0bb38ca60eb6545d061aed8f4429bf0bb813bc40",
  "esm/registration/verifications/tpm/isValidTPMManufacturerID.js":
    "4e6a2d64ede45e0d98d036dd66bb4841816bac80de6be8c57c07f3f3095cdfd0",
  "esm/registration/verifications/tpm/parseCertInfo.js":
    "1ceb47adc90d91d3e166bde6095aa6d9e2820294ad7946f52f476f3e13e5d940",
  "esm/registration/verifications/tpm/parsePubArea.js":
    "958d5b2ceaeda3cc101e1f8f2b708758d1df6b7b81ac2cbbd1a1561413690e4a",
  "esm/registration/verifications/tpm/verifyAttestationTPM.js":
    "7c1b0b5de7a0ca3b40dee062a67b240abb980f89327ac36722b1420acc5084f3",
  "esm/registration/verifications/verifyAttestationAndroidKey.js":
    "2100a954884e0995494dd2f79cdcd4b489ee1bd1e3d898829a2077a9cb346e07",
  "esm/registration/verifications/verifyAttestationAndroidSafetyNet.js":
    "fb3998e0812945de6724e43b9dae4feec5c6514308afa1879ed413a5a7fa71d4",
  "esm/registration/verifications/verifyAttestationApple.js":
    "4bdee5f4adcb0061f1096bc2ac9892fe1fa109d2b050c713c219bc6a09a28ff0",
  "esm/registration/verifications/verifyAttestationFIDOU2F.js":
    "c9cc1942b576a524138d590a7e30ee51126bc1e48492c55d9beea79f7a2be4a8",
  "esm/registration/verifications/verifyAttestationPacked.js":
    "9e8663200d02ac2292397b321333f12bfbc25265f219113b77625e1a89685cc8",
  "esm/registration/verifyRegistrationResponse.js":
    "50e8d2e162f479841c3b1acca693d73ab53cdef0234520d4626366ff934761db",
  "esm/services/convenienceMetadataService.js":
    "dcd0178e1bc68007f16534aeee43ba6939ff01f5e09ead9e17a88da449b31405",
  "esm/services/defaultRootCerts/android-key.js":
    "e525b21e398ab301b5ecc1a8732ef5f91db71f5f3a27ee4712f5d8968375714e",
  "esm/services/defaultRootCerts/android-safetynet.js":
    "19979981d707f6b1507b87ffc0a5f37dfabcdd10cdb239f0a10c2afbf862099e",
  "esm/services/defaultRootCerts/apple.js":
    "da104fff89ac80b264078ae2c669f28bf122ac68d2a108f731265e2767acabbe",
  "esm/services/defaultRootCerts/mds.js":
    "1d2e9a9842b012786c3cda13e507a9169b1c43f69addb50877e3c6a0d3c76747",
  "esm/services/helpers/baseMDSService.js":
    "272db0fbdf4313281f7efb4667bb8522cd1cf3e78df754055a682f879b894a93",
  "esm/services/helpers/getInitCacheMessage.js":
    "97a237ac656e2f50d11a5082d3886553fc271a588ed328b46e3681e9789ab84d",
  "esm/services/helpers/mdsCache.js":
    "af5d09c585da118b713d66cbb8b55c0cff3211f6495b2c5ad4d1275507b304cc",
  "esm/services/helpers/serviceStateTracker.js":
    "99b91dfa786af6da364b7e7359a977f5ab026269d4544cb3b2b25d3cb00d8949",
  "esm/services/metadataService.js":
    "9dd4e01682be8b7c2e870d3ff95bc84568df2722b78b2d6e4850a5c0a79b0173",
  "esm/services/settingsService.js":
    "a47e0c61334a4e0c7c1baa7335fdbf2238a6ebd40b911fbb6e51ff529721134c",
});

export const webAuthnPinnedPaths = Object.freeze(Object.keys(pins));

const digest = (value) => createHash("sha256").update(value).digest("hex");

// The registration leaf reaches every pinned generation/metadata dependency.
export function readWebAuthnImportClosure(packageRoot) {
  const closure = new Set();
  const pending = [...verificationLeaves];
  while (pending.length > 0) {
    const relativePath = normalize(pending.pop()).replaceAll("\\", "/");
    if (closure.has(relativePath)) continue;
    closure.add(relativePath);
    const source = readFileSync(join(packageRoot, relativePath), "utf8");
    for (const specifier of extractModuleSpecifiers(source)) {
      if (!specifier.startsWith(".")) continue;
      const resolved = normalize(
        join(dirname(relativePath), specifier),
      ).replaceAll("\\", "/");
      if (!resolved.endsWith(".js")) {
        throw new Error(
          `WebAuthn browser entry closure is not plain ESM: ${resolved}`,
        );
      }
      if (!closure.has(resolved)) pending.push(resolved);
    }
  }
  return [...closure].sort();
}

function assertClosurePinned(packageRoot) {
  const closure = readWebAuthnImportClosure(packageRoot);
  const unpinned = closure.filter((relativePath) => !(relativePath in pins));
  if (unpinned.length > 0) {
    throw new Error(
      `WebAuthn browser entry pins miss closure files: ${unpinned.join(", ")}`,
    );
  }
  const stale = webAuthnPinnedPaths.filter(
    (relativePath) =>
      relativePath !== "package.json" &&
      relativePath !== "esm/index.js" &&
      !closure.includes(relativePath),
  );
  if (stale.length > 0) {
    throw new Error(
      `WebAuthn browser entry pins are stale for: ${stale.join(", ")}`,
    );
  }
}

export function validateWebAuthnBrowserSource(relativePath, source) {
  if (digest(source) !== pins[relativePath]) {
    throw new Error(`WebAuthn browser entry pin mismatch: ${relativePath}`);
  }
}

export function readWebAuthnBrowserInputs() {
  const packageRoot = dependencyRoot(pagesPackage, "@simplewebauthn/server");
  assertClosurePinned(packageRoot);
  const sources = Object.fromEntries(
    Object.keys(pins).map((relativePath) => {
      const path = join(packageRoot, relativePath).replaceAll("\\", "/");
      const source = readFileSync(path, "utf8");
      validateWebAuthnBrowserSource(relativePath, source);
      return [relativePath, { path, source }];
    }),
  );
  const manifest = JSON.parse(sources["package.json"].source);
  if (
    manifest.name !== "@simplewebauthn/server" ||
    manifest.version !== "14.1.0"
  ) {
    throw new Error("WebAuthn browser entry package pin mismatch");
  }
  return Object.freeze({ packageRoot, sources });
}

export function renderWebAuthnBrowserEntry(input) {
  const authentication =
    input.sources["esm/authentication/verifyAuthenticationResponse.js"].path;
  const registration =
    input.sources["esm/registration/verifyRegistrationResponse.js"].path;
  return `export { verifyAuthenticationResponse } from ${JSON.stringify(authentication)};
export { verifyRegistrationResponse } from ${JSON.stringify(registration)};
`;
}

/** Keep the official verification leaves without the side-effectful server barrel. */
export function webAuthnBrowserEntry() {
  let input;
  let resolved = 0;
  return {
    name: "opensesame-webauthn-browser-entry",
    apply: "build",
    enforce: "pre",
    buildStart() {
      input = readWebAuthnBrowserInputs();
      resolved = 0;
    },
    resolveId(source, importer) {
      if (!input) throw new Error("WebAuthn browser entry was not initialized");
      if (source === virtualId) return virtualId;
      if (
        source === "@simplewebauthn/server" &&
        importer?.replaceAll("\\", "/") === seamPath
      ) {
        resolved += 1;
        return virtualId;
      }
      return null;
    },
    load(id) {
      if (!input) throw new Error("WebAuthn browser entry was not initialized");
      return id === virtualId ? renderWebAuthnBrowserEntry(input) : null;
    },
    generateBundle() {
      if (!input) throw new Error("WebAuthn browser entry was not initialized");
      const ids = [...this.getModuleIds()].map((id) =>
        id.replaceAll("\\", "/"),
      );
      if (!ids.includes(seamPath)) return;
      if (resolved !== 1) {
        throw new Error(`WebAuthn browser boundary mismatch: seam=${resolved}`);
      }
      if (!ids.includes(virtualId)) {
        throw new Error(
          "WebAuthn browser build lost its verification boundary",
        );
      }
      if (ids.includes(input.sources["esm/index.js"].path)) {
        throw new Error("WebAuthn browser build retained the server barrel");
      }
    },
  };
}
