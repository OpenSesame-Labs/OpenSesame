//! Per-invocation component dispatch.

use super::*;

impl Connector for WasmConnector {
    fn id(&self) -> &str {
        &self.manifest.metadata.id
    }

    fn version(&self) -> &str {
        &self.manifest.metadata.version
    }

    fn component_digest(&self) -> &str {
        &self.digest
    }

    fn operations(&self) -> &[&str] {
        &self.operations_static
    }

    fn invoke(&self, req: &InvokeRequest) -> Result<InvokeResult, HostError> {
        self.invoke_context(req, None)
    }

    fn invoke_bound(
        &self,
        req: &InvokeRequest,
        binding: &InvocationBinding,
    ) -> Result<InvokeResult, HostError> {
        binding.assert_request(binding.connection_policy_id(), req)?;
        self.invoke_context(req, Some(binding))
    }
}

impl WasmConnector {
    fn invoke_context(
        &self,
        req: &InvokeRequest,
        binding: Option<&InvocationBinding>,
    ) -> Result<InvokeResult, HostError> {
        // Dispatcher-enforced checks (ADR 0065 §7): the guest cannot forget
        // them because they run before it does.
        let _ = &req.connection_ref;
        if req.operation != req.authorized_operation {
            return Err(HostError::OperationMismatch);
        }
        if opensesame_param_digest(&req.parameters) != req.parameters_digest {
            return Err(HostError::ParameterDigestMismatch);
        }
        if req.invoke_level == Some(opensesame_domain::InvokeLevel::Materialize.as_u8()) {
            return Err(HostError::MaterializeDenied);
        }
        if !self.operations.iter().any(|op| op == &req.operation) {
            return Err(HostError::OperationMismatch);
        }
        // Re-verify the pin on every invocation: a mutated policy or
        // component cannot ride an old approval.
        if !self.policy.trusted_digests.contains(&self.digest) {
            return Err(HostError::UntrustedComponent);
        }

        let (mut store, instance) = self.fresh_instance(&req.connection_ref, binding)?;
        let connection = Resource::<types::ConnectionHandle>::new_own(0);
        let parameters = serde_json::to_vec(&req.parameters)
            .map_err(|e| HostError::Connector(format!("parameters: {e}")))?;
        let intent = types::Intent {
            id: req.parameters_digest.clone(),
            operation: req.operation.clone(),
            resource: req.resource.clone(),
            audience: req.audience.clone(),
            parameters,
            parameters_digest: req.parameters_digest.clone(),
            expires_at_unix_ms: 0,
            idempotency_key: String::new(),
        };
        let outcome = instance
            .call_invoke(&mut store, connection, &intent)
            .map_err(|e| Self::map_guest_error(&e))?;
        let bytes = outcome.map_err(|e| map_invoke_error(&e))?;
        if bytes.len() > self.limits.max_result_bytes {
            return Err(HostError::Connector("result exceeds size cap".into()));
        }
        // The guest may have seen an upstream response that encodes the
        // injected credential. JSON, a size, and a digest can all disclose it.
        Ok(InvokeResult {
            ok: true,
            safe_summary: opaque_guest_summary(&bytes),
            external_request_digest: None,
        })
    }
}
