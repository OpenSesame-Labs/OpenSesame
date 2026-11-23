//! The fenced dispatch half of [`Invoker`]: response-side controls.

use super::*;

impl Invoker {
    /// Send a credentialed request and read the answer through every fence on
    /// the way back: allowlisted headers, the body cap, the timeout, and the
    /// reflection scrub over each needle.
    pub(crate) async fn dispatch(
        &self,
        request: hyper::Request<Full<Bytes>>,
        needles: &[Needles],
        prepared: PreparedRequest,
        started: Instant,
    ) -> Result<InvokeResponse, InvokeError> {
        let response = match tokio::time::timeout(self.timeout, self.client.request(request)).await
        {
            Ok(Ok(response)) => response,
            Ok(Err(error)) => return Err(InvokeError::Transport(error.to_string())),
            Err(_) => return Err(InvokeError::Timeout),
        };
        let status = response.status().as_u16();
        // Built before anything upstream sent is read: every header and the
        // body pass through it on the way back (ADR 0150 §4).
        let mut credential_reflected = false;
        let headers = response
            .headers()
            .iter()
            .filter(|(name, _)| {
                RESPONSE_HEADER_ALLOWLIST.contains(&name.as_str().to_ascii_lowercase().as_str())
            })
            .filter_map(|(name, value)| {
                let (value, hit) = scrub_all(needles, value.to_str().ok()?.to_string());
                credential_reflected |= hit;
                Some((name.as_str().to_string(), value))
            })
            .collect();
        // A 3xx is data, not an instruction: it is returned exactly like any
        // other status. The client follows nothing on its own.
        let body = match tokio::time::timeout(
            self.timeout,
            Limited::new(response.into_body(), self.response_body_cap).collect(),
        )
        .await
        {
            Ok(Ok(collected)) => collected.to_bytes(),
            Ok(Err(error)) => {
                // Limited boxes its errors: LengthLimitError means the cap was
                // hit; anything else is the underlying body read failing (e.g.
                // a truncated mid-body EOF), which is a transport fault.
                if error
                    .downcast_ref::<http_body_util::LengthLimitError>()
                    .is_some()
                {
                    return Err(InvokeError::ResponseTooLarge {
                        cap: self.response_body_cap,
                    });
                }
                return Err(InvokeError::Transport(error.to_string()));
            }
            Err(_) => return Err(InvokeError::Timeout),
        };
        let (body, body_reflected) = scrub_needles(body, needles);
        credential_reflected |= body_reflected;
        Ok(InvokeResponse {
            status,
            headers,
            body,
            receipt: ReceiptMeta {
                provider_id: prepared.provider_id,
                scheme: prepared.scheme,
                host: prepared.host,
                path: prepared.path,
                status,
                latency_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
                subject: prepared.subject,
                actor: prepared.actor,
                credential_reflected,
            },
        })
    }
}
