#[cfg(test)]
mod tests {
    use crate::tests::sync_target_pact_chain::{dispatch_alias_calls, response_chain_consumer};
    use crate::tests::sync_target_pact_scan::response_body_reads;

    #[test]
    fn typed_dispatch_aliases_register() {
        let source =
            "async fn f() { let dispatch: _ = reqwest::RequestBuilder::send; dispatch(r).await?; }";
        assert_eq!(dispatch_alias_calls(source).len(), 1);
    }

    #[test]
    fn renamed_bindings_still_chain_consume() {
        for sample in [
            "let reply = response; reply.count().await",
            "let mut reply = response; let again = reply; again.collect()",
        ] {
            assert!(
                response_chain_consumer(sample),
                "renamed response binding must consume: {sample}"
            );
        }
    }

    #[test]
    fn p5_rename_forms_are_body_reads() {
        let hits = [
            "fn steal(mut reply: reqwest::Response) { reply.into() }",
            "fn steal(mut reply: &mut reqwest::Response) { reply.into() }",
            "fn steal(mut reply: http::Response<Body>) { reply.into() }",
            "|mut reply: Response| reply.into()",
            "let reply = { response }; reply.into()",
            "let reply = { let _ = \";\"; response }; reply.into()",
            "let mut reply = other; reply = response; reply.into()",
            "let mut reply = other; reply = { response }; reply.into()",
            "let reply = response; reply.into::<reqwest::Body>()",
            "(response).into::<Body>()",
            "Body::from::<Vec<u8>>(response)",
            "<reqwest::Response as Into<Body>>::from(response)",
            "let f = <Response as Into<Body>>::from;",
            "let reply = response; dbg!(reply)",
            "let reply = response; dbg!((reply))",
            "let reply = response; format!(\"{:?}\", reply)",
            "let reply = response; format!(\"{:?}\", { reply })",
            "fn log(mut reply: reqwest::Response) { dbg!(reply); }",
            "fn log(mut reply: reqwest::Response) { format!(\"{reply:?}\"); }",
            "let mut reply = other; reply = response; format!(\"{:?}\", reply)",
        ];
        for sample in hits {
            assert!(
                !response_body_reads(sample).is_empty(),
                "renamed response must stay discarded: {sample}"
            );
        }
        let misses = [
            "fn steal(mut reply: Status) { reply.into() }",
            "let reply = { status }; reply.into()",
            "let mut reply = response; reply = status; reply.into()",
            "rows.into::<Vec<_>>()",
            "\"https\".into::<String>()",
            "<SyncTargetView as From<Row>>::from(row)",
            "let f = <Row as From<Status>>::from;",
            "dbg!(status)",
            "let reply = status; format!(\"{:?}\", reply)",
            "let reply = status; format!(\"{:?}\", { reply })",
            "SyncTargetView::from(row)",
        ];
        for sample in misses {
            assert!(
                response_body_reads(sample).is_empty(),
                "unrelated rename is not a body read: {sample}"
            );
        }
    }

    #[test]
    fn r4_sqlx_inside_a_string_does_not_hide_the_execute_send() {
        let hits = [
            "let reply = client.execute(request).expect(\"sqlx:: pool\"); reply.into()",
            "let reply = client.execute(\"https://sqlx::invalid\"); reply.into()",
            "let reply = xsqlx::Client::execute(request); reply.into()",
        ];
        for sample in hits {
            assert!(
                !response_body_reads(sample).is_empty(),
                "sqlx:: in a string or a longer ident is not SQLx: {sample}"
            );
        }
        let misses = [
            "let reply = sqlx::query(\"select 1\").execute(&pool); reply.into()",
            "let reply = sqlx::Pool::execute(&pool, query); reply.into()",
        ];
        for sample in misses {
            assert!(
                response_body_reads(sample).is_empty(),
                "a real sqlx:: code path excludes the execute: {sample}"
            );
        }
    }

