#!/usr/bin/env node
/** Compile Google Wallet configuration rules from the shared connector catalog. */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isJsonObject, isString } from "../../../scripts/lib/json-boundary.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const source = join(
  here,
  "../../../spec/connectors/google-wallet-configuration.json",
);
const catalogPath = join(here, "../../../spec/connectors/catalog.json");
const output = join(here, "../../wallet/src/google-wallet-policy.generated.ts");

function validateCatalog(policy, catalog) {
  if (!isJsonObject(catalog) || !Array.isArray(catalog.providers))
    throw new Error("Invalid connector catalog");
  const rows = catalog.providers.filter(
    (row) => isJsonObject(row) && row.id === "google-wallet",
  );
  if (rows.length !== 1) throw new Error("Expected one Google Wallet provider");
  const row = rows[0];
  if (
    !isJsonObject(policy) ||
    policy.provider_id !== row.id ||
    !Array.isArray(row.connection_configuration_fields)
  )
    throw new Error("Missing Google Wallet configuration policy");
  validateFields(row.connection_configuration_fields);
}

function validateFields(fields) {
  for (const [name, secret] of [
    ["issuer_id", false],
    ["class_id", false],
    ["service_account_email", false],
    ["service_account_key", true],
  ]) {
    if (
      fields.filter(
        (field) =>
          isJsonObject(field) &&
          field.name === name &&
          field.secret === secret &&
          field.required === true,
      ).length !== 1
    )
      throw new Error(`Invalid Google Wallet field: ${name}`);
  }
}

function validateSemantics(semantics) {
  if (
    !isJsonObject(semantics) ||
    semantics.regex_dialect !== "ecmascript" ||
    semantics.length_unit !== "utf16_code_units" ||
    semantics.pem_whitespace !== "ecmascript" ||
    semantics.private_key_validation !== "pem_then_webcrypto_import" ||
    semantics.pem_envelope_stage !==
      "strip_ecmascript_whitespace_then_base64_decode" ||
    semantics.wallet_config_stage !== "pem_envelope_only" ||
    semantics.native_storage_stage !== "webcrypto_pkcs8_rsa_import" ||
    semantics.native_input_normalization !==
      "trim_public_fields_preserve_private_before_validation" ||
    semantics.wallet_env_normalization !==
      "trim_each_value_and_lowercase_email" ||
    semantics.native_verified_entry_stage !==
      "service_account_json_then_wallet_config_then_signed_provider_proof"
  )
    throw new Error("Unsupported Google Wallet policy semantics");
}

function validateIdentifiers(issuer, walletClass) {
  if (
    !isJsonObject(issuer) ||
    !isJsonObject(walletClass) ||
    !isString(issuer.pattern) ||
    !isString(walletClass.suffix_pattern) ||
    walletClass.qualification !== "unqualified-or-this-issuer" ||
    !isString(walletClass.issuer_separator) ||
    walletClass.issuer_separator.length === 0
  )
    throw new Error("Invalid Google Wallet configuration policy");
}

function validateEmail(email) {
  if (
    !isJsonObject(email) ||
    !isString(email.pattern) ||
    !Number.isSafeInteger(email.max_length) ||
    email.max_length < 1
  )
    throw new Error("Invalid Google Wallet configuration policy");
}

const PEM_HEADER = "-----BEG" + "IN";

function patternFromParts(value, name) {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    value.some(
      (part) =>
        !isString(part) || part.length === 0 || part.includes(PEM_HEADER),
    )
  )
    throw new Error(`Invalid Google Wallet configuration policy (${name})`);
  return value.join("");
}

function validateKey(key) {
  if (
    !isJsonObject(key) ||
    key.format !== "pkcs8" ||
    key.algorithm !== "RSASSA-PKCS1-v1_5" ||
    key.hash !== "SHA-256" ||
    key.usage !== "sign" ||
    key.escaped_newlines !== true ||
    !Number.isSafeInteger(key.max_raw_length) ||
    key.max_raw_length < 1 ||
    !patternFromParts(key.pem_pattern, "pem_pattern")
  )
    throw new Error("Invalid Google Wallet configuration policy");
}

