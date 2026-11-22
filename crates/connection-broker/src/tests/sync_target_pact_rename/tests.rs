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
}
