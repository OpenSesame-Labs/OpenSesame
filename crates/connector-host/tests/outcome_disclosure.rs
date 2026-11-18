use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use opensesame_connector_host::{Connector, HostError, HostRuntime, InvokeRequest, InvokeResult};

struct OtherConnector {
    id: &'static str,
    changed: AtomicBool,
}

impl Connector for OtherConnector {
    fn id(&self) -> &str {
        self.id
    }

    fn version(&self) -> &str {
        "1.0.0"
    }

    fn component_digest(&self) -> &str {
        if self.changed.load(Ordering::SeqCst) {
            "provider-controlled-result"
        } else {
            // A digest claim alone must not grant the host-owned mock's policy.
            "sha256:mock-connector"
        }
    }

    fn operations(&self) -> &[&str] {
        &[]
    }

    fn invoke(&self, _request: &InvokeRequest) -> Result<InvokeResult, HostError> {
        Err(HostError::Connector("not invoked".into()))
    }
}

#[test]
fn registered_connectors_cannot_grant_themselves_outcome_disclosure() {
    let mut host = HostRuntime::default();
    assert!(host.permits_outcome_disclosure("demo-conn"));
    assert!(host.is_inert_builtin_mock("demo-conn"));
    assert!(!host.permits_outcome_disclosure("missing"));
    assert!(!host.is_inert_builtin_mock("missing"));

    let spoof = Arc::new(OtherConnector {
        id: "mock",
        changed: AtomicBool::new(false),
    });
    assert!(host.register_connector(spoof).is_err());
    let other = Arc::new(OtherConnector {
        id: "other",
        changed: AtomicBool::new(false),
    });
    host.register_connector(other.clone()).unwrap();
    host.bind_connection("demo-conn", "other").unwrap();
    assert!(!host.permits_outcome_disclosure("demo-conn"));
    assert!(!host.is_inert_builtin_mock("demo-conn"));
    other.changed.store(true, Ordering::SeqCst);
    assert_eq!(
        host.component_digest("demo-conn"),
        Some("sha256:mock-connector")
    );
}
