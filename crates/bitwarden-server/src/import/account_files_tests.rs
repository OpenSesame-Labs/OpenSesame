use axum::{routing::get, Json, Router};
use opensesame_provider_bitwarden::{DeviceIdentity, Endpoints};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

use super::*;

const ENC: &str = "2.AAAAAAAAAAAAAAAAAAAAAA==|AAAAAAAAAAAAAAAAAAAAAA==|AAAA";

#[tokio::test]
async fn attachment_ids_cannot_choose_paths_or_overwrite_prior_downloads() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let url = format!("{base}/download");
    let router = Router::new()
        .route("/download", get(|| async { "downloaded ciphertext" }))
        .fallback(get(move || {
            let url = url.clone();
            async move { Json(json!({"url": url})) }
        }));
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let api = Client::new(
        Endpoints::from_server_url(&base).unwrap(),
        DeviceIdentity::new("import-path-test"),
    )
    .unwrap();
    let work = tempfile::tempdir().unwrap();
    let scratch = work.path().join("scratch");
    std::fs::create_dir(&scratch).unwrap();
    let sentinel = work.path().join("outside");
    std::fs::write(&sentinel, b"unchanged").unwrap();
    let user = crate::import::tests::user();
    let mut budget = AttachmentBudget::new(AttachmentLimits::default());
    for id in [
        "../outside",
        "..\\outside",
        "/outside",
        "C:\\outside",
        "%2e%2e%2foutside",
    ] {
        let attachment = json!({"id": id, "fileName": ENC});
        assert!(fetch(
            &api,
            "token",
            "cipher",
            &attachment,
            &user,
            &scratch,
            &mut budget
        )
        .await
        .is_none());
    }
    let absolute = json!({"id": sentinel.to_str().unwrap(), "fileName": ENC});
    assert!(fetch(
        &api,
        "token",
        "cipher",
        &absolute,
        &user,
        &scratch,
        &mut budget
    )
    .await
    .is_none());
    let good = json!({"id": "file-id", "fileName": ENC});
    assert!(fetch(
        &api,
        "token",
        "../cipher",
        &good,
        &user,
        &scratch,
        &mut budget
    )
    .await
    .is_none());
    let one = fetch(&api, "token", "cipher", &good, &user, &scratch, &mut budget)
        .await
        .unwrap();
    let two = fetch(&api, "token", "cipher", &good, &user, &scratch, &mut budget)
        .await
        .unwrap();
    assert_eq!(one.source.read().unwrap(), b"downloaded ciphertext");
    if let FileSource::Downloaded { path, .. } = &one.source {
        std::fs::write(path, b"changed to a different size").unwrap();
        assert!(one.source.read().is_none());
        std::fs::write(path, b"downloaded ciphertext").unwrap();
    } else {
        unreachable!();
    }
    let (FileSource::Downloaded { path: first, .. }, FileSource::Downloaded { path: second, .. }) =
        (one.source, two.source)
    else {
        unreachable!();
    };
    assert_ne!(first, second);
    assert!(first.starts_with(&scratch) && second.starts_with(&scratch));
    assert_eq!(std::fs::read(first).unwrap(), b"downloaded ciphertext");
    assert_eq!(std::fs::read(second).unwrap(), b"downloaded ciphertext");
    assert_eq!(std::fs::read(sentinel).unwrap(), b"unchanged");
    server.abort();
}

