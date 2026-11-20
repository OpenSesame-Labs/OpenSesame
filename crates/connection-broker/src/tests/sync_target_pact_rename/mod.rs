//! `let` renames that still point at the credentialed sync response receiver.

mod bind;
mod marker;
mod peel;
mod ufcs;

pub(crate) use bind::{plain_name, read_ident_at};
pub(crate) use ufcs::{
    args_track_response, method_receiver_is_response, response_into_read, strip_turbofish,
    ufcs_response_move, ufcs_type_is_response,
};

pub(super) const RESPONSE_RECEIVER_NAMES: &[&str] =
    &["response", "res", "upstream", "http_response", "body"];

pub(crate) fn tracks_response_receiver(source: &str, before: usize, name: String) -> bool {
    let mut current = name;
    let mut limit = before;
    for _ in 0..8 {
        if RESPONSE_RECEIVER_NAMES
            .iter()
            .any(|receiver| receiver == &current)
        {
            return true;
        }
        let prefix = &source[..limit];
        let Some((next, at)) = bind::let_bind_rhs(prefix, &current) else {
            return bind::param_is_response(prefix, &current);
        };
        // A hop that does not move earlier would re-read the same binding.
        if at >= limit {
            return false;
        }
        current = next;
        limit = at;
    }
    false
}

#[cfg(test)]
mod tests;