    /// Eight plain bindings long, the chain must still reach `response`.
    /// Codex review: a fixed hop budget silently accepts aliases beyond it;
    /// cycle detection follows until a root or a repeat.
    #[test]
    fn codex_thread_response_alias_chain_uses_cycle_detection() {
        let hits = [
            "let r1 = response; let r2 = r1; let r3 = r2; let r4 = r3; let r5 = r4; let r6 = r5; let r7 = r6; let r8 = r7; let leaked: reqwest::Body = r8.into();",
            "let a1 = response; let a2 = a1; let a3 = a2; let a4 = a3; let a5 = a4; let a6 = a5; let a7 = a6; let a8 = a7; let a9 = a8; let a10 = a9; let a11 = a10; let a12 = a11; let leaked: reqwest::Body = a12.into();",
        ];
        for sample in hits {
            assert!(
                !response_body_reads(sample).is_empty(),
                "long alias chain must reach the response root: {sample}"
            );
        }
        // A binding ring never resolves to a receiver.
        let ring = "let a = b; let b = a; let leaked: reqwest::Body = a.into();";
        assert!(
            response_body_reads(ring).is_empty(),
            "alias ring is not a body read: {ring}"
        );
        let self_ring = "let a = a; let leaked: reqwest::Body = a.into();";
        assert!(
            response_body_reads(self_ring).is_empty(),
            "self-rebinding is not a body read: {self_ring}"
        );
    }

    /// `let reply = if selected { response } else { fallback };` — the
    /// conditional initializer aliases the response through either branch.
    #[test]
    fn codex_thread_conditional_initializer_aliases_response() {
        let hits = [
            "let reply = if selected { response } else { fallback }; let body: reqwest::Body = reply.into();",
            "let reply = if selected { fallback } else { response }; let body: reqwest::Body = reply.into();",
            "let reply = match selected { true => response, _ => fallback }; let body: reqwest::Body = reply.into();",
        ];
        for sample in hits {
            assert!(
                !response_body_reads(sample).is_empty(),
                "conditional initializer must keep the response: {sample}"
            );
        }
        let misses = [
            "let reply = if selected { status } else { fallback }; let body: reqwest::Body = reply.into();",
            "let reply = match selected { true => status, _ => fallback }; let body: reqwest::Body = reply.into();",
        ];
        for sample in misses {
            assert!(
                response_body_reads(sample).is_empty(),
                "conditional without the response is not a body read: {sample}"
            );
        }
    }

    /// `let reply = request.send().await?;` under an unrecognized name — the
    /// response root derives from the credentialed send expression.
    #[test]
    fn codex_thread_send_result_binding_names_derive_from_send() {
        let hits = [
            "let reply = request.send().await?; let leaked: reqwest::Body = reply.into();",
            "let wire = client.execute(request).await?; let leaked: reqwest::Body = wire.into();",
            "let reply = request.send().await?; let body = reply.text().await?;",
        ];
        for sample in hits {
            assert!(
                !response_body_reads(sample).is_empty(),
                "send result under any name stays discarded: {sample}"
            );
        }
        let misses = ["let reply = request.send(); let leaked = other.into();"];
        for sample in misses {
            assert!(
                response_body_reads(sample).is_empty(),
                "unmoved send is not a body read: {sample}"
            );
        }
    }

    /// `try_into()` / `TryFrom::try_from` move the provider body through the
    /// blanket conversion the same way `.into()` does.
    #[test]
    fn codex_thread_try_into_response_conversions() {
        let hits = [
            "let leaked: reqwest::Body = response.try_into().unwrap();",
            "let leaked: reqwest::Body = response.try_into()?;",
            "TryFrom::try_from(response)",
            "TryInto::try_into(response).unwrap()",
            "let reply = response; let leaked: reqwest::Body = reply.try_into().unwrap();",
            "std::convert::TryFrom::try_from(response)",
        ];
        for sample in hits {
            assert!(
                !response_body_reads(sample).is_empty(),
                "fallible conversion moves the body: {sample}"
            );
        }
        let misses = [
            "let leaked: reqwest::Body = status.try_into().unwrap();",
            "TryFrom::try_from(status)",
        ];
        for sample in misses {
            assert!(
                response_body_reads(sample).is_empty(),
                "unrelated fallible conversion is not a body read: {sample}"
            );
        }
    }
}
