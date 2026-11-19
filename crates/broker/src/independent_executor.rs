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
            |binding| async move {
                if binding.is_delegated() {
                    return Err(HostError::DelegatedExecutionUnavailable);
                }
                execute(binding).await
            },
            false,
            false,
        )
        .await
    }
}
