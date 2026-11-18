//! Construction of the broker's credential transports.

#[cfg(test)]
use std::sync::Mutex;
use std::time::Duration;

use sqlx::SqlitePool;

use crate::{catalog, BrokerConfig, BrokerError, ConnectionBroker, Result};

impl ConnectionBroker {
    /// Construct test transports without loading system proxy settings.
    ///
    /// This does not block direct network access. An offline fixture must also
    /// restrict the routes or transports that can initiate requests.
    ///
    /// # Errors
    ///
    /// Returns an error when the provider catalog or HTTP client cannot initialize.
    pub fn new_without_system_proxy(pool: SqlitePool, config: BrokerConfig) -> Result<Self> {
        catalog::load()?;
        let http = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(20))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| BrokerError::Invalid("could not build credential transport".into()))?;
        // Both credential transports fail closed; uploads get a longer timeout,
        // never redirect permission or a permissive client fallback.
        let http_bytes = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(60))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| {
                BrokerError::Invalid(format!("could not build a no-redirect http client: {e}"))
            })?;
        Ok(Self {
            pool,
            config,
            http,
            http_bytes,
            activation_lock: tokio::sync::Mutex::new(()),
            authorization_lock: tokio::sync::Mutex::new(()),
            discovery_lock: tokio::sync::Mutex::new(()),
            discovery_organization: tokio::sync::Mutex::new(None),
            #[cfg(test)]
            activation_pause: Mutex::new(None),
            #[cfg(test)]
            refresh_pause: Mutex::new(None),
            #[cfg(test)]
            cleanup_attempts: Mutex::new(Vec::new()),
        })
    }
}

#[cfg(all(test, feature = "testkit"))]
#[path = "constructor_tests.rs"]
mod tests;
