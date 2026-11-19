#[cfg(test)]
mod probes {
    use crate::tests::sync_target_pact_scan::response_body_reads;

    #[test]
    fn p5_url_and_content_length_are_metadata() {
        let hits = [
            "response.url().clone()",
            "response.content_length()",
            "let reply = response; reply.url()",
            "let reply = response; reply.content_length()",
            "(response).url()",
            "(&response).content_length()",
            "Response::url(&response)",
            "reqwest::Response::content_length(&response)",
            "<reqwest::Response>::url(&response)",
            "Response::url::<()>(&response)",
            "Response::content_length(&mut response)",
            "let f = Response::url;",
            "let f = response.content_length;",
            "let f = reqwest::Response::url;",
            "let f = <reqwest::Response>::content_length;",
            "fn log(mut reply: reqwest::Response) { reply.url() }",
            "let reply = { response }; reply.content_length()",
        ];
        for sample in hits {
            assert!(
                !response_body_reads(sample).is_empty(),
                "url and length are provider metadata: {sample}"
            );
        }
        let misses = [
            "request.url()",
            "parsed.content_length()",
            "Request::url(&request)",
            "let f = Request::url;",
            "let f = request.content_length;",
            "let status = response.status();",
            "format!(\"{:?}\", response.status())",
            "\"response.url()\"",
            "response.copy_topic()",
        ];
        for sample in misses {
            assert!(
                response_body_reads(sample).is_empty(),
                "request url is not response metadata: {sample}"
            );
        }
    }
}