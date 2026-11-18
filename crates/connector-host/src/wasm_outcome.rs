//! Fixed guest error classes, without provider-controlled values.

use super::{types, HostError};

pub(super) fn map_invoke_error(error: &types::InvokeError) -> HostError {
    let text = match error {
        types::InvokeError::InvalidInput(_) => "invalid-input",
        types::InvokeError::Unauthorized(_) => "unauthorized",
        types::InvokeError::ApprovalRequired(_) => "approval-required",
        types::InvokeError::RateLimited(_) => "rate-limited",
        types::InvokeError::ProviderError(_) => "provider-error",
        types::InvokeError::Transient(_) => "transient",
        types::InvokeError::Permanent(_) => "permanent",
    };
    HostError::Connector(text.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guest_error_strings_and_statuses_do_not_escape() {
        for error in [
            types::InvokeError::InvalidInput("1-ssecca-ecar".into()),
            types::InvokeError::ProviderError((599, "1-ssecca-ecar".into())),
            types::InvokeError::RateLimited(Some(123456)),
            types::InvokeError::Permanent("1-ssecca-ecar".into()),
        ] {
            let text = map_invoke_error(&error).to_string();
            assert!(!text.contains("1-ssecca-ecar"));
            assert!(!text.contains("599"));
            assert!(!text.contains("123456"));
        }
    }
}
