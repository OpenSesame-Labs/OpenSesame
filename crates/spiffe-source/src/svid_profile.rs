//! X.509-SVID profile checks shared with native transport verifiers.

// Keep this public path for source consumers while both layers use one validator.
pub use opensesame_transport_security::svid_profile::{
    presented_spiffe_id, validate_leaf, SvidExpectation, SvidFacts, SvidProfileError, SvidRole,
};

#[cfg(all(test, feature = "fake-workload-api"))]
#[path = "svid_profile_tests.rs"]
mod tests;
