//! Unit tests for [`super`].

use super::*;

const TEST_TARGET: &str = r#"{"target":{"enabled":true,"replication_version":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}"#;

#[test]
fn units_are_classified_by_what_the_gateway_needs() {
    let digest = "ab".repeat(32);
    match classify(&format!(".attachments/objects/ab/{digest}.oschunk")) {
        Some(Unit::Chunk { digest: got }) => assert_eq!(got, digest),
        _ => panic!("chunk should classify by digest"),
    }
    match classify("Taxes/2025.osattach") {
        Some(Unit::Manifest { logical }) => assert_eq!(logical, "Taxes/2025"),
        _ => panic!("manifest should classify by logical path"),
    }
    // Anything else in the store is not ours to replicate.
    assert!(classify("Dev/token.osseal").is_none());
    assert!(classify(".opensesame-key").is_none());
    // A chunk whose name is not a digest is not addressable by the endpoint.
    assert!(classify(".attachments/objects/zz/nothex.oschunk").is_none());
}

#[test]
fn query_characters_that_would_reshape_a_url_are_encoded() {
    assert_eq!(urlencoding_path("Taxes/2025"), "Taxes/2025");
    assert_eq!(urlencoding_path("a&b"), "a%26b");
    assert_eq!(urlencoding_path("a b"), "a%20b");
    assert_eq!(urlencoding_path("a#b"), "a%23b");
    assert_eq!(urlencoding_path("100%"), "100%25");
}

#[test]
fn operator_credential_is_only_sent_to_an_exact_secure_host_origin() {
    assert!(attachment_host_origin("http://127.0.0.1:8787").is_ok());
    assert!(attachment_host_origin("https://host.example").is_ok());
    for bad in [
        "http://host.example",
        "http://127.0.0.1@host.example",
        "https://user:password@host.example",
        "https://host.example/path",
        "https://host.example?next=attacker",
        "https://host.example#fragment",
    ] {
        assert!(attachment_host_origin(bad).is_err(), "accepted {bad}");
    }
}

/// Read one HTTP/1.1 request: its headers, then a `Content-Length` body.
async fn read_http_request(stream: &mut tokio::net::TcpStream) -> Vec<u8> {
    use tokio::io::AsyncReadExt;
    let mut request = Vec::new();
    let mut buffer = [0; 4096];
    let header_end = loop {
        let read = stream.read(&mut buffer).await.unwrap();
        assert!(read > 0);
        request.extend_from_slice(&buffer[..read]);
        if let Some(i) = request.windows(4).position(|window| window == b"\r\n\r\n") {
            break i + 4;
        }
    };
    let headers = String::from_utf8_lossy(&request[..header_end]);
    let length: usize = headers
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse().unwrap())
        })
        .unwrap_or(0);
    while request.len() < header_end + length {
        let read = stream.read(&mut buffer).await.unwrap();
        assert!(read > 0);
        request.extend_from_slice(&buffer[..read]);
    }
    request
}

/// A real loopback HTTP peer records each request and returns the given replies.
async fn attachment_peer(
    replies: Vec<(&'static str, &'static str)>,
) -> (String, tokio::task::JoinHandle<Vec<Vec<u8>>>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        let mut requests = Vec::new();
        for (status, response_body) in replies {
            let (mut stream, _) =
                tokio::time::timeout(std::time::Duration::from_secs(3), listener.accept())
                    .await
                    .unwrap()
                    .unwrap();
            let request = read_http_request(&mut stream).await;
            let response = format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response_body}", response_body.len());
            stream.write_all(response.as_bytes()).await.unwrap();
            requests.push(request);
        }
        // Keep listening briefly: a buggy client must not be able to hide an
        // extra manifest attempt behind a peer that already closed its socket.
        if let Ok(Ok((mut stream, _))) =
            tokio::time::timeout(std::time::Duration::from_millis(250), listener.accept()).await
        {
            let mut buffer = [0; 4096];
            let read = stream.read(&mut buffer).await.unwrap();
            requests.push(buffer[..read].to_vec());
            stream
                .write_all(
                    b"HTTP/1.1 500 Unexpected\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .await
                .unwrap();
        }
        requests
    });
    (base, task)
}

