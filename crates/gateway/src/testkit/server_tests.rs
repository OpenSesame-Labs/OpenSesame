use super::*;
use axum::routing::get;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tokio::sync::Notify;

struct DropFlag(Arc<AtomicBool>);

impl Drop for DropFlag {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

#[tokio::test]
async fn close_cancels_an_inflight_handler_after_the_drain_deadline() {
    let started = Arc::new(Notify::new());
    let dropped = Arc::new(AtomicBool::new(false));
    let handler_started = Arc::clone(&started);
    let handler_dropped = Arc::clone(&dropped);
    let router = Router::new().route(
        "/pending",
        get(move || {
            let started = Arc::clone(&handler_started);
            let dropped = Arc::clone(&handler_dropped);
            async move {
                let _flag = DropFlag(dropped);
                started.notify_one();
                std::future::pending::<()>().await;
                "unreachable"
            }
        }),
    );
    let server = start(router).await.unwrap();
    let url = format!("{}/pending", server.base_url());
    let request = tokio::spawn(async move {
        reqwest::Client::builder()
            .no_proxy()
            .build()
            .unwrap()
            .get(url)
            .send()
            .await
    });
    tokio::time::timeout(Duration::from_secs(2), started.notified())
        .await
        .expect("the handler started before shutdown");
    tokio::time::timeout(Duration::from_secs(3), server.close())
        .await
        .expect("shutdown is bounded")
        .unwrap();
    assert!(dropped.load(Ordering::SeqCst));
    assert!(request.await.unwrap().is_err());
}
