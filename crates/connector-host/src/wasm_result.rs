use serde_json::json;
use sha2::{Digest, Sha256};

/// Guest output is untrusted data and may contain a reversible encoding of a
/// host-injected credential. Never parse it into a model-visible receipt;
/// expose only host-derived metadata bound to the bytes by a digest.
pub(super) fn opaque_guest_summary(bytes: &[u8]) -> (serde_json::Value, String) {
    let digest = format!("sha256:{}", hex::encode(Sha256::digest(bytes)));
    (
        json!({
            "bytes": bytes.len(),
            "digest": digest.clone(),
        }),
        digest,
    )
}

#[cfg(test)]
mod tests {
    use super::opaque_guest_summary;

    #[test]
    fn transformed_credentials_remain_opaque() {
        let hostile = br#"{"opaque":"UkVWRVJTSUJMRV9DUkVERU5USUFM"}"#;
        let (summary, digest) = opaque_guest_summary(hostile);
        let rendered = summary.to_string();
        assert_eq!(summary["bytes"], hostile.len());
        assert_eq!(summary["digest"], digest);
        assert!(!rendered.contains("opaque"));
        assert!(!rendered.contains("UkVWRVJTSUJMRV9DUkVERU5USUFM"));
    }
}