#[tokio::test]
async fn target_sync_uses_operator_authority_and_republishes_changed_manifests() {
    let target = TEST_TARGET;
    let replies = vec![
        ("200 OK", target),
        ("200 OK", "{}"),
        ("200 OK", "{}"),
        ("200 OK", target),
        ("200 OK", "{}"),
        ("200 OK", "{}"),
    ];
    let (base, peer) = attachment_peer(replies).await;
    let dir = tempfile::tempdir().unwrap();
    let manifest = dir.path().join("manifest");
    let chunk = dir.path().join("chunk");
    std::fs::write(&manifest, b"manifest one").unwrap();
    std::fs::write(&chunk, b"abc").unwrap();
    let digest = "6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85";
    // A manifest deliberately comes first in the input.
    let units = vec![
        ("Taxes/2025.osattach".into(), manifest.clone()),
        (format!(".attachments/objects/64/{digest}.oschunk"), chunk),
    ];
    let token = "this-is-a-test-operator-token-not-a-secret";
    sync_to_target_authorized(&units, &base, token)
        .await
        .unwrap();
    std::fs::write(&manifest, b"manifest two").unwrap();
    sync_to_target_authorized(&units, &base, token)
        .await
        .unwrap();
    let requests = peer.await.unwrap();
    assert_eq!(requests.len(), 6);
    for request in &requests {
        let text = String::from_utf8_lossy(request).to_ascii_lowercase();
        assert!(text.contains(&format!("x-opensesame-operator: {token}")));
        assert!(!text.contains("authorization: bearer"));
    }
    for offset in [0, 3] {
        assert!(String::from_utf8_lossy(&requests[offset])
            .starts_with("GET /api/v1/attachments/target"));
        assert!(String::from_utf8_lossy(&requests[offset + 1])
            .starts_with("POST /api/v1/attachments/replicate/chunk?"));
        assert!(String::from_utf8_lossy(&requests[offset + 2])
            .starts_with("POST /api/v1/attachments/replicate/manifest?"));
        for request in &requests[offset + 1..=offset + 2] {
            assert!(String::from_utf8_lossy(request).contains(
                "x-opensesame-attachment-target: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            ));
        }
    }
    assert!(requests[2].ends_with(b"manifest one"));
    assert!(requests[5].ends_with(b"manifest two"));
}

#[tokio::test]
async fn a_failed_chunk_is_not_followed_by_a_manifest_upload() {
    let (base, peer) = attachment_peer(vec![
        ("200 OK", TEST_TARGET),
        ("503 Service Unavailable", "{}"),
    ])
    .await;
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("sealed");
    std::fs::write(&source, b"abc").unwrap();
    let digest = "6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85";
    let units = vec![
        ("Taxes/2025.osattach".into(), source.clone()),
        (format!(".attachments/objects/64/{digest}.oschunk"), source),
    ];
    let error = sync_to_target_authorized(&units, &base, "operator-token")
        .await
        .unwrap_err();
    assert!(error.to_string().contains("503"));
    let requests = peer.await.unwrap();
    assert_eq!(requests.len(), 2);
    assert!(String::from_utf8_lossy(&requests[1]).contains("/replicate/chunk?"));
}

#[tokio::test]
async fn a_changed_or_missing_chunk_prevents_publishing_a_manifest() {
    for payload in [Some(b"not the named chunk".as_slice()), None] {
        let (base, peer) = attachment_peer(vec![("200 OK", TEST_TARGET)]).await;
        let dir = tempfile::tempdir().unwrap();
        let manifest = dir.path().join("manifest");
        let chunk = dir.path().join("chunk");
        std::fs::write(&manifest, b"sealed manifest").unwrap();
        if let Some(payload) = payload {
            std::fs::write(&chunk, payload).unwrap();
        }
        let units = vec![
            ("Taxes/2025.osattach".into(), manifest),
            (
                format!(".attachments/objects/ab/{}.oschunk", "ab".repeat(32)),
                chunk,
            ),
        ];
        assert!(sync_to_target_authorized(&units, &base, "operator-token")
            .await
            .is_err());
        assert_eq!(
            peer.await.unwrap().len(),
            1,
            "only target discovery is allowed"
        );
    }
}

#[tokio::test]
async fn target_without_a_configuration_version_refuses_to_start_sync() {
    let (base, peer) = attachment_peer(vec![("200 OK", r#"{"target":{"enabled":true}}"#)]).await;
    let error = sync_to_target_authorized(&[], &base, "operator-token")
        .await
        .unwrap_err();
    assert!(error.to_string().contains("current configuration"));
    assert_eq!(peer.await.unwrap().len(), 1);
}

#[test]
fn directory_sync_checks_chunks_before_replacing_a_manifest() {
    let source_dir = tempfile::tempdir().unwrap();
    let destination = tempfile::tempdir().unwrap();
    let source_manifest = source_dir.path().join("manifest");
    let source_chunk = source_dir.path().join("chunk");
    std::fs::write(&source_manifest, b"new manifest").unwrap();
    std::fs::write(&source_chunk, b"corrupted").unwrap();
    let old_manifest = destination.path().join("attachments/Taxes/2025.osattach");
    std::fs::create_dir_all(old_manifest.parent().unwrap()).unwrap();
    std::fs::write(&old_manifest, b"old manifest").unwrap();
    let unrelated = old_manifest.with_extension("partial");
    std::fs::write(&unrelated, b"unrelated file").unwrap();
    let digest = "6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85";
    let units = vec![
        ("Taxes/2025.osattach".into(), source_manifest),
        (
            format!(".attachments/objects/64/{digest}.oschunk"),
            source_chunk.clone(),
        ),
    ];
    assert!(sync_to_dir(&units, destination.path()).is_err());
    assert_eq!(std::fs::read(&old_manifest).unwrap(), b"old manifest");

    std::fs::write(&source_chunk, b"abc").unwrap();
    sync_to_dir(&units, destination.path()).unwrap();
    assert_eq!(std::fs::read(&old_manifest).unwrap(), b"new manifest");
    assert_eq!(std::fs::read(unrelated).unwrap(), b"unrelated file");
}

#[tokio::test]
async fn directory_command_replicates_a_real_store_without_unlocking() {
    let store_dir = tempfile::tempdir().unwrap();
    let destination = tempfile::tempdir().unwrap();
    let root = opensesame_sealed_store::init_store(store_dir.path(), &[]).unwrap();
    let key = opensesame_sealed_store::init_store_key(store_dir.path(), b"correct horse").unwrap();
    let contents = b"important document";
    root.attach_add(
        "Taxes/2025",
        &mut std::io::Cursor::new(contents),
        contents.len() as u64,
        AttachMeta {
            filename: "taxes.pdf".into(),
            mime: None,
        },
        &key,
        false,
    )
    .unwrap();
    drop(key);

    cmd_attach_sync(
        Some(destination.path()),
        "http://unused",
        Some(store_dir.path()),
        None,
    )
    .await
    .unwrap();
    let units = root.attach_replication_units().unwrap();
    assert!(units
        .iter()
        .any(|(relative, _)| relative.ends_with(".osattach")));
    assert!(units
        .iter()
        .any(|(relative, _)| relative.ends_with(".oschunk")));
    for (relative, source) in units {
        assert_eq!(
            std::fs::read(source).unwrap(),
            std::fs::read(destination.path().join("attachments").join(relative)).unwrap()
        );
    }
}

#[path = "attach_replay_tests.rs"]
mod replay;

#[tokio::test]
async fn target_redirect_does_not_forward_the_operator_credential() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let sink = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let source = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", source.local_addr().unwrap());
    let redirect = format!("http://{}/stolen", sink.local_addr().unwrap());
    let peer = tokio::spawn(async move {
        let (mut stream, _) = source.accept().await.unwrap();
        let mut request = [0; 4096];
        assert!(stream.read(&mut request).await.unwrap() > 0);
        stream.write_all(format!("HTTP/1.1 302 Found\r\nLocation: {redirect}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
    });
    assert!(sync_to_target_authorized(&[], &base, "operator-token")
        .await
        .is_err());
    peer.await.unwrap();
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(150), sink.accept())
            .await
            .is_err()
    );
}

#[cfg(unix)]
fn mode_of(path: &Path) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).unwrap().permissions().mode() & 0o777
}

#[test]
#[cfg(unix)]
fn revealed_plaintext_is_owner_only_from_its_first_byte() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("w2.pdf");
    // An existing world-readable document is replaced, not reused.
    std::fs::write(&dest, b"old").unwrap();
    std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o644)).unwrap();
    let partial = dest.with_extension("partial");
    write_owner_only(&dest, |file| {
        // Mid-write, the only copy on disk is already 0600.
        assert_eq!(mode_of(&partial), 0o600);
        Ok(file.write_all(b"plaintext")?)
    })
    .unwrap();
    assert_eq!(std::fs::read(&dest).unwrap(), b"plaintext");
    assert_eq!(mode_of(&dest), 0o600);
    assert!(!partial.exists());
}

#[test]
fn a_failed_write_leaves_nothing_behind() {
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("doc.txt");
    // A stale partial from an earlier crash is replaced, never appended to.
    std::fs::write(dest.with_extension("partial"), b"stale").unwrap();
    let err = write_owner_only(&dest, |file| {
        file.write_all(b"half")?;
        anyhow::bail!("chunk failed to open")
    })
    .unwrap_err();
    assert!(err.to_string().contains("chunk failed"));
    assert!(!dest.exists());
    assert!(!dest.with_extension("partial").exists());
}

#[test]
#[cfg(unix)]
fn a_planted_partial_symlink_is_not_followed() {
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("doc.txt");
    let target = dir.path().join("elsewhere");
    std::os::unix::fs::symlink(&target, dest.with_extension("partial")).unwrap();
    write_owner_only(&dest, |file| Ok(file.write_all(b"secret")?)).unwrap();
    assert!(!target.exists(), "plaintext must not land behind a symlink");
    assert_eq!(mode_of(&dest), 0o600);
}
