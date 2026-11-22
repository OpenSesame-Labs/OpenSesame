//! Security-relevant defaults must retain their intended lifetimes.

use opensesame_bitwarden_server::ServerConfig;

#[test]
fn default_token_lifetimes_and_failure_window_are_stable() {
    let config = ServerConfig::new("https://example.test");
    assert_eq!(config.access_token_ttl.as_secs(), 3_600);
    assert_eq!(config.failure_window.as_secs(), 900);
    assert_eq!(config.refresh_token_ttl.as_secs(), 2_592_000);
}
