use crate::tests::sync_target_pact_https::credentialed_send_https_gaps;

#[test]
fn p5_nested_tuple_request_binding() {
    let decoy = r#"async fn f() { if safe.scheme() != "https" { return Err("x".into()); } let ((request,),) = ((client.get(evil),),); request.send().await?; }"#;
    assert_eq!(credentialed_send_https_gaps(decoy), (1, 1), "{decoy}");
    let kept = r#"async fn f() { let ((request,),) = ((client.get(url),),); if url.scheme() != "https" { return Err("x".into()); } request.send().await?; }"#;
    assert_eq!(credentialed_send_https_gaps(kept), (1, 0), "{kept}");
}

#[test]
fn chunk02_if_let_tuple_is_not_a_url_binding() {
    // `if let` / `while let` shadow only inside the condition. They must
    // not replace the outer `request` builder, or the later send looks
    // guarded by the pattern's URL.
    let masked = [
        r#"async fn f() { let request = client.get(evil); if url.scheme() != "https" { return Err("x".into()); } if let (request,) = (client.get(url),) { let _ = 1; } request.send().await?; }"#,
        r#"async fn f() { let request = client.get(evil); if url.scheme() != "https" { return Err("x".into()); } while let (request,) = (client.get(url),) { break; } request.send().await?; }"#,
        r#"async fn f() { let request = client.get(evil); if url.scheme() != "https" { return Err("x".into()); } if let mut (request,) = (client.get(url),) { let _ = 1; } request.send().await?; }"#,
    ];
    for sample in masked {
        assert_eq!(credentialed_send_https_gaps(sample), (1, 1), "{sample}");
    }
    let kept = [
        r#"async fn f() { if url.scheme() != "https" { return Err("x".into()); } let (request,) = (client.get(url),); request.send().await?; }"#,
        r#"async fn f() { if url.scheme() != "https" { return Err("x".into()); } let mut (request,) = (client.get(url),); request.send().await?; }"#,
    ];
    for sample in kept {
        assert_eq!(credentialed_send_https_gaps(sample), (1, 0), "{sample}");
    }
}

#[test]
fn chunk02_tuple_reassignment_rebinds_builder_url() {
    // `(request,) = (…)` is not a `let`, but it does rebind the element.
    // Without it the stored URL stays `url`, and the post-guard send on
    // the rebuilt `evil` request still looks guarded.
    let decoy = [
        r#"async fn f() { let (request,) = (client.get(url),); if url.scheme() != "https" { return Err("x".into()); } (request,) = (client.get(evil),); request.send().await?; }"#,
        r#"async fn f() { let (request,) = (client.get(url),); (request,) = (client.get(evil),); if url.scheme() != "https" { return Err("x".into()); } request.send().await?; }"#,
    ];
    for sample in decoy {
        assert_eq!(credentialed_send_https_gaps(sample), (1, 1), "{sample}");
    }
    let kept = [
        r#"async fn f() { let (request,) = (client.get(url),); if url.scheme() != "https" { return Err("x".into()); } (request,) = (client.get(url),); request.send().await?; }"#,
        r#"async fn f() { if url.scheme() != "https" { return Err("x".into()); } let (request,) = (client.get(url),); request.send().await?; }"#,
    ];
    for sample in kept {
        assert_eq!(credentialed_send_https_gaps(sample), (1, 0), "{sample}");
    }
}

/// A guarded match arm still binds its pattern from the scrutinee:
/// `(request,) if cond =>` shadows any outer `request` inside the arm,
/// so the send must bind the scrutinee element, not fall back to the
/// stale outer binding (Kimi council R6 chunk04).
#[test]
fn kimi_council_r6_guarded_match_arm_binds_from_scrutinee() {
    let decoy = [
        // Outer guard covers `url`; the arm sends the rebound `evil`.
        r#"async fn f() { let request = client.get(url); if url.scheme() != "https" { return Err("x".into()); } match (client.get(evil),) { (request,) if flag => { request.send().await?; } _ => {} } }"#,
        // Same, with the guarded arm after an earlier arm.
        r#"async fn f() { let request = client.get(url); if url.scheme() != "https" { return Err("x".into()); } match (client.get(evil),) { (other,) => {} (request,) if flag => { request.send().await?; } _ => {} } }"#,
        // The scrutinee element is not a builder call: the empty URL must
        // fail closed, not borrow the outer guarded URL.
        r#"async fn f() { let request = client.get(url); if url.scheme() != "https" { return Err("x".into()); } match (boxed,) { (request,) if flag => { request.send().await?; } _ => {} } }"#,
    ];
    for sample in decoy {
        assert_eq!(credentialed_send_https_gaps(sample), (1, 1), "{sample}");
    }
    let kept = [
        // The arm binds `client.get(url)`, which the outer guard covers.
        r#"async fn f() { if url.scheme() != "https" { return Err("x".into()); } match (client.get(url),) { (request,) if flag => { request.send().await?; } _ => {} } }"#,
        // Outer binding is `evil`; the arm rebinding to the guarded `url`
        // must win over the stale outer URL.
        r#"async fn f() { let request = client.get(evil); if url.scheme() != "https" { return Err("x".into()); } match (client.get(url),) { (request,) if flag => { request.send().await?; } _ => {} } }"#,
    ];
    for sample in kept {
        assert_eq!(credentialed_send_https_gaps(sample), (1, 0), "{sample}");
    }
}
