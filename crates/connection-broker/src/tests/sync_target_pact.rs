//! Pact contracts for credentialed sync egress.
//!
//! These tests scan production `sync_target.rs` only. They live outside that
//! file so the scanner cannot treat its own patterns as production code.

use super::sync_target_pact_https::credentialed_send_https_gaps;
use super::sync_target_pact_scan::{response_body_reads, sync_target_production_for_scan};
use crate::sync_target::env_sync_provider_supported;

fn assert_body_read(sample: &str) {
    let reads = response_body_reads(sample);
    assert!(
        !reads.is_empty(),
        "credentialed sync response bodies must remain discarded: {sample} -> {reads:?}"
    );
}

fn assert_no_body_read(sample: &str) {
    let reads = response_body_reads(sample);
    assert!(
        reads.is_empty(),
        "request builder json is not a response body read: {sample} -> {reads:?}"
    );
}

#[test]
fn property_only_vercel_and_railway_are_live_env_sync() {
    for id in ["vercel", "railway"] {
        assert!(env_sync_provider_supported(id), "{id}");
    }
}

#[test]
fn adversarial_catalog_craft_bar_ids_are_refused() {
    for id in ["doppler", "infisical", "vault", "aws", "github", ""] {
        assert!(!env_sync_provider_supported(id), "{id}");
    }
}

#[test]
fn chaos_interleaved_checks_stay_fail_closed() {
    let ids = ["doppler", "vercel", "infisical", "railway", "doppler"];
    let allowed: Vec<_> = ids
        .iter()
        .copied()
        .filter(|id| env_sync_provider_supported(id))
        .collect();
    assert_eq!(allowed, ["vercel", "railway"]);
}

#[test]
fn contract_sync_target_test_cfg_is_only_trailing_unit_tests() {
    let src = include_str!("../sync_target.rs");
    assert_eq!(
        src.matches("#[cfg(test)]").count(),
        1,
        "sync_target.rs must contain exactly one #[cfg(test)]"
    );
    let after_cfg = src.split_once("#[cfg(test)]").expect("cfg").1;
    assert!(
        after_cfg.starts_with("\nmod unit_tests"),
        "the only #[cfg(test)] must start with mod unit_tests"
    );
    let production = sync_target_production_for_scan(src);
    assert!(!production.contains("#[cfg(test)]"));
    assert!(production.contains("response.status()"));
    assert!(production.contains("request.json(&body)"));
    assert!(production.contains("drop(response)"));
}

#[test]
fn contract_https_egress_guard_is_in_source_before_send() {
    // `../sync_target.rs` is production plus its `#[cfg(test)]` unit tests.
    // The split drops those tests. This module is not in that file, so its
    // UFCS patterns (`::text(`, `::bytes(`, ...) cannot satisfy the scan.
    // Every credentialed dispatch must see `scheme() != "https"` earlier in
    // its own function. The error string alone is not that guard.
    let production = sync_target_production_for_scan(include_str!("../sync_target.rs"));
    let (sends, missing) = credentialed_send_https_gaps(&production);
    assert!(sends >= 1, "credentialed sync must send");
    assert_eq!(missing, 0, "unguarded credentialed sends: {missing}");
    assert!(
        super::sync_target_pact_p5::egress_sources_disable_redirects(),
        "credentialed egress client must set redirect::Policy::none()"
    );
    assert_no_body_read(&production);
}

#[test]
fn contract_each_credentialed_send_needs_its_own_https_guard() {
    let guarded = r#"
        async fn http_provider_json() {
            if parsed.scheme() != "https" {
                return Err("sync egress requires https".into());
            }
            let response = request.send().await?;
            let _ = request./* second */send().await?;
            drop(response);
        }
    "#;
    let (sends, missing) = credentialed_send_https_gaps(guarded);
    assert_eq!((sends, missing), (2, 0));

    let later_function = r#"
        async fn first() {
            if parsed.scheme() != "https" {
                return Err("sync egress requires https".into());
            }
            let _ = request.send().await?;
        }
        async fn second() {
            let _ = request.send().await?;
        }
    "#;
    let (sends, missing) = credentialed_send_https_gaps(later_function);
    assert_eq!((sends, missing), (2, 1));

    let comment_guard = r"
        async fn sneaky() {
            // sync egress requires https
            let _ = request.send().await?;
        }
    ";
    let (sends, missing) = credentialed_send_https_gaps(comment_guard);
    assert_eq!((sends, missing), (1, 1));

    let string_send = r#"
        async fn quoted() {
            let _ = "request.send() and sync egress requires https";
        }
    "#;
    assert_eq!(credentialed_send_https_gaps(string_send), (0, 0));
}

