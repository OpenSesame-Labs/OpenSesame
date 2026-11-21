//! Connector dispatch with optional invocation-local context.

use super::*;

impl HostRuntime {
    /// # Errors
    ///
    /// Returns an error when trust, destination, invoke-level, operation, or
    /// connector validation fails. An L2 constrained-HTTP request is admitted
    /// here exactly as [`HostRuntime::invoke_constrained_http`] admits it, and
    /// then refused: executing it takes the invoke-through broker, which a
    /// synchronous call does not have. Nothing here reports a credential it
    /// did not place.
    pub fn invoke(
        &self,
        connection_id: &str,
        req: &InvokeRequest,
    ) -> Result<InvokeResult, HostError> {
        self.invoke_request(connection_id, req, None)
    }

    /// Dispatch the exact request captured in an invocation-local snapshot.
    /// The snapshot is not a replacement for a durable effect fence.
    ///
    /// # Errors
    /// Returns an error on a binding mismatch or connector validation failure.
    pub fn invoke_bound(
        &self,
        connection_id: &str,
        req: &InvokeRequest,
        binding: &InvocationBinding,
    ) -> Result<InvokeResult, HostError> {
        binding.assert_request(connection_id, req)?;
        if binding.is_delegated() && !self.is_inert_builtin_mock(connection_id) {
            return Err(HostError::DelegatedExecutionUnavailable);
        }
        self.invoke_request(connection_id, req, Some(binding))
    }

    fn invoke_request(
        &self,
        connection_id: &str,
        req: &InvokeRequest,
        binding: Option<&InvocationBinding>,
    ) -> Result<InvokeResult, HostError> {
        let (connector, level) = self.checked_level(connection_id, req, None)?;
        if is_constrained_http(level, req) {
            // The binding travels into admission itself: credentialed
            // admission refuses a delegated snapshot even where the
            // inert-mock exemption below admits synchronous mock dispatch.
            self.admit_constrained_http(
                connection_id,
                req,
                constrained_http::now_unix(),
                None,
                None,
                binding,
            )?;
            return Err(HostError::Connector(constrained_http::NEEDS_BROKER.into()));
        }
        if !connector.operations().contains(&req.operation.as_str()) {
            return Err(HostError::Connector(format!(
                "connector {} does not implement {}",
                connector.id(),
                req.operation
            )));
        }
        match binding {
            // This registration is owned by the host and is synchronously inert.
            Some(_) if self.is_inert_builtin_mock(connection_id) => connector.invoke(req),
            Some(binding) => connector.invoke_bound(req, binding),
            // A public invoke without a captured binding is not an authorized
            // dispatch. Substitution checks and delegated refusal live on the
            // bound path; do not run the connector until that path is taken.
            None => Err(HostError::InvocationBindingMismatch),
        }
    }
}
