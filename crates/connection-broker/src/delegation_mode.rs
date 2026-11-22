//! Stored execution modes are an authority boundary, not a default.

use super::OfferItemSpec;
use crate::error::{BrokerError, Result};
use opensesame_relay::ExecutionMode;

pub(super) fn execution_mode_str(mode: ExecutionMode) -> &'static str {
    match mode {
        ExecutionMode::Broker => "broker",
        ExecutionMode::Relay => "relay",
    }
}

pub(crate) fn parse_execution_mode(raw: &str) -> Result<ExecutionMode> {
    match raw {
        "relay" => Ok(ExecutionMode::Relay),
        "broker" => Ok(ExecutionMode::Broker),
        _ => Err(BrokerError::InvalidState),
    }
}

pub(super) fn require_mint_modes(items: &[OfferItemSpec]) -> Result<()> {
    for item in items {
        require_claimable_mode(item.execution_mode)?;
    }
    Ok(())
}

pub(super) fn require_claimable_mode(mode: ExecutionMode) -> Result<ExecutionMode> {
    match mode {
        ExecutionMode::Relay => Ok(mode),
        ExecutionMode::Broker => Err(BrokerError::DelegationUnavailable),
    }
}