#[test]
fn contract_production_scan_drops_the_trailing_unit_test_block() {
    let src =
        "fn prod() {}\n#[cfg(test)]\nmod unit_tests {\n    fn hides() { response.text(); }\n}\n";
    let production = sync_target_production_for_scan(src);
    assert_eq!(production, "fn prod() {}\n");
    assert_no_body_read(&production);
    assert_body_read(src);
}

#[test]
fn contract_code_after_unit_tests_stays_in_the_scan() {
    let hidden = "fn prod() {}\n#[cfg(test)]\nmod unit_tests {\n    fn hides() { response.text(); }\n}\nfn after() { let f = Client::execute; f(request); response.text(); }\n";
    let production = sync_target_production_for_scan(hidden);
    assert!(production.contains("fn after()") && !production.contains("fn hides()"));
    assert_body_read(&production);
    assert_eq!(credentialed_send_https_gaps(&production), (1, 1));
    let later = "fn prod() {}\n#[cfg(test)]\nmod unit_tests {\n    fn hides() { let _ = \"{\"; }\n    // }\n}\n#[cfg(test)]\nfn tucked() { response.copy_to(&mut b); }\nfn after() { response.bytes(); }\n";
    let production = sync_target_production_for_scan(later);
    assert!(production.contains("tucked") && production.contains("fn after()"));
    assert!(!production.contains("fn hides()"));
    assert_body_read(&production);
    let open = "fn prod() {}\n#[cfg(test)]\nmod unit_tests {\nfn after() { response.bytes(); }\n";
    assert_body_read(&sync_target_production_for_scan(open));
}

/// UFCS and aliased `Response as RequestBuilder` stay body reads.
#[test]
fn contract_ufcs_and_aliased_request_builder_are_body_reads() {
    for sample in [
        "Response::text(response).await",
        "reqwest::Response::bytes(response).await",
        "Response::json(response).await",
        "Response::json::<serde_json::Value>(response).await",
        "reqwest::Response::json::<serde_json::Value>(response).await",
        "Response::chunk(&mut response).await",
        "Response::bytes_stream(response)",
        "Response::text_with_charset(response, \"utf-8\").await",
        "<reqwest::Response>::text(response).await",
        "http::Response::chunk(&mut response).await",
        "Response :: bytes (response).await",
        "Response\n    ::text(response).await",
        "request = request.json(&body);\nlet t = Response::text(response).await;",
        "use reqwest::Response as Resp;\nResp::text(response).await",
        "use reqwest::Response as RequestBuilder;\nRequestBuilder::json::<serde_json::Value>(response).await",
        "use reqwest::Response as RequestBuilder;\nRequestBuilder::json(request, extra).await",
        "use reqwest::Response as RequestBuilder;\nRequestBuilder::json(request, &body).await",
        "use reqwest::Response as RequestBuilder;\nRequestBuilder::json(&request, &body).await",
        "use reqwest::Response as RequestBuilder;\nRequestBuilder::json::<serde_json::Value>(request, &body).await",
        "RequestBuilder::json(request, &body)",
        "RequestBuilder::json(&request, &body)",
        "notreqwest::RequestBuilder::json(request, &body)",
        "notreqwest::RequestBuilder::json(&request)",
        "RequestBuilder::json(&response).await",
        "reqwest::RequestBuilder::json::<Value>(&response).await",
        "reqwest::RequestBuilder::json(response).await",
        "reqwest::RequestBuilder::json(request).await",
        "RequestBuilder::json(response)",
        "foo::<RequestBuilder>::json(request, &body)",
        "foo::<RequestBuilder>::json(response).await",
        "fn takes(builder: reqwest::RequestBuilder) { Response::json(response).await }",
        "reqwest::RequestBuilder::json(request, &body); foo::<RequestBuilder>::json(request, &body)",
        "Vec<RequestBuilder>::json(request, &body)",
        "let _ = reqwest::RequestBuilder::json(request, &body);\nResponse::json(response).await",
        "reqwest::RequestBuilder::json(request, &body); <reqwest::Response>::text(response)",
    ] {
        assert_body_read(sample);
    }
}

