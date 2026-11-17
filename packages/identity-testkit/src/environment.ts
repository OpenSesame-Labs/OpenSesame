/**
 * Some application dependencies still consult the ambient process environment.
 * Refuse to use an operator's log destination or signing material in a test.
 */
export function assertIdentityTestEnvironment(env: NodeJS.ProcessEnv): void {
  for (const name of [
    "OPENSESAME_LOG_FILE",
    "OPENSESAME_LOG_KEY_FILE",
    "OPENSESAME_AGENT_AUTH_SIA_JWK",
    "OPENSESAME_JWKS_JSON",
  ]) {
    if (env[name]) {
      throw new Error(
        `Identity test server requires ${name} to be unset in this process`,
      );
    }
  }
  if (env.NODE_ENV === "production" || env.OPENSESAME_ENV === "production") {
    throw new Error("Identity test server cannot run in a production process");
  }
}
