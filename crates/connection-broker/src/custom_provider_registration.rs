//! Registration of an org-scoped custom provider.

use crate::{
    catalog, custom_provider, store, BrokerError, ConnectionBroker, CreateCustomProvider,
    ProviderView, Result,
};
use opensesame_domain::OrganizationId;

impl ConnectionBroker {
    /// Register an org-scoped custom connector (MCP server, `OpenAPI` backend,
    /// internal API). The definition holds no secrets; its egress allowlist is
    /// derived from the base URL and never stated by the caller.
    ///
    /// # Errors
    ///
    /// Returns an error when validation fails, the id collides with the
    /// catalog or an existing definition, or storage fails.
    pub async fn create_custom_provider(
        &self,
        organization_id: &OrganizationId,
        request: CreateCustomProvider,
        created_by: &str,
    ) -> Result<ProviderView> {
        let provider = custom_provider::derive_provider(&request)?;
        self.config.custom_egress().validate_provider(&provider)?;
        if catalog::find(&provider.id)?.is_some() {
            return Err(BrokerError::Invalid("id collides with the catalog".into()));
        }
        let json = serde_json::to_string(&provider)
            .map_err(|_| BrokerError::Invalid("custom provider is not serializable".into()))?;
        store::insert_custom_provider(
            &self.pool,
            &organization_id.to_string(),
            &provider.id,
            &json,
            created_by,
        )
        .await?;
        Ok(self.provider_view(&provider))
    }
}
