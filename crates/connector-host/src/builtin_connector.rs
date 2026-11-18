//! Host-owned mock connector and outcome-disclosure policy.

use super::{
    opensesame_param_digest, Connector, HostError, HostRuntime, InvokeLevel, InvokeRequest,
    InvokeResult, MockConnector, MOCK_CONNECTOR_DIGEST, MOCK_CONNECTOR_ID, MOCK_CONNECTOR_VERSION,
};
use serde_json::json;

impl Connector for MockConnector {
    fn id(&self) -> &str {
        MOCK_CONNECTOR_ID
    }
    fn version(&self) -> &str {
        MOCK_CONNECTOR_VERSION
    }
    fn component_digest(&self) -> &str {
        MOCK_CONNECTOR_DIGEST
    }
    fn operations(&self) -> &[&str] {
        &[
            "repository.read",
            "pull_request.create",
            "error.transient",
            "error.permanent",
            "error.rate_limit",
            "error.timeout",
            "error.indeterminate",
            "rotate.plan",
            "credential.resolve",
        ]
    }
    fn invoke(&self, req: &InvokeRequest) -> Result<InvokeResult, HostError> {
        if req.operation != req.authorized_operation {
            return Err(HostError::OperationMismatch);
        }
        let expected = opensesame_param_digest(&req.parameters);
        if expected != req.parameters_digest {
            return Err(HostError::ParameterDigestMismatch);
        }
        if req.operation == "credential.resolve"
            || req.invoke_level == Some(InvokeLevel::Materialize.as_u8())
        {
            return Err(HostError::MaterializeDenied);
        }
        match req.operation.as_str() {
            "error.transient" => Err(HostError::Connector("transient".into())),
            "error.permanent" => Err(HostError::Connector("permanent".into())),
            "error.rate_limit" => Err(HostError::Connector("rate_limited".into())),
            "error.timeout" => Err(HostError::Connector("timeout".into())),
            "error.indeterminate" => Err(HostError::Connector("indeterminate".into())),
            "repository.read" => Ok(InvokeResult {
                ok: true,
                safe_summary: json!({"resource": req.resource, "title": "README"}),
                external_request_digest: Some("sha256:mock-read".into()),
            }),
            "pull_request.create" => Ok(InvokeResult {
                ok: true,
                safe_summary: json!({"pr_number": 42, "resource": req.resource}),
                external_request_digest: Some("sha256:mock-pr".into()),
            }),
            "rotate.plan" => Ok(InvokeResult {
                ok: true,
                safe_summary: json!({"steps": ["generate", "install", "verify", "revoke"]}),
                external_request_digest: None,
            }),
            other => Err(HostError::Connector(format!("unknown op {other}"))),
        }
    }
}

impl HostRuntime {
    /// This identifies only the host-installed synchronous mock. It says
    /// nothing about independent executors or constrained-HTTP work.
    #[must_use]
    pub fn is_inert_builtin_mock(&self, connection_id: &str) -> bool {
        self.connection_connectors
            .get(connection_id)
            .and_then(|id| self.connectors.get(id))
            .is_some_and(|registered| registered.inert_builtin_mock)
    }

    /// Only the host-installed mock may disclose an outcome. Registered
    /// connectors cannot grant themselves that authority.
    #[must_use]
    pub fn permits_outcome_disclosure(&self, connection_id: &str) -> bool {
        self.is_inert_builtin_mock(connection_id)
    }
}
