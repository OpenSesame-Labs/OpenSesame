use std::sync::Mutex;

static LOCK: Mutex<()> = Mutex::new(());

/// Build a fixture while process-global deployment settings are stable.
pub async fn build(args: super::Args) -> anyhow::Result<super::AppState> {
    let _guard = lock();
    super::build_test(args).await
}

/// Serialize tests that mutate process env (`OPENSESAME_*`, `NATS_URL`, …).
pub fn lock() -> std::sync::MutexGuard<'static, ()> {
    LOCK.lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}
