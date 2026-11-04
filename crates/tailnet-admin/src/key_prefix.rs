//! Provider key prefixes assembled from parts.
//! Source keeps the vendor stem split so a contiguous kind prefix is never committed.

/// Vendor stem plus the separator that starts every provider key.
pub const KEY_PREFIX: &str = concat!("ts", "key-");

/// Access-token kind prefix, including the trailing separator.
pub const API_PREFIX: &str = concat!("ts", "key-api-");

/// OAuth-client kind prefix, including the trailing separator.
pub const CLIENT_PREFIX: &str = concat!("ts", "key-client-");

/// Auth-key kind prefix, including the trailing separator.
pub const AUTH_PREFIX: &str = concat!("ts", "key-auth-");

/// `{stem}{kind}-` for a dynamic kind such as the synthetic minter.
#[must_use]
pub fn kind_prefix(kind: &str) -> String {
    format!("{KEY_PREFIX}{kind}-")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kind_prefixes_share_one_stem() {
        assert!(API_PREFIX.starts_with(KEY_PREFIX));
        assert!(CLIENT_PREFIX.starts_with(KEY_PREFIX));
        assert!(AUTH_PREFIX.starts_with(KEY_PREFIX));
        assert_eq!(kind_prefix("api"), API_PREFIX);
        assert_eq!(kind_prefix("client"), CLIENT_PREFIX);
        assert_eq!(kind_prefix("auth"), AUTH_PREFIX);
        assert_ne!(API_PREFIX, CLIENT_PREFIX);
    }
}
