import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const paths = [
  "packages/app-core/src/lib/identity.ts",
  "packages/app-core/src/lib/identity-probe.ts",
  "packages/app-core/src/lib/identity-token-proof.ts",
  "packages/app-core/src/lib/identity-session-types.ts",
  "packages/app-core/src/lib/identity-cookie-inspection.ts",
  "packages/app-core/src/lib/identity-signout.ts",
  "packages/app-core/src/lib/identity-revocation-journal.ts",
  "packages/app-core/src/lib/identity-shared-signout.ts",
  "packages/app-core/src/lib/auth-generation.ts",
  "packages/app-core/src/lib/device-identity.ts",
  "packages/app-core/src/lib/browser-pairing.ts",
  "packages/app-core/src/lib/guest-auth.ts",
  "packages/app-core/src/lib/federation.ts",
  "packages/app-core/src/lib/federation-publication.ts",
  "packages/app-core/src/lib/settings.ts",
  "packages/app-core/src/lib/claims/transport.ts",
  "packages/app-core/src/lib/claims/ceremony.ts",
  "packages/control-plane/src/app.ts",
  "packages/control-plane/src/routes/principals.ts",
  "apps/pages/src/components/IdentityCeremony.tsx",
  "apps/pages/src/components/ConnectionCeremony.tsx",
  "apps/pages/src/components/status-mark.css",
  "apps/pages/src/screens/FrontDoor.tsx",
  "apps/pages/src/screens/door.css",
  "apps/pages/src/screens/unlock/GuestRoad.tsx",
];

function blobHash(root, path) {
  const bytes = readFileSync(join(root, path));
  return createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
}

export function seedAuthC1(root) {
  for (const path of paths) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), `reviewed ${path}\n`);
  }
  const document = join(root, "docs/security/formal-auth-verification.md");
  mkdirSync(dirname(document), { recursive: true });
  const rows = paths
    .map((path) => `\n- \`${path}\`: \`${blobHash(root, path)}\``)
    .join("");
  writeFileSync(
    document,
    `AUTH-C1 was independently reviewed against these exact Git blobs. A squash\ncommit retains them; future changes require a new independent review and snapshot update:\n${rows}\n`,
  );
}

export function rejectAuthC1Drift(root, check) {
  for (const path of [
    "packages/app-core/src/lib/federation-publication.ts",
    "packages/app-core/src/lib/settings.ts",
  ]) {
    const target = join(root, path);
    const reviewed = readFileSync(target);
    writeFileSync(target, "unreviewed drift\n");
    assert.match(check().stderr, /AUTH-C1 source drift/);
    writeFileSync(target, reviewed);
  }
  const first = paths[0];
  const source = join(root, first);
  const reviewed = readFileSync(source);
  const reviewedBlob = blobHash(root, first);
  writeFileSync(source, "unreviewed drift\n");
  assert.match(check().stderr, /AUTH-C1 source drift/);
  writeFileSync(source, reviewed);
  const document = join(root, "docs/security/formal-auth-verification.md");
  const snapshot = readFileSync(document, "utf8");
  writeFileSync(document, snapshot.replace(reviewedBlob, "0".repeat(40)));
  assert.match(check().stderr, /AUTH-C1 source drift/);
  writeFileSync(
    document,
    snapshot.replace(`\n- \`${first}\`: \`${reviewedBlob}\``, ""),
  );
  assert.match(check().stderr, /invalid AUTH-C1 source inventory/);
  writeFileSync(source, "consistently recorded, not independently reviewed\n");
  writeFileSync(
    document,
    snapshot.replace(reviewedBlob, blobHash(root, first)),
  );
  assert.equal(check().status, 0);
  writeFileSync(source, reviewed);
  writeFileSync(document, snapshot);
}
