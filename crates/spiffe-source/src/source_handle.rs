//! Handle and status wait for the running Workload API source.

use std::time::Duration;

use tokio::sync::watch;
use tokio::task::JoinHandle;

use crate::sink::SharedLease;
use crate::status::SourceStatus;

/// A running source.
///
/// Dropping the handle signals the background loop to withdraw and stop.
/// [`Drop`] does not join the task: it cannot await, and aborting the task
/// would skip that terminal withdrawal. The detached task observes the flag
/// and exits. Call [`SpiffeSourceHandle::stop`] to wait until it has finished.
#[derive(Debug)]
pub struct SpiffeSourceHandle {
    pub(super) status: watch::Receiver<SourceStatus>,
    pub(super) stop: watch::Sender<bool>,
    /// `None` after [`SpiffeSourceHandle::stop`] has taken the task to join it.
    pub(super) task: Option<JoinHandle<()>>,
    pub(super) lease: SharedLease,
}

/// Why [`SpiffeSourceHandle::wait_for`] returned before `pred` held.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WaitError {
    /// `timeout` elapsed. The status is the last observation.
    DeadlineElapsed(SourceStatus),
    /// The status sender was dropped because the source task ended or the
    /// channel closed. The status is the last observation.
    StatusTaskGone(SourceStatus),
}

impl std::fmt::Display for WaitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::DeadlineElapsed(status) => write!(
                f,
                "deadline elapsed (phase {:?}, generation {:?})",
                status.phase, status.generation
            ),
            Self::StatusTaskGone(status) => write!(
                f,
                "status task gone (phase {:?}, generation {:?})",
                status.phase, status.generation
            ),
        }
    }
}

impl std::error::Error for WaitError {}

impl SpiffeSourceHandle {
    /// Live status feed.
    #[must_use]
    pub fn status(&self) -> watch::Receiver<SourceStatus> {
        self.status.clone()
    }

    /// Current status.
    #[must_use]
    pub fn current(&self) -> SourceStatus {
        self.status.borrow().clone()
    }

    /// Wait until `pred` holds for the status, the timeout elapses, or the
    /// status task is gone.
    ///
    /// # Errors
    /// [`WaitError::DeadlineElapsed`] when `timeout` elapses first, or
    /// [`WaitError::StatusTaskGone`] when the status sender is dropped.
    pub async fn wait_for(
        &self,
        timeout: Duration,
        mut pred: impl FnMut(&SourceStatus) -> bool,
    ) -> Result<SourceStatus, WaitError> {
        let mut rx = self.status.clone();
        wait_for_status(&mut rx, timeout, pred).await
    }

    /// Stop the loop; the current generation is withdrawn.
    pub async fn stop(mut self) {
        let _ = self.stop.send(true);
        self.lease.retire();
        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
    }
}

impl Drop for SpiffeSourceHandle {
    fn drop(&mut self) {
        self.lease.retire();
        let _ = self.stop.send(true);
    }
}

async fn wait_for_status(
    rx: &mut watch::Receiver<SourceStatus>,
    timeout: Duration,
    mut pred: impl FnMut(&SourceStatus) -> bool,
) -> Result<SourceStatus, WaitError> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if pred(&rx.borrow()) {
            return Ok(rx.borrow().clone());
        }
        match tokio::time::timeout_at(deadline, rx.changed()).await {
            Ok(Ok(())) => {}
            Ok(Err(_)) => return Err(WaitError::StatusTaskGone(rx.borrow().clone())),
            Err(_) => return Err(WaitError::DeadlineElapsed(rx.borrow().clone())),
        }
    }
}

#[cfg(test)]
mod wait_tests {
    use std::time::Duration;

    use super::{wait_for_status, WaitError};
    use crate::status::SourceStatus;

    #[tokio::test]
    async fn wait_for_distinguishes_deadline_elapsed_from_status_task_gone() {
        let initial = SourceStatus::initial("spiffe://example.test/workload");
        let (tx, mut rx) = tokio::sync::watch::channel(initial);
        let deadline = wait_for_status(&mut rx, Duration::from_millis(30), |_| false)
            .await
            .expect_err("predicate never holds");
        assert!(matches!(deadline, WaitError::DeadlineElapsed(_)));

        drop(tx);
        let gone = wait_for_status(&mut rx, Duration::from_secs(5), |_| false)
            .await
            .expect_err("sender dropped");
        assert!(matches!(gone, WaitError::StatusTaskGone(_)));
        assert_ne!(
            std::mem::discriminant(&deadline),
            std::mem::discriminant(&gone)
        );
    }
}