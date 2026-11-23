//! The settle route's outcome check (`outcome.rs`).

use super::*;

/// The driver's JSON as the settle route decodes it, then judged.
fn canonical(request_json: &str, outcome: &Value) -> Result<Value, Refusal> {
    super::canonical(request_json, &DriverOutcome::of(outcome))
}

fn step(tag: &str) -> String {
    json!({"step": tag}).to_string()
}

#[test]
fn each_step_accepts_its_own_outcome_canonically() {
    let cases = [
        ("navigate", json!({"outcome": "done"})),
        ("wait_for", json!({"outcome": "done"})),
        ("submit", json!({"outcome": "done"})),
        (
            "fill_credential",
            json!({"outcome": "filled", "filled": "Ok"}),
        ),
        (
            "assert_present",
            json!({"outcome": "presence", "presence": "Present"}),
        ),
        (
            "verify_login",
            json!({"outcome": "verified", "verified": "Works"}),
        ),
        (
            "read_dom_redacted",
            json!({"outcome": "dom", "text": "hi", "epoch": 3}),
        ),
        (
            "screenshot_redacted",
            json!({"outcome": "frame", "image": [1, 2], "epoch": 3, "masked_boxes": 1}),
        ),
        (
            "capture_credential",
            json!({"outcome": "captured", "sealed": {"recipient": "r", "envelope": "e"}}),
        ),
        (
            "capture_download",
            json!({"outcome": "captured", "sealed": {"recipient": "r", "envelope": "e"}}),
        ),
        ("generate_candidate", json!({"outcome": "done"})),
        (
            "seal_candidate",
            json!({"outcome": "sealed", "backed_up": true}),
        ),
        ("promote_candidate", json!({"outcome": "done"})),
    ];
    for (tag, outcome) in cases {
        assert_eq!(
            canonical(&step(tag), &outcome),
            Ok(outcome.clone()),
            "{tag}"
        );
    }
}

/// Every request the executor can queue has an answer in the table, so a
/// new `StepRequest` variant cannot ship with a settle route that refuses
/// every outcome for it.
#[test]
fn every_queueable_step_has_an_expected_outcome() {
    use opensesame_rotation_web::StepRequest as R;
    let requests = [
        R::Navigate { url: String::new() },
        R::WaitFor {
            selector: String::new(),
        },
        R::FillCredential {
            reference: String::new(),
            selector: String::new(),
        },
        R::AssertPresent {
            reference: String::new(),
            selector: String::new(),
        },
        R::Submit {
            selector: String::new(),
        },
        R::ReadDomRedacted { strip: vec![] },
        R::ScreenshotRedacted {
            epoch: 0,
            mask_selectors: vec![],
        },
        R::VerifyLogin {
            reference: String::new(),
        },
        R::CaptureCredential {
            slot: String::new(),
            selector: String::new(),
            recipient: String::new(),
        },
        R::CaptureDownload {
            slot: String::new(),
            content_type: String::new(),
            recipient: String::new(),
        },
    ];
    for request in requests {
        let tag = serde_json::to_value(&request).unwrap()["step"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(answers(&tag).is_some(), "{tag}");
    }
    for tag in [GENERATE_STEP, SEAL_STEP, PROMOTE_STEP] {
        assert!(answers(tag).is_some() && is_custody(tag), "{tag}");
    }
}

#[test]
fn a_failure_answers_any_step() {
    let failed = json!({"outcome": "failed", "error": "timeout"});
    for tag in [
        "navigate",
        "read_dom_redacted",
        "seal_candidate",
        "capture_credential",
    ] {
        assert_eq!(canonical(&step(tag), &failed), Ok(failed.clone()), "{tag}");
    }
}

#[test]
fn a_field_the_outcome_does_not_have_is_refused_at_any_depth() {
    let extra = [
        ("navigate", json!({"outcome": "done", "password": "x"})),
        (
            "generate_candidate",
            json!({"outcome": "done", "candidate": "x"}),
        ),
        (
            "read_dom_redacted",
            json!({"outcome": "dom", "text": "t", "epoch": 1, "note": "x"}),
        ),
        (
            "seal_candidate",
            json!({"outcome": "sealed", "backed_up": true, "value": "x"}),
        ),
        (
            "navigate",
            json!({"outcome": "failed", "error": "timeout", "detail": "x"}),
        ),
        (
            "capture_credential",
            json!({"outcome": "captured", "sealed": {"recipient": "r", "envelope": "e", "plaintext": "x"}}),
        ),
    ];
    for (tag, outcome) in extra {
        assert_eq!(
            canonical(&step(tag), &outcome),
            Err(Refusal::Malformed),
            "{outcome}"
        );
    }
}

#[test]
fn an_outcome_that_does_not_answer_the_step_is_refused() {
    assert_eq!(
        canonical(
            &step("navigate"),
            &json!({"outcome": "dom", "text": "t", "epoch": 1})
        ),
        Err(Refusal::WrongOutcome)
    );
    assert_eq!(
        canonical(&step("assert_present"), &json!({"outcome": "done"})),
        Err(Refusal::WrongOutcome),
        "a bare done is not a presence check passing"
    );
    assert_eq!(
        canonical(
            &step("capture_credential"),
            &json!({"outcome": "filled", "filled": "Ok"})
        ),
        Err(Refusal::WrongOutcome)
    );
    // A custody outcome never answers a browser step, and the reverse.
    assert_eq!(
        canonical(
            &step("submit"),
            &json!({"outcome": "sealed", "backed_up": true})
        ),
        Err(Refusal::WrongOutcome)
    );
    assert_eq!(
        canonical(&step("seal_candidate"), &json!({"outcome": "done"})),
        Err(Refusal::WrongOutcome)
    );
}

#[test]
fn what_is_not_an_outcome_at_all_is_refused() {
    for outcome in [
        json!(null),
        json!("done"),
        json!([]),
        json!({}),
        json!({"outcome": 3}),
        json!({"outcome": "done", "outcome2": 1}),
    ] {
        assert!(canonical(&step("navigate"), &outcome).is_err(), "{outcome}");
    }
    assert_eq!(
        canonical(
            &step("read_dom_redacted"),
            &json!({"outcome": "dom", "text": "t"})
        ),
        Err(Refusal::Malformed),
        "a missing field is not an outcome either"
    );
}

#[test]
fn a_request_the_table_does_not_know_has_no_acceptable_outcome() {
    for request in [
        "not json",
        "{}",
        r#"{"step": 3}"#,
        r#"{"step": "teleport"}"#,
    ] {
        assert_eq!(
            canonical(request, &json!({"outcome": "done"})),
            Err(Refusal::UnknownStep),
            "{request}"
        );
    }
}

#[test]
fn the_route_body_decodes_an_outcome_once_and_keeps_no_other_field() {
    let body: super::super::driver::OutcomeBody =
        serde_json::from_value(json!({"outcome": {"outcome": "dom", "text": "t", "epoch": 1}}))
            .expect("settle body");
    assert_eq!(
        super::canonical(&step("read_dom_redacted"), &body.outcome),
        Ok(json!({"outcome": "dom", "text": "t", "epoch": 1}))
    );
    assert!(serde_json::from_value::<super::super::driver::OutcomeBody>(
        json!({"outcome": {"outcome": "done"}, "note": "x"})
    )
    .is_err());
}
