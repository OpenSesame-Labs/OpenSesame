//! Probes for response-receiver chain consumption: stream terminators,
//! comments between chain links, and `.await` peeling.
use super::super::sync_target_pact_scan::response_body_reads;

fn reads(sample: &str) -> bool {
    !response_body_reads(sample).is_empty()
}

#[test]
fn p5_streamext_place_receivers_are_body_reads() {
    for sample in [
        "StreamExt::map(response.clone(), |b| b).collect()",
        "StreamExt::map(self.response, |b| b).collect()",
        "StreamExt::map(response.by_ref(), |b| b).collect()",
        "futures::StreamExt::map((&mut response).clone(), |b| b).collect()",
    ] {
        assert!(reads(sample), "{sample}");
    }
    assert!(!reads(
        "rows.into_iter().map(SyncTargetView::from).collect()"
    ));
    assert!(!reads("StreamExt::map(rows.clone(), |b| b).collect()"));
}

#[test]
fn council_p1_comment_between_dot_and_method_is_a_body_read() {
    let hits = [
        "response.map(|b| b)./*c*/collect()",
        "response.map(|b| b)./*c*/collect::<Vec<_>>",
        "response./*c*/map(|b| b).collect()",
        "response.map(|b| b)?./*c*/collect()",
        "response.map(|b| b).await./*c*/count()",
        "response.map(|b| b)/*c*/.collect()",
    ];
    for sample in hits {
        assert!(
            super::response_chain_consumer(sample),
            "comment must not hide a response chain: {sample}"
        );
        assert!(reads(sample), "{sample}");
    }
    let misses = [
        "rows.map(|b| b)./*c*/collect()",
        "rows./*c*/into_iter().collect()",
        "\"response.map(|b| b).collect()\"",
    ];
    for sample in misses {
        assert!(
            !super::response_chain_consumer(sample),
            "unrelated chain is not a response read: {sample}"
        );
        assert!(!reads(sample), "{sample}");
    }
}

/// `fold` / `try_fold` / `try_collect` / `try_for_each` / `all` / `nth`
/// drain the body like `collect`: a response-rooted chain is a body read.
#[test]
fn chunk02_consuming_terminators_extend_response_chains() {
    for sample in [
        "response.map(|b| b).fold(0, |acc, b| acc + b)",
        "response.map(|b| b).try_fold(0, |acc, b| Ok(acc + b))",
        "response.map(|b| b).try_collect::<Vec<_>>()",
        "response.map(|b| b).try_for_each(|b| Ok(()))",
        "response.map(|b| b).all(|b| b.is_ok())",
        "response.map(|b| b).nth(2)",
        "response.map(|b| b).await.nth(2)",
    ] {
        assert!(
            super::response_chain_consumer(sample),
            "terminator must read the body: {sample}"
        );
        assert!(reads(sample), "{sample}");
    }
    for sample in [
        "rows.map(|b| b).fold(0, |acc, b| acc + b)",
        "rows.map(|b| b).nth(2)",
    ] {
        assert!(!super::response_chain_consumer(sample), "{sample}");
        assert!(!reads(sample), "{sample}");
    }
}

/// `position` / `find_map` / `sum` / `max` and the other search, numeric,
/// and comparison terminators drain the stream like `collect`: a
/// response-rooted chain ending in one of them is a body read
/// (GLM council chunk02).
#[test]
fn chunk02_search_numeric_and_comparison_terminators_extend_chains() {
    for sample in [
        "response.map(|b| b).position(|b| b.ok)",
        "response.map(|b| b).find_map(|b| Some(b))",
        "response.map(|b| b).sum::<usize>()",
        "response.map(|b| b).product()",
        "response.map(|b| b).max()",
        "response.map(|b| b).min_by_key(|b| b)",
        "response.map(|b| b).reduce(|a, b| a)",
        "response.map(|b| b).eq(other)",
        "response.map(|b| b).unzip()",
        "response.map(|b| b).for_each(|b| {})",
    ] {
        assert!(
            super::response_chain_consumer(sample),
            "terminator must read the body: {sample}"
        );
        assert!(reads(sample), "{sample}");
    }
    for sample in [
        "rows.map(|b| b).position(|b| b.ok)",
        "rows.map(|b| b).sum::<usize>()",
        "rows.map(|b| b).max()",
    ] {
        assert!(!super::response_chain_consumer(sample), "{sample}");
        assert!(!reads(sample), "{sample}");
    }
}

/// `end - 6` can land inside a multibyte ident, which panics a plain
/// `str` slice: `.get` stays safe and still strips a real `.await`.
#[test]
fn chunk02_await_check_handles_multibyte_boundary() {
    let sample = "ab.éawait.x";
    let dot = sample.rfind('.').expect("chain dot");
    assert_eq!(super::skip_chain_postfix(sample, dot), dot);
    let plain = "resp.await.x";
    let at = plain.rfind('.').expect("chain dot");
    assert_eq!(super::skip_chain_postfix(plain, at), 4);
}
