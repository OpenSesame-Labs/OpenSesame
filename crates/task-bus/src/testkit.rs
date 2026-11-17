//! An opt-in `TaskBus` test double with deterministic, per-operation faults.
//!
//! The queue and normal delivery behavior are provided by `InMemoryTaskBus`.
//! This does not emulate `JetStream` persistence, TLS, deduplication, delivery
//! limits, or retry delays. Exercise those against a real server.

use crate::{BusEvent, InMemoryTaskBus, TaskBus};
use async_trait::async_trait;
use std::collections::VecDeque;
use std::sync::Mutex;

/// Whether the corresponding invocation should reach the memory bus.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScriptedOutcome {
    Pass,
    Fail,
}

#[derive(Default)]
struct Scripts {
    publish: VecDeque<ScriptedOutcome>,
    drain: VecDeque<ScriptedOutcome>,
}

/// A fresh, isolated memory bus with scripts for failed publish/drain calls.
///
/// Each operation consumes one outcome from its own FIFO script. Once a
/// script is exhausted, operations pass. A failed operation does not touch
/// the underlying queue. The default `TaskBus::process` calls these same
/// publish/drain methods, including when it requeues a failed event.
/// Concurrent calls consume outcomes in lock-acquisition order, so sequence
/// the calls when a particular caller must receive a particular outcome.
#[derive(Default)]
pub struct ScriptedTaskBus {
    inner: InMemoryTaskBus,
    scripts: Mutex<Scripts>,
}

impl ScriptedTaskBus {
    /// Replace the outcomes for subsequent publish calls.
    ///
    /// # Panics
    ///
    /// Panics if another thread panicked while holding the scripts lock.
    pub fn script_publish(&self, outcomes: impl IntoIterator<Item = ScriptedOutcome>) {
        self.scripts
            .lock()
            .expect("task bus scripts poisoned")
            .publish = outcomes.into_iter().collect();
    }

    /// Replace the outcomes for subsequent drain calls.
    ///
    /// # Panics
    ///
    /// Panics if another thread panicked while holding the scripts lock.
    pub fn script_drain(&self, outcomes: impl IntoIterator<Item = ScriptedOutcome>) {
        self.scripts
            .lock()
            .expect("task bus scripts poisoned")
            .drain = outcomes.into_iter().collect();
    }

    /// Clear pending events and scripts. Call only when no operations are in
    /// flight; concurrent callers could otherwise publish while reset runs.
    ///
    /// # Errors
    ///
    /// Returns an error if the underlying in-memory drain fails.
    ///
    /// # Panics
    ///
    /// Panics if another thread panicked while holding the scripts lock.
    pub async fn reset(&self) -> anyhow::Result<()> {
        self.inner.drain(usize::MAX).await?;
        *self.scripts.lock().expect("task bus scripts poisoned") = Scripts::default();
        Ok(())
    }
}

#[async_trait]
impl TaskBus for ScriptedTaskBus {
    async fn publish(&self, event: BusEvent) -> anyhow::Result<()> {
        let outcome = self
            .scripts
            .lock()
            .expect("task bus scripts poisoned")
            .publish
            .pop_front();
        anyhow::ensure!(
            outcome != Some(ScriptedOutcome::Fail),
            "scripted publish failure"
        );
        self.inner.publish(event).await
    }

    async fn drain(&self, max: usize) -> anyhow::Result<Vec<BusEvent>> {
        let outcome = self
            .scripts
            .lock()
            .expect("task bus scripts poisoned")
            .drain
            .pop_front();
        anyhow::ensure!(
            outcome != Some(ScriptedOutcome::Fail),
            "scripted drain failure"
        );
        self.inner.drain(max).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::EventHandler;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn event(id: &str) -> BusEvent {
        BusEvent::cloud_event(id, "test", "work.item", "now", json!({}))
    }

    async fn assert_fifo_contract(bus: &dyn TaskBus) {
        assert!(bus.drain(1).await.unwrap().is_empty());
        for id in ["first", "second", "third"] {
            bus.publish(event(id)).await.unwrap();
        }
        assert!(bus.drain(0).await.unwrap().is_empty());
        let first_batch = bus.drain(2).await.unwrap();
        assert_eq!(first_batch.len(), 2);
        assert_eq!(first_batch[0].id, "first");
        assert_eq!(first_batch[1].id, "second");
        let rest = bus.drain(10).await.unwrap();
        assert_eq!(rest.len(), 1);
        assert_eq!(rest[0].id, "third");
        assert!(bus.drain(1).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn both_memory_adapters_obey_the_same_fifo_contract() {
        let memory = InMemoryTaskBus::default();
        let scripted = ScriptedTaskBus::default();
        for bus in [&memory as &dyn TaskBus, &scripted] {
            assert_fifo_contract(bus).await;
        }
    }

    #[tokio::test]
    async fn scripted_failures_do_not_mutate_the_queue() {
        let bus = ScriptedTaskBus::default();
        bus.script_publish([ScriptedOutcome::Fail, ScriptedOutcome::Pass]);
        assert!(bus.publish(event("dropped")).await.is_err());
        bus.publish(event("first")).await.unwrap();
        bus.publish(event("second")).await.unwrap();
        bus.script_drain([ScriptedOutcome::Fail]);
        assert!(bus.drain(1).await.is_err());
        assert!(bus.drain(0).await.unwrap().is_empty());
        assert_eq!(bus.drain(1).await.unwrap()[0].id, "first");
        assert_eq!(bus.drain(10).await.unwrap()[0].id, "second");
        assert!(bus.drain(10).await.unwrap().is_empty());
    }

    struct FailsOnce(AtomicUsize);

    #[async_trait]
    impl EventHandler for FailsOnce {
        async fn handle(&self, _event: &BusEvent) -> anyhow::Result<()> {
            anyhow::ensure!(self.0.fetch_add(1, Ordering::SeqCst) > 0, "try again");
            Ok(())
        }
    }

    #[tokio::test]
    async fn process_uses_scripted_publish_when_requeuing() {
        let bus = ScriptedTaskBus::default();
        bus.publish(event("work")).await.unwrap();
        bus.script_publish([ScriptedOutcome::Fail]);
        let handler = FailsOnce(AtomicUsize::new(0));
        let error = bus.process(1, &handler).await.unwrap_err();
        assert!(error.to_string().contains("work"));
        assert!(bus.drain(10).await.unwrap().is_empty());

        bus.publish(event("retry")).await.unwrap();
        let retrying = FailsOnce(AtomicUsize::new(0));
        assert_eq!(bus.process(1, &retrying).await.unwrap().retried, 1);
        assert_eq!(bus.process(1, &retrying).await.unwrap().handled, 1);
    }

    #[tokio::test]
    async fn reset_clears_events_and_scripts_without_affecting_other_instances() {
        let bus = ScriptedTaskBus::default();
        let other = ScriptedTaskBus::default();
        bus.publish(event("before-reset")).await.unwrap();
        other.publish(event("other")).await.unwrap();
        bus.script_publish([ScriptedOutcome::Fail]);
        bus.script_drain([ScriptedOutcome::Fail]);
        bus.reset().await.unwrap();
        assert!(bus.drain(1).await.unwrap().is_empty());
        bus.publish(event("after-reset")).await.unwrap();
        assert_eq!(bus.drain(1).await.unwrap()[0].id, "after-reset");
        assert_eq!(other.drain(1).await.unwrap()[0].id, "other");
    }
}