/// Function items are reads. `request.json` is not exempted here.
#[test]
fn contract_body_function_items_are_reads() {
    for sample in [
        "let f = Response::text;\nf(response).await",
        "let f = reqwest::Response::bytes;\nf(response).await",
        "let f = Response::json;\nf(response).await",
        "let f = response.text;\nf().await",
        "[Response::text, other]",
        "use reqwest::Response as RequestBuilder;\nlet f = RequestBuilder::text;\nf(response).await",
        "let _f = Response::text as fn(&Response) -> _;",
        "let request = response;\nlet f = request.text;\nf().await",
        "let request = response;\nlet f = request.json;\nf(request).await",
        "let f = request.json;",
        "let f = request.json::<Value>;",
        "request = request.json(&body);\nlet f = request.json;",
        "let f = reqwest::RequestBuilder::json;",
        "let f = <RequestBuilder>::json;",
        "use serde_json::json;\nlet parse = reqwest::Response::json;",
        "use serde_json::json;\nlet value = response.json().await;",
    ] {
        assert_body_read(sample);
    }
}

#[test]
fn contract_stream_consumption_is_a_body_read() {
    for sample in [
        "response.next().await",
        "response.try_next().await?",
        "response.poll_next(cx)",
        "response.poll_next_unpin(cx)",
        "poll_fn(|cx| response.poll_next_unpin(cx)).await",
        "TryStreamExt::try_poll_next_unpin(response, cx)",
        "http_response.for_each(|_| async {})",
        "StreamExt::for_each(response, |_| async {})",
        "futures::StreamExt::for_each(response, |_| async {})",
        "upstream.fold(0, |a, _| async move { a })",
        "res.try_fold(0, |a, b| async move { Ok(a + b) })",
        "futures::StreamExt::next(&mut response).await",
        "TryStreamExt::try_collect(response)",
        "body.try_collect()",
        "let _ = response.collect().await;",
        "res.collect()",
        "upstream.collect()",
        "http_response.collect()",
        "body.collect()",
        "(&mut response).collect()",
        "response.count()",
        "res.last()",
        "upstream.any(|_| true)",
        "http_response.find(|_| true)",
        "body.partition(|_| true)",
        "response.concat()",
        "response.try_for_each(|_| async { Ok(()) })",
        "StreamExt::count(response)",
        "StreamExt::count(&mut response)",
        "futures::StreamExt::count(&mut response)",
        "StreamExt::count::<usize>(&mut response)",
        "TryStreamExt::try_for_each(response, |_| async { Ok(()) })",
        "response.map(|b| b).collect()",
        "response.filter(|_| true).take(1).collect()",
        "response.bytes_stream().map(|c| c).collect()",
        "(&mut response).map(|x| x).collect()",
        "res.inspect(|_| {}).count()",
        "upstream.filter_map(|x| x).any(|_| true)",
        "response.map(|_| \")\").collect()",
        "read_bounded_body(&mut response, 1024)",
        "response_guard::read_bounded_body(&mut response, cap)",
        "crate::response_guard::read_bounded_body(&mut response, 1024)",
        "use crate::response_guard::read_bounded_body as consume;\nconsume(&mut response, cap).await?",
        "use crate::response_guard::{read_bounded_body as consume};\nconsume(&mut response, cap)",
        "use crate::response_guard as rg;\nrg::helper(&mut response)",
        "use crate::{response_guard::read_bounded_body as consume};\nconsume(&mut response, 1)",
        "use foo::read_bounded_body as consume;\nconsume(&mut response, 1)",
        "use crate::response_guard::{self as rg, read_bounded_body as consume};\nrg::helper()",
        "use crate::response_guard::safe_oauth_error_detail as detail;\ndetail(&err)",
        "use crate::response_guard::read_bounded_body as consume;\nlet f = consume;\nf(&mut response, cap)",
    ] {
        assert_body_read(sample);
    }
}

