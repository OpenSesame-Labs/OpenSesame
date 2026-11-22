//! Authority-owned executors, which do not inherit delegated effect authority.

use crate::{Broker, InvokeInput};
use opensesame_connector_host::{HostError, InvocationBinding, InvokeResult};
use opensesame_domain::InvocationReceipt;
use std::future::Future;

impl Broker {
    /// Run an owner invocation with an authority-owned asynchronous executor.
    /// New delegated work is refused; exact prior receipts remain replayable.
    ///
    /// # Errors
    /// Returns an error when validation, authorization, or persistence fails.
    pub async fn invoke_with<E, F>(
        &self,
        input: InvokeInput,
        execute: E,
    ) -> anyhow::Result<InvocationReceipt>
    where
        E: FnOnce() -> F,
        F: Future<Output = Result<InvokeResult, HostError>>,
    {
        self.invoke_with_bound(input, |_| execute()).await
    }

    /// Run an owner executor with the immutable snapshot selected for this
    /// invocation. The snapshot does not prove current authority; this API
    /// never starts a delegated executor without a future durable effect fence.
    ///
    /// The receipt outcome is always indeterminate. Disclosure is decided by
    /// the execution path, not the routing identifier: the executor performs
    /// its own (typically credentialed network) work and never runs the inert
    /// builtin mock, so even a binding routed to the mock's fallback
    /// connection cannot vouch for the effect, and a lost upstream response
    /// must not be reported as a definitive failure.
    ///
    /// # Errors
    /// Returns an error when validation, authorization, or persistence fails.
    pub async fn invoke_with_bound<E, F>(
        &self,
        input: InvokeInput,
        execute: E,
    ) -> anyhow::Result<InvocationReceipt>
    where
        E: FnOnce(InvocationBinding) -> F,
        F: Future<Output = Result<InvokeResult, HostError>>,
    {
        self.invoke_with_mode(
            input,
            |binding| async move { execute(binding).await },
            false,
            false,
            true,
        )
        .await
    }
}
