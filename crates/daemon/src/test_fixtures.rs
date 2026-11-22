//! Shared daemon test fixtures (kept out of `lib.rs` for the line budget).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use uuid::Uuid;

use super::cli_app_integration;
use super::plugin_routes;
use super::ratelimit;
use super::tailnet_admin_routes;
use super::App;

/// Synthetic executable directory for CLI discovery tests. Unix uses the
/// trusted-exec fixture so tests exercise the same ownership checks as production.
#[cfg(test)]
pub(crate) struct FakeBin {
    #[cfg(unix)]
    fixture: opensesame_trusted_exec::testkit::Fixture,
    #[cfg(not(unix))]
    dir: tempfile::TempDir,
}

#[cfg(test)]
impl FakeBin {
    pub(crate) fn with(binaries: &[&str]) -> Self {
        #[cfg(unix)]
        {
            let fixture = opensesame_trusted_exec::testkit::Fixture::new("fixture-sentinel");
            for binary in binaries {
                fixture.stub_recorder(&fixture.trusted.join(binary));
            }
            Self { fixture }
        }
        #[cfg(not(unix))]
        {
            let dir = tempfile::tempdir().expect("tempdir");
            for binary in binaries {
                std::fs::write(dir.path().join(binary), b"").expect("write fake binary");
            }
            Self { dir }
        }
    }

    pub(crate) fn path(&self) -> String {
        #[cfg(unix)]
        let lookup = self.fixture.lookup(&[]);
        #[cfg(unix)]
        let path = lookup.var("PATH").expect("fixture PATH");
        #[cfg(not(unix))]
        let path = self.dir.path().as_os_str();
        path.to_string_lossy().into_owned()
    }

    pub(crate) fn present(&self, binary: &str) -> bool {
        #[cfg(unix)]
        return opensesame_trusted_exec::resolve_in(binary, None, &self.fixture.lookup(&[]))
            .is_ok();
        #[cfg(not(unix))]
        return self.dir.path().join(binary).is_file();
    }

    #[cfg(unix)]
    pub(crate) fn allow_untrusted_writes(&self) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(
            &self.fixture.trusted,
            std::fs::Permissions::from_mode(0o777),
        )
        .expect("chmod");
    }
}

#[cfg(feature = "testkit")]
mod harness;
#[cfg(feature = "testkit")]
pub use harness::{DaemonTestkit, RunningDaemon};

pub(crate) fn test_operator_token() -> &'static str {
    static TOKEN: std::sync::LazyLock<String> = std::sync::LazyLock::new(|| {
        format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
    });
    &TOKEN
}

#[cfg(test)]
pub(crate) fn test_router(host_api: &str) -> (axum::Router, App) {
    let state = test_state(host_api);
    (super::router(state.clone()), state)
}

pub(crate) fn test_state(host_api: &str) -> App {
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(400))
        .connect_timeout(std::time::Duration::from_millis(200))
        .build()
        .unwrap();
    App {
        sessions: Arc::new(Mutex::new(HashMap::new())),
        capabilities: Arc::new(Mutex::new(HashMap::new())),
        host_api: host_api.to_string(),
        identity_api: "http://127.0.0.1:1".into(),
        http,
        operator_token: test_operator_token().into(),
        allowed_uids: opensesame_uds_authn::default_allowed_uids(),
        discover_limiter: Arc::new(ratelimit::TokenBucket::default()),
        promote_limiter: Arc::new(ratelimit::TokenBucket::default()),
        invoke_limiter: Arc::new(ratelimit::TokenBucket::default()),
        mint_limiter: Arc::new(ratelimit::TokenBucket::default()),
        helper_mints: Arc::new(crate::helper_mints::HelperMints::in_memory()),
        invoker: Arc::new(opensesame_invoke_through::Invoker::new()),
        token_source_factory: Arc::new(|_| None),
        duress_peer: None,
        vault_drive: None,
        plugins: plugin_routes::PluginHost::at(None, Arc::new(|_| None)),
        cli_app_integration: cli_app_integration::open_store(None),
        cli_root_trust_dir: None,
        tailnet: tailnet_admin_routes::TailnetAdminHost::detached(),
    }
}