/// `request.json(&body)` and qualified builder UFCS stay legal.
#[test]
fn contract_request_builder_json_is_not_a_body_read() {
    for sample in [
        "request = request.json(&body);",
        "request\n    .json(&body);",
        "request.json::<serde_json::Value>(&body)",
        "let _ = self.request.json(&body);",
        "let status = response.status();",
        "request = request.json(&body);\nlet response = request.send().await?;\nlet status = response.status();\ndrop(response);",
        "reqwest::RequestBuilder::json(request, &body)",
        "reqwest::RequestBuilder::json::<serde_json::Value>(request, &body)",
        "<RequestBuilder>::json(request, &body)",
        "<RequestBuilder>::json(&request, &body)",
        "reqwest::RequestBuilder::json(&request)",
        "reqwest::RequestBuilder::json(&request, &body)",
        "<reqwest::RequestBuilder>::json(request, &body)",
        "< RequestBuilder >::json( request , & body )",
        "reqwest :: RequestBuilder :: json ( request , & body )",
        "serde_json::json!({})",
        "use serde_json::{json, Value};",
        "use serde_json::Value as Json;\nlet status = response.status();",
        "let _ = \"use serde_json::Value as Json\";\nlet status = response.status();",
        "use serde_json::json;",
        "use serde_json::json;\nlet status = response.status();",
        "let rows: Vec<_> = items.into_iter().collect();",
        "allow.into_iter().collect()",
        "somebody.collect()",
        "myresponse.collect()",
        "provider.operations.iter().any(|op| op == operation)",
        "rows.into_iter().map(SyncTargetView::from).collect()",
        "entries.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect()",
        "let url = \"https://example.com\";\nlet status = response.status();",
        "/* response.text() */ let status = response.status();",
        "reqwest::RequestBuilder::/* builder */json(request, &body)",
        "reqwest::RequestBuilder::r#json(request, &body)",
        "/* response.copy_to(&mut buffer) */ let status = response.status();",
        "response.copy_topic()",
        "response.copy_to_string()",
        "Response::copy_to_end(response)",
    ] {
        assert_no_body_read(sample);
    }
}

#[test]
fn contract_response_into_and_headers_are_body_reads() {
    for sample in [
        "let leaked = response.into();",
        "let leaked = (response).into();",
        "let body: reqwest::Body = res.into();",
        "response.headers().get(\"X-Secret\")",
        "res.headers().iter().next()",
        "let reply = response; reply.into()",
        "let reply = (response); reply.into()",
        "let reply: reqwest::Response = (response); reply.into()",
        "fn steal(r: reqwest::Response) -> reqwest::Body { r.into() }",
    ] {
        assert_body_read(sample);
    }
}

#[test]
fn contract_comments_and_raw_idents_are_body_reads() {
    for sample in [
        "response./* read body */text().await",
        "response./* read */bytes().await",
        "response // hide\n.text().await",
        "Response::/*c*/text(response)",
        "response./* outer /* inner */ still */text()",
        "response.r#text().await",
        "response.r#bytes().await",
        "Response::r#bytes(response).await",
        "r#response.text().await",
        "r#response.r#json::<serde_json::Value>().await",
        "response.r#json(&body)",
        "let url = \"https://example.com\";\nresponse.text()",
        "let url = r#\"https://example.com\"#;\nresponse./*c*/text()",
    ] {
        assert_body_read(sample);
    }
}

/// `Response::copy_to` consumes the provider body into a writer.
#[test]
fn contract_copy_to_is_a_body_read() {
    for sample in [
        "response.copy_to(&mut buffer).await?",
        "res.copy_to(&mut out)",
        "(&mut response).copy_to(&mut buffer)",
        "Response::copy_to(response, &mut buffer).await",
        "reqwest::Response::copy_to(response, &mut buffer)",
        "<reqwest::Response>::copy_to(&mut response, &mut buffer)",
        "Response::copy_to::<Vec<u8>>(response, &mut buffer)",
        "response.copy_to::<Vec<u8>>(&mut buffer)",
        "let f = Response::copy_to;\nf(response, &mut buffer)",
        "let f = response.copy_to;",
        "let f = reqwest::Response::copy_to;",
        "[Response::copy_to, other]",
        "response./* body */copy_to(&mut buffer)",
        "response.r#copy_to(&mut buffer)",
        "Response::r#copy_to(response, &mut buffer)",
        "Response\n    ::copy_to(response, &mut buffer)",
        "use reqwest::Response as Resp;\nResp::copy_to(response, &mut buffer)",
        "let _f = Response::copy_to as fn(&mut Response, &mut Vec<u8>) -> _;",
        "let f = Response::copy_to::<Vec<u8>>;",
    ] {
        assert_body_read(sample);
    }
}