export function googleWalletConfigurationPolicy(
  policy = JSON.parse(readFileSync(source, "utf8")),
  catalog = JSON.parse(readFileSync(catalogPath, "utf8")),
) {
  validateCatalog(policy, catalog);
  validateSemantics(policy.semantics);
  const issuer = policy.issuer_id;
  const walletClass = policy.class_id;
  const email = policy.service_account_email;
  const key = policy.service_account_key;
  validateIdentifiers(issuer, walletClass);
  validateEmail(email);
  validateKey(key);
  const account = policy.native_service_account;
  if (
    !isJsonObject(account) ||
    account.type !== "service_account" ||
    !isString(account.email_pattern) ||
    !Number.isSafeInteger(account.json_max_length) ||
    account.json_max_length < 1
  )
    throw new Error("Invalid Google Wallet service account policy");
  const pemPattern = patternFromParts(key.pem_pattern, "pem_pattern");
  const keyPemPattern = patternFromParts(
    account.key_pem_pattern,
    "key_pem_pattern",
  );
  for (const pattern of [
    issuer.pattern,
    walletClass.suffix_pattern,
    email.pattern,
    pemPattern,
    account.email_pattern,
    keyPemPattern,
  ])
    new RegExp(pattern);
  return {
    issuer: { pattern: issuer.pattern },
    walletClass: {
      qualification: walletClass.qualification,
      suffixPattern: walletClass.suffix_pattern,
      issuerSeparator: walletClass.issuer_separator,
    },
    email: { pattern: email.pattern, maxLength: email.max_length },
    nativeServiceAccount: {
      type: account.type,
      emailPattern: account.email_pattern,
      keyPemPattern,
      jsonMaxLength: account.json_max_length,
    },
    key: {
      format: key.format,
      algorithm: key.algorithm,
      hash: key.hash,
      usage: key.usage,
      maxRawLength: key.max_raw_length,
      pemPattern,
      escapedNewlines: key.escaped_newlines,
    },
  };
}

function emitPemPattern(pattern) {
  const at = pattern.indexOf(PEM_HEADER);
  const cut = at + "-----BEG".length;
  const head = pattern.slice(0, cut);
  const tail = pattern.slice(cut);
  if (
    at < 0 ||
    head.includes(PEM_HEADER) ||
    tail.includes(PEM_HEADER) ||
    `${head}${tail}` !== pattern
  )
    throw new Error("Google Wallet PEM pattern split failed");
  return `[${JSON.stringify(head)}, ${JSON.stringify(tail)}].join("")`;
}

export function renderGoogleWalletConfigurationPolicy(policySource, catalog) {
  const policy = googleWalletConfigurationPolicy(policySource, catalog);
  const patterns = [
    policy.nativeServiceAccount.keyPemPattern,
    policy.key.pemPattern,
  ];
  const lines = [
    "// Generated by scripts/emit-google-wallet-configuration.mjs from",
    "// spec/connectors/google-wallet-configuration.json — do not edit.",
    "export const GOOGLE_WALLET_CONFIGURATION_POLICY = Object.freeze({",
    ...Object.entries(policy).map(([name, value]) => {
      let encoded = JSON.stringify(value);
      for (const pattern of patterns) {
        const literal = JSON.stringify(pattern);
        if (encoded.includes(literal))
          encoded = encoded.replace(literal, emitPemPattern(pattern));
      }
      return `  ${name}: Object.freeze(${encoded}),`;
    }),
    "});",
    "",
  ];
  const rendered = lines.join("\n");
  if (rendered.includes(PEM_HEADER))
    throw new Error(
      "generated Google Wallet policy contains a PEM header literal",
    );
  return rendered;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(output, renderGoogleWalletConfigurationPolicy());
  console.log(`wrote ${output}`);
}
