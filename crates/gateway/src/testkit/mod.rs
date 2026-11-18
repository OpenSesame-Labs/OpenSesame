//! Isolated, opt-in fixture for selected real Host API routes.

mod server;
mod state;

use axum::{
    extract::Request,
    http::{Method, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Router,
};

use crate::app_state::AppState;
pub use server::RunningHost;

/// A fresh in-memory Host fixture with a synthetic operator token.
///
/// The exposed routes use the production router and admission middleware. A
/// testkit-only outer fence makes every other route a 404, so it cannot invoke
/// providers or change credentials. See the crate README for the exact scope.
pub struct HostTestkit {
    state: AppState,
}

impl HostTestkit {
    /// Build isolated `SQLite` state without loading process provider settings.
    ///
    /// # Errors
    ///
    /// Returns an error if the in-memory database cannot be initialized.
    pub async fn new() -> anyhow::Result<Self> {
        Ok(Self {
            state: state::build().await?,
        })
    }

    /// The synthetic credential for the actual operator admission check.
    #[must_use]
    pub fn operator_token(&self) -> &str {
        &self.state.operator_token
    }

    /// Return a service using the real Host router and admission middleware.
    /// Router clones share this fixture's state; separate fixtures do not.
    pub fn router(&self) -> Router {
        crate::routes::router(self.state.clone()).layer(axum::middleware::from_fn(restrict_routes))
    }

    /// Serve the same routes on an ephemeral IPv4 loopback port.
    ///
    /// # Errors
    ///
    /// Returns an error when the loopback server cannot start.
    pub async fn start(&self) -> std::io::Result<RunningHost> {
        server::start(self.router()).await
    }
}

async fn restrict_routes(request: Request, next: Next) -> Response {
    if request.method() == Method::GET
        && matches!(
            request.uri().path(),
            "/health/live" | "/health/ready" | "/api/v1/whoami" | "/api/v1/connections"
        )
    {
        next.run(request).await
    } else {
        StatusCode::NOT_FOUND.into_response()
    }
}
