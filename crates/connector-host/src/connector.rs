use crate::{HostError, InvocationBinding, InvokeRequest, InvokeResult};

pub trait Connector: Send + Sync {
    fn id(&self) -> &str;
    fn version(&self) -> &str;
    fn component_digest(&self) -> &str;
    fn operations(&self) -> &[&str];
    /// # Errors
    /// Returns an error when the request fails connector validation or execution.
    fn invoke(&self, req: &InvokeRequest) -> Result<InvokeResult, HostError>;

    /// Dispatch an invocation together with its captured request context.
    /// This context is not current authority and does not permit effects.
    /// Implementations must not silently discard delegated authority.
    ///
    /// # Errors
    /// Returns an error for a mismatched request or unsupported delegation.
    fn invoke_bound(
        &self,
        req: &InvokeRequest,
        binding: &InvocationBinding,
    ) -> Result<InvokeResult, HostError> {
        binding.assert_request(binding.connection_policy_id(), req)?;
        if binding.is_delegated() {
            return Err(HostError::DelegatedExecutionUnavailable);
        }
        self.invoke(req)
    }
}
