/** SPA paths shared by Settings provider tiles and connector ceremonies. */
export type ConnectorCeremonyRoot = "/connections" | "/settings/connections";

export function connectorCeremonyRoot(pathname: string): ConnectorCeremonyRoot {
  return pathname.startsWith("/settings/connections")
    ? "/settings/connections"
    : "/connections";
}

export function connectorPath(
  providerId: string,
  connectionId?: string,
  root: ConnectorCeremonyRoot = "/connections",
): string {
  const provider = encodeURIComponent(providerId);
  const base = `${root}/${provider}`;
  return connectionId ? `${base}/${encodeURIComponent(connectionId)}` : base;
}
