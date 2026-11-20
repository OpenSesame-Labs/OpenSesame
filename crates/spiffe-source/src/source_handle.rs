//! Handle and status wait for the running Workload API source.

use std::time::Duration;

use tokio::sync::watch;
use tokio::task::JoinHandle;

use crate::sink::SharedLease;
use crate::status::SourceStatus;

/// A running source. Dropping the handle synchronously retires its lease;
/// [`SpiffeSourceHandle::stop`] also waits for the source task to finish.
#[derive(Debug)]
pub struct SpiffeSourceHandle {
    pub(super) status: watch::Receiver<SourceStatus>,
    pub(super) stop: watch::Sender<bool>,
    pub(super) task: Option<JoinHandle<()>>,
    pub(super) lease: SharedLease,
}

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

    /// Wait until `pred` holds for the status, or `timeout` elapses.
    ///
    /// # Errors
    /// The last observed status when the timeout elapsed first.
    pub async fn wait_for(
        &self,
        timeout: Duration,
        mut pred: impl FnMut(&SourceStatus) -> bool,
    ) -> Result<SourceStatus, SourceStatus> {
        let mut rx = self.status.clone();
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            if pred(&rx.borrow()) {
                return Ok(rx.borrow().clone());
            }
            match tokio::time::timeout_at(deadline, rx.changed()).await {
                Ok(Ok(())) => {}
                _ => return Err(rx.borrow().clone()),
            }
        }
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
