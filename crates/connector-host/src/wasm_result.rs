use serde_json::{json, Value};

/// Guest output can encode an injected credential, even in its length or
/// digest. Return the same fixed summary for every successful result.
pub(super) fn opaque_guest_summary(_bytes: &[u8]) -> Value {
    json!({"result": "completed"})
}

#[cfg(test)]
mod tests {
    use super::opaque_guest_summary;

    #[test]
    fn transformed_credentials_and_output_metadata_remain_opaque() {
        let hostile = br#"{"opaque":"UkVWRVJTSUJMRV9DUkVERU5USUFM"}"#;
        let summary = opaque_guest_summary(hostile);
        assert_eq!(summary, opaque_guest_summary(b""));
        let rendered = summary.to_string();
        assert!(!rendered.contains("opaque"));
        assert!(!rendered.contains("UkVWRVJTSUJMRV9DUkVERU5USUFM"));
        assert!(!rendered.contains("bytes"));
        assert!(!rendered.contains("digest"));
    }
}
