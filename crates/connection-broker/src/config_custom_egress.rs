//! Deployment-owned custom egress and redirect configuration.

use super::{BrokerConfig, CustomEgressPolicy};

impl BrokerConfig {
    #[must_use]
    pub fn with_github_api_base(mut self, base: impl Into<String>) -> Self {
        self.github_api_base = Some(base.into());
        self
    }

    #[must_use]
    pub fn with_redirect_allowlist(mut self, origins: Vec<String>) -> Self {
        self.redirect_allowlist = origins;
        self
    }

    /// Configure operator-approved private custom-provider origins and
    /// cross-origin OAuth token endpoints. Every value must be an HTTPS origin.
    ///
    /// # Errors
    ///
    /// Returns an error for an invalid origin.
    pub fn with_custom_egress_origins(
        mut self,
        private_origins: &[String],
        token_origins: &[String],
    ) -> crate::Result<Self> {
        self.custom_egress = CustomEgressPolicy::new(private_origins, token_origins)?;
        Ok(self)
    }

    pub(crate) fn custom_egress(&self) -> &CustomEgressPolicy {
        &self.custom_egress
    }
}
