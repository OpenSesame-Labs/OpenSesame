function assertMinimalProfileVault(markers, check) {
  const {
    enableCore,
    itemFilters,
    externalConnectors,
    passkeyRecords,
    certificateRecords,
    liveSessions,
    onSwitchCount,
  } = markers;
  check(
    enableCore === 1 && itemFilters === 0,
    `minimal vault: no item-type filters until enabled (${JSON.stringify(markers)})`,
  );
  check(
    !externalConnectors &&
      !passkeyRecords &&
      !certificateRecords &&
      !liveSessions &&
      onSwitchCount <= 1,
    `minimal vault: no optional features on (${JSON.stringify(markers)})`,
  );
}

function assertDefaultProfileVault(markers, check) {
  const {
    account,
    passkey,
    certificate,
    onSwitchCount,
    externalConnectors,
    passkeyRecords,
    certificateRecords,
    accessAuthority,
    browserLocalIam,
    liveSessions,
  } = markers;
  check(
    account > 0 && passkey > 0 && certificate > 0,
    `default vault: password + passkey + certificate filters (${JSON.stringify(markers)})`,
  );
  check(
    externalConnectors &&
      passkeyRecords &&
      certificateRecords &&
      accessAuthority &&
      browserLocalIam,
    `default vault: Default extensions on in Features (${JSON.stringify(markers)})`,
  );
  check(
    !liveSessions && onSwitchCount >= 5 && onSwitchCount <= 12,
    `default vault: moderate feature count (${onSwitchCount})`,
  );
}

function assertFullProfileVault(markers, check) {
  const { itemFilters, onSwitchCount, externalConnectors, liveSessions } =
    markers;
  check(itemFilters >= 5, `full vault: full item-type rail (${itemFilters})`);
  check(
    onSwitchCount >= 18,
    `full vault: broad feature approval (${onSwitchCount} switches on)`,
  );
  check(
    externalConnectors && liveSessions,
    `full vault: connectors and live sessions on (${JSON.stringify(markers)})`,
  );
}

function assertCustomProfileVault(markers, check) {
  const {
    derivedTypes,
    externalConnectors,
    passkeyRecords,
    passkey,
    certificate,
  } = markers;
  check(
    derivedTypes,
    `custom vault: Derived item types on in Features (${JSON.stringify(markers)})`,
  );
  check(
    !externalConnectors && !passkeyRecords,
    `custom vault: no Default connector pack (${JSON.stringify(markers)})`,
  );
  check(
    passkey === 0 && certificate === 0,
    `custom vault: passkey/certificate filters off before core enable (${JSON.stringify(markers)})`,
  );
}

const PROFILE_VAULT_ASSERTERS = {
  minimal: assertMinimalProfileVault,
  default: assertDefaultProfileVault,
  full: assertFullProfileVault,
  custom: assertCustomProfileVault,
};

/** DOM proof that the committed plan matches the setup road. */
export function assertProfileVaultDom(profileId, markers, check) {
  const assertProfile = PROFILE_VAULT_ASSERTERS[profileId];
  if (assertProfile) assertProfile(markers, check);
}