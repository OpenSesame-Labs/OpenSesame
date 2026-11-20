#[cfg(test)]
mod probes {
    use crate::tests::sync_target_pact_https::credentialed_send_https_gaps;

    #[test]
    fn p5_decoy_scheme_after_builder_let_is_missing() {
        let sample = r#"async fn f() { let request = client.get(evil); if decoy.scheme() != "https" { return } request.send().await?; }"#;
        assert_eq!(credentialed_send_https_gaps(sample), (1, 1), "{sample}");
    }

    #[test]
    fn p5_turbofish_typed_let_and_branch_urls() {
        let fish = r#"async fn f() { if evil.scheme() != "https" { return Err("x".into()); } let request = client.get::<Body>(evil); request.send().await?; }"#;
        assert_eq!(credentialed_send_https_gaps(fish), (1, 0), "{fish}");
        let fish_decoy = r#"async fn f() { if decoy.scheme() != "https" { return Err("x".into()); } let request = client.get::<Body>(evil); request.send().await?; }"#;
        assert_eq!(
            credentialed_send_https_gaps(fish_decoy),
            (1, 1),
            "{fish_decoy}"
        );
        let typed = r#"async fn f() { if decoy.scheme() != "https" { return Err("x".into()); } let request: RequestBuilder = client.request::<Body>(method, evil); request.send().await?; }"#;
        assert_eq!(credentialed_send_https_gaps(typed), (1, 1), "{typed}");
        let branch = r#"async fn f() { let request = if cond { client.get(evil) } else { client.get(url) }; if url.scheme() != "https" { return Err("x".into()); } request.send().await?; }"#;
        assert_eq!(credentialed_send_https_gaps(branch), (1, 1), "{branch}");
        let same = r#"async fn f() { let request = if cond { client.get(url) } else { client.get(url) }; if url.scheme() != "https" { return Err("x".into()); } request.send().await?; }"#;
        assert_eq!(credentialed_send_https_gaps(same), (1, 0), "{same}");
    }
}
