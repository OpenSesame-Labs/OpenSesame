//! `let` renames that still point at the credentialed sync response receiver.

mod bind;
mod marker;
mod param;
mod peel;
mod tuple;
mod ufcs;

pub(crate) use bind::plain_name;
pub(crate) use ufcs::{
    args_track_response, method_receiver_is_response, response_into_read, strip_turbofish,
    ufcs_response_move, ufcs_type_is_response,
};

pub(super) const RESPONSE_RECEIVER_NAMES: &[&str] =
    &["response", "res", "upstream", "http_response", "body"];

pub(crate) fn tracks_response_receiver(source: &str, before: usize, name: String) -> bool {
    let mut current = name;
    let mut limit = before;
    // Follow bindings until a known receiver name, a parameter, an unbound
    // name, or a name already seen on this walk. The seen set is the cycle
    // guard: alias rings (`let a = b; let b = a;`) never resolve, and chains
    // longer than any fixed hop budget still reach their root.
    let mut seen: Vec<String> = Vec::new();
    loop {
        if RESPONSE_RECEIVER_NAMES
            .iter()
            .any(|receiver| receiver == &current)
        {
            return true;
        }
        if seen.iter().any(|visited| visited == &current) {
            return false;
        }
        seen.push(current.clone());
        let prefix = &source[..limit];
        let Some((next, at)) = bind::let_bind_rhs(prefix, &current) else {
            return param::param_is_response(prefix, &current);
        };
        // A hop that does not move earlier would re-read the same binding.
        if at >= limit {
            return false;
        }
        // `let reply = status` must not hide a later `|reply: Response|`.
        if let Some(is_response) = param::param_shadows_let(prefix, &current, at) {
            return is_response;
        }
        current = next;
        limit = at;
    }
}

#[cfg(test)]
mod tests;