#[tokio::test]
async fn external_attachment_storage_requires_person_authorization() {
    let storage_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let storage_base = format!("http://{}", storage_listener.local_addr().unwrap());
    let visits = Arc::new(AtomicUsize::new(0));
    let observed = Arc::clone(&visits);
    let storage = Router::new().route(
        "/file",
        get(move |headers: axum::http::HeaderMap| {
            let observed = Arc::clone(&observed);
            async move {
                assert!(!headers.contains_key("authorization"));
                observed.fetch_add(1, Ordering::SeqCst);
                "ciphertext"
            }
        }),
    );
    let storage_task = tokio::spawn(async move {
        axum::serve(storage_listener, storage).await.unwrap();
    });

    let api_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let api_base = format!("http://{}", api_listener.local_addr().unwrap());
    let download_url = format!("{storage_base}/file");
    let server = Router::new().fallback(get(move || {
        let download_url = download_url.clone();
        async move { Json(json!({"url": download_url})) }
    }));
    let api_task = tokio::spawn(async move { axum::serve(api_listener, server).await.unwrap() });

    let sync =
        json!({"ciphers": [{"id": "cipher", "attachments": [{"id": "file", "fileName": ENC}]}]});
    let scratch = tempfile::tempdir().unwrap();
    let user = crate::import::tests::user();
    for authorized in [false, true] {
        let mut endpoints = Endpoints::from_server_url(&api_base).unwrap();
        if authorized {
            endpoints = endpoints.with_download_origin(&storage_base).unwrap();
        }
        let api = Client::new(endpoints, DeviceIdentity::default()).unwrap();
        let mut left = LeftBehind::new();
        let arriving = attachments(
            &api,
            "account-token",
            &sync,
            &user,
            scratch.path(),
            &mut left,
            AttachmentLimits::default(),
        )
        .await;
        assert_eq!(arriving.len(), usize::from(authorized));
        assert_eq!(visits.load(Ordering::SeqCst), usize::from(authorized));
        assert_eq!(
            left.get("attachments that could not be downloaded")
                .copied()
                .unwrap_or(0),
            usize::from(!authorized)
        );
    }
    api_task.abort();
    storage_task.abort();
}

#[tokio::test]
async fn attachment_count_and_bytes_bound_downloads_and_scratch() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let url = format!("{base}/download");
    let visits = Arc::new(AtomicUsize::new(0));
    let observed = Arc::clone(&visits);
    let router = Router::new()
        .route(
            "/download",
            get(move || {
                let observed = Arc::clone(&observed);
                async move {
                    observed.fetch_add(1, Ordering::SeqCst);
                    "four"
                }
            }),
        )
        .fallback(get(move || {
            let url = url.clone();
            async move { Json(json!({"url": url})) }
        }));
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let api = Client::new(
        Endpoints::from_server_url(&base).unwrap(),
        DeviceIdentity::default(),
    )
    .unwrap();
    let sync = json!({"ciphers": [{"id": "cipher", "attachments": [
        {"id":"a", "fileName":ENC}, {"id":"b", "fileName":ENC},
        {"id":"c", "fileName":ENC}, {"id":"d", "fileName":ENC},
        {"id":"e", "fileName":ENC}
    ]}, {"attachments": [{"id":"orphan", "fileName":ENC}]}]});
    let user = crate::import::tests::user();
    for (limits, expected_visits, failed, skipped) in [
        (
            AttachmentLimits {
                max_count: 2,
                max_total_bytes: 100,
            },
            2,
            0,
            3,
        ),
        (
            AttachmentLimits {
                max_count: 5,
                max_total_bytes: 10,
            },
            3,
            1,
            2,
        ),
        (
            AttachmentLimits {
                max_count: 5,
                max_total_bytes: 0,
            },
            0,
            0,
            5,
        ),
    ] {
        visits.store(0, Ordering::SeqCst);
        let scratch = tempfile::tempdir().unwrap();
        let mut left = LeftBehind::new();
        let arriving = attachments(
            &api,
            "token",
            &sync,
            &user,
            scratch.path(),
            &mut left,
            limits,
        )
        .await;
        assert_eq!(visits.load(Ordering::SeqCst), expected_visits);
        assert_eq!(arriving.len(), 2.min(expected_visits));
        assert_eq!(left.get("attachments whose item is unreadable"), Some(&1));
        assert_eq!(
            left.get("attachments that could not be downloaded")
                .copied()
                .unwrap_or(0),
            failed
        );
        assert_eq!(
            left.get("attachments skipped due to import limits")
                .copied()
                .unwrap_or(0),
            skipped
        );
        let scratch_bytes: u64 = std::fs::read_dir(scratch.path())
            .unwrap()
            .map(|entry| entry.unwrap().metadata().unwrap().len())
            .sum();
        assert_eq!(scratch_bytes, u64::try_from(arriving.len() * 4).unwrap());
        assert!(scratch_bytes <= u64::try_from(limits.max_total_bytes).unwrap());
    }
    server.abort();
}
