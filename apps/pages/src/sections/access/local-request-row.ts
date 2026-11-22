export const GRANT_ROW_PREFIX = "grant:";

export function grantRowId(grantId: string) {
  return `${GRANT_ROW_PREFIX}${grantId}`;
}
