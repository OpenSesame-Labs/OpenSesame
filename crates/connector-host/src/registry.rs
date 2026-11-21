//! Host-owned connector registration and binding.

use std::sync::Arc;

use super::{
    Connector, HostError, HostRuntime, RegisteredConnector, FALLBACK_CONNECTION_POLICY_ID,
};

impl HostRuntime {
    /// # Errors
    ///
    /// Returns an error when a connector with the same identifier is registered.
    pub fn register_connector(&mut self, connector: Arc<dyn Connector>) -> Result<(), HostError> {
        let id = connector.id().to_owned();
        if self.connectors.contains_key(&id) {
            return Err(HostError::Connector(format!(
                "connector {id} is already registered"
            )));
        }
        let component_digest = connector.component_digest().to_owned();
        self.connectors.insert(
            id,
            RegisteredConnector {
                connector,
                component_digest,
                inert_builtin_mock: false,
            },
        );
        Ok(())
    }

    /// # Errors
    ///
    /// Returns an error when the connector identifier is not registered.
    pub fn bind_connection(
        &mut self,
        connection_id: impl Into<String>,
        connector_id: &str,
    ) -> Result<(), HostError> {
        if !self.connectors.contains_key(connector_id) {
            return Err(HostError::Connector(format!(
                "connector {connector_id} is not registered"
            )));
        }
        self.connection_connectors
            .insert(connection_id.into(), connector_id.into());
        Ok(())
    }

    /// Route a provider's typed operations to a registered connection-policy
    /// id. Refuses ids that nothing is bound to — a provider can never be
    /// pointed at a connector that does not exist (ADR 0065 §5).
    ///
    /// # Errors
    ///
    /// Returns an error when `connection_policy_id` has no bound connector.
    pub fn bind_provider(
        &mut self,
        provider_id: impl Into<String>,
        connection_policy_id: &str,
    ) -> Result<(), HostError> {
        if !self
            .connection_connectors
            .contains_key(connection_policy_id)
        {
            return Err(HostError::Connector(format!(
                "connection policy {connection_policy_id} has no connector"
            )));
        }
        self.provider_connectors
            .insert(provider_id.into(), connection_policy_id.into());
        Ok(())
    }

    /// The connection-policy id that executes `provider_id`'s typed
    /// operations. Unbound providers keep the historical mock fallback,
    /// byte-for-byte: unknown operations there fail closed.
    #[must_use]
    pub fn connector_for_provider(&self, provider_id: &str) -> &str {
        self.provider_connectors
            .get(provider_id)
            .map_or(FALLBACK_CONNECTION_POLICY_ID, String::as_str)
    }

    #[must_use]
    pub fn component_digest(&self, connection_id: &str) -> Option<&str> {
        let connector_id = self.connection_connectors.get(connection_id)?;
        self.connectors
            .get(connector_id)
            .map(|registered| registered.component_digest.as_str())
    }
}
