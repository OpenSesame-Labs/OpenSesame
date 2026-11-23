//! Guest-selected error details and categories are not trusted output.

use super::{types, HostError};

pub(super) fn map_invoke_error(_error: &types::InvokeError) -> HostError {
    HostError::Connector("guest operation failed".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guest_error_strings_statuses_and_categories_do_not_escape() {
        let errors = [
            types::InvokeError::InvalidInput("1-ssecca-ecar".into()),
            types::InvokeError::Unauthorized("1-ssecca-ecar".into()),
            types::InvokeError::ApprovalRequired("1-ssecca-ecar".into()),
            types::InvokeError::ProviderError((599, "1-ssecca-ecar".into())),
            types::InvokeError::RateLimited(Some(123456)),
            types::InvokeError::Transient("1-ssecca-ecar".into()),
            types::InvokeError::Permanent("1-ssecca-ecar".into()),
        ];
        for error in errors {
            assert_eq!(
                map_invoke_error(&error),
                HostError::Connector("guest operation failed".into())
            );
        }
    }
}
