//! `OpenFGA` remote PDP adapter — HTTP client against a live `OpenFGA` server.
//!
//! When `OPENSESAME_OPENFGA_URL` is unset, callers may fall back to the in-process PEP.

mod config;
mod grant_tuples;

use async_trait::async_trait;
pub use config::assert_pdp_base_url;
use config::assert_store_id;
pub use grant_tuples::{
    grant_to_openfga_tuples, invoke_check_tuple, GrantTupleMappingError, GrantTupleMappingResult,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum OpenFgaError {
    #[error("openfga http: {0}")]
    Http(String),
    #[error("openfga denied")]
    Denied,
    #[error("openfga unavailable: {0}")]
    Unavailable(String),
    #[error("openfga config: {0}")]
    Config(String),
}

pub type Result<T> = std::result::Result<T, OpenFgaError>;

/// Interpret an `OpenFGA` Check HTTP body.
///
/// `allowed` is true only when the field is the JSON boolean `true`. A missing
/// field is deny (fail closed). A non-boolean value is an error, never allow.
///
/// # Errors
///
/// Returns an error when validation or the underlying operation fails.
pub fn parse_check_response(body: &Value) -> Result<bool> {
    match body.get("allowed") {
        None => Ok(false),
        Some(Value::Bool(allowed)) => Ok(*allowed),
        Some(_) => Err(OpenFgaError::Http(
            "check response `allowed` is not a boolean".into(),
        )),
    }
}

#[derive(Clone, Debug)]
pub struct OpenFgaClient {
    base: String,
    store_id: String,
    http: reqwest::Client,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TupleKey {
    pub user: String,
    pub relation: String,
    pub object: String,
}

#[async_trait]
pub trait RemotePdp: Send + Sync {
    async fn check(&self, tuple: &TupleKey) -> Result<bool>;
}

impl OpenFgaClient {
    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    pub fn from_env() -> Result<Option<Self>> {
        Self::from_lookup(|name| std::env::var(name))
    }

    fn from_lookup(
        lookup: impl Fn(&str) -> std::result::Result<String, std::env::VarError>,
    ) -> Result<Option<Self>> {
        let raw = match lookup("OPENSESAME_OPENFGA_URL") {
            Ok(value) => value,
            Err(std::env::VarError::NotPresent) => return Ok(None),
            Err(std::env::VarError::NotUnicode(_)) => {
                return Err(OpenFgaError::Config(
                    "OPENSESAME_OPENFGA_URL must be UTF-8".into(),
                ))
            }
        };
        if raw.trim().is_empty() {
            return Ok(None);
        }
        let base = raw.trim().trim_end_matches('/');
        let store_id = lookup("OPENSESAME_OPENFGA_STORE_ID").map_err(|_| {
            OpenFgaError::Config("OPENSESAME_OPENFGA_STORE_ID required when URL is set".into())
        })?;
        assert_store_id(&store_id)?;
        assert_pdp_base_url(base)?;
        Ok(Some(Self::try_new(base, store_id)?))
    }

    /// Construct a client, preserving the historical infallible API.
    ///
    /// # Panics
    ///
    /// If the default HTTP client cannot be constructed. Use [`Self::try_new`]
    /// when a caller needs to report that failure.
    #[must_use]
    pub fn new(base: impl Into<String>, store_id: impl Into<String>) -> Self {
        Self::try_new(base, store_id).expect("OpenFGA HTTP client")
    }

    /// Construct a client which refuses redirects.
    ///
    /// # Errors
    ///
    /// The HTTP client cannot be initialized.
    pub fn try_new(base: impl Into<String>, store_id: impl Into<String>) -> Result<Self> {
        Self::with_builder(base, store_id, reqwest::Client::builder())
    }

    fn with_builder(
        base: impl Into<String>,
        store_id: impl Into<String>,
        builder: reqwest::ClientBuilder,
    ) -> Result<Self> {
        let http = builder
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| OpenFgaError::Config("OpenFGA HTTP client unavailable".into()))?;
        Ok(Self {
            base: base.into().trim_end_matches('/').to_string(),
            store_id: store_id.into(),
            http,
        })
    }

    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    pub async fn health(&self) -> Result<()> {
        assert_pdp_base_url(&self.base)?;
        let url = format!("{}/healthz", self.base);
        let resp = self
            .http
            .get(&url)
            .send()
            .await
            .map_err(|e| OpenFgaError::Unavailable(e.to_string()))?;
        if resp.status().is_success() {
            Ok(())
        } else {
            Err(OpenFgaError::Unavailable(format!(
                "status {}",
                resp.status()
            )))
        }
    }

    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    pub async fn create_store(&self, name: &str) -> Result<String> {
        assert_pdp_base_url(&self.base)?;
        let url = format!("{}/stores", self.base);
        let resp = self
            .http
            .post(&url)
            .json(&json!({"name": name}))
            .send()
            .await
            .map_err(|e| OpenFgaError::Http(e.to_string()))?;
        let status = resp.status();
        let body: Value = resp
            .json()
            .await
            .map_err(|e| OpenFgaError::Http(e.to_string()))?;
        if !status.is_success() {
            return Err(OpenFgaError::Http(format!("{status}: {body}")));
        }
        body.get("id")
            .and_then(|v| v.as_str())
            .map(std::string::ToString::to_string)
            .ok_or_else(|| OpenFgaError::Http("missing store id".into()))
    }

    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    pub async fn write_authorization_model(&self, model: Value) -> Result<String> {
        assert_pdp_base_url(&self.base)?;
        assert_store_id(&self.store_id)?;
        let url = format!(
            "{}/stores/{}/authorization-models",
            self.base, self.store_id
        );
        let resp = self
            .http
            .post(&url)
            .json(&model)
            .send()
            .await
            .map_err(|e| OpenFgaError::Http(e.to_string()))?;
        let status = resp.status();
        let body: Value = resp
            .json()
            .await
            .map_err(|e| OpenFgaError::Http(e.to_string()))?;
        if !status.is_success() {
            return Err(OpenFgaError::Http(format!("{status}: {body}")));
        }
        Ok(body
            .get("authorization_model_id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string())
    }

    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    pub async fn write_tuples(&self, writes: &[TupleKey]) -> Result<()> {
        assert_pdp_base_url(&self.base)?;
        assert_store_id(&self.store_id)?;
        let url = format!("{}/stores/{}/write", self.base, self.store_id);
        let writes: Vec<Value> = writes
            .iter()
            .map(|t| {
                json!({
                    "user": t.user,
                    "relation": t.relation,
                    "object": t.object,
                })
            })
            .collect();
        let resp = self
            .http
            .post(&url)
            .json(&json!({"writes": {"tuple_keys": writes}}))
            .send()
            .await
            .map_err(|e| OpenFgaError::Http(e.to_string()))?;
        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(OpenFgaError::Http(body));
        }
        Ok(())
    }

    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    pub async fn check_tuple(&self, tuple: &TupleKey) -> Result<bool> {
        assert_pdp_base_url(&self.base)?;
        assert_store_id(&self.store_id)?;
        let url = format!("{}/stores/{}/check", self.base, self.store_id);
        let resp = self
            .http
            .post(&url)
            .json(&json!({
                "tuple_key": {
                    "user": tuple.user,
                    "relation": tuple.relation,
                    "object": tuple.object,
                },
                "consistency": "HIGHER_CONSISTENCY",
            }))
            .send()
            .await
            .map_err(|e| OpenFgaError::Unavailable(e.to_string()))?;
        let status = resp.status();
        let body: Value = resp
            .json()
            .await
            .map_err(|e| OpenFgaError::Http(e.to_string()))?;
        if !status.is_success() {
            return Err(OpenFgaError::Http(format!("{status}: {body}")));
        }
        parse_check_response(&body)
    }

    /// Minimal `OpenSesame` connection model for live drills.
    #[must_use]
    pub fn connection_model() -> Value {
        json!({
            "schema_version": "1.1",
            "type_definitions": [
                {
                    "type": "user",
                },
                {
                    "type": "connection",
                    "relations": {
                        "user": {
                            "this": {}
                        }
                    },
                    "metadata": {
                        "relations": {
                            "user": {
                                "directly_related_user_types": [{"type": "user"}]
                            }
                        }
                    }
                }
            ]
        })
    }
}

#[async_trait]
impl RemotePdp for OpenFgaClient {
    async fn check(&self, tuple: &TupleKey) -> Result<bool> {
        self.check_tuple(tuple).await
    }
}

/// Bootstrap helper used by live integration scripts/tests.
///
/// # Errors
///
/// Returns an error when validation or the underlying operation fails.
pub async fn bootstrap_demo_store(base: &str) -> Result<(OpenFgaClient, String)> {
    let bootstrap = OpenFgaClient::try_new(base, "pending")?;
    bootstrap.health().await?;
    let store_id = bootstrap.create_store("opensesame-demo").await?;
    let client = OpenFgaClient::try_new(base, &store_id)?;
    client
        .write_authorization_model(OpenFgaClient::connection_model())
        .await?;
    client
        .write_tuples(&[TupleKey {
            user: "user:demo".into(),
            relation: "user".into(),
            object: "connection:demo-conn".into(),
        }])
        .await?;
    Ok((client, store_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn from_env_absent() {
        std::env::remove_var("OPENSESAME_OPENFGA_URL");
        assert!(OpenFgaClient::from_env().unwrap().is_none());
    }

    #[test]
    fn model_is_valid_json() {
        let m = OpenFgaClient::connection_model();
        assert_eq!(m["schema_version"], "1.1");
    }

    #[test]
    fn check_response_is_fail_closed() {
        assert!(!parse_check_response(&json!({})).unwrap());
        assert!(!parse_check_response(&json!({"allowed": false})).unwrap());
        assert!(parse_check_response(&json!({"allowed": true})).unwrap());
        assert!(parse_check_response(&json!({"allowed": "yes"})).is_err());
    }
}

#[cfg(test)]
#[path = "pact_tests.rs"]
mod pact;

#[cfg(test)]
#[path = "config_tests.rs"]
mod config_tests;

#[cfg(test)]
#[path = "http_tests.rs"]
mod http_tests;
