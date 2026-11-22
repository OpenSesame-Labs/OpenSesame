//! Startup validation uses an isolated subprocess so no test changes the
//! parent process's provider environment.

use crate::config::GatewayProfile;
use crate::{app_state, Args};
use opensesame_task_access::{task_authority_backend_from_url, TaskAuthorityBackend};
use std::process::Command;

const CASE: &str = "OPENSESAME_TEST_PDP_STARTUP_CASE";

#[test]
fn non_postgres_task_db_is_not_distributed() {
    assert_eq!(
        task_authority_backend_from_url("sqlite::memory:"),
        TaskAuthorityBackend::SqliteLocal
    );
}

fn args(fail_database: bool) -> Args {
    Args {
        listen: "127.0.0.1:0".parse().unwrap(),
        resource: "https://host.test".into(),
        issuer: "https://identity.test".into(),
        database_url: if fail_database {
            "sqlite:///dev/null/should-not-open.sqlite".into()
        } else {
            "sqlite::memory:".into()
        },
        task_database_url: String::new(),
        profile: GatewayProfile::Host,
    }
}

fn run_child(scenario: &str) {
    let bad = !matches!(scenario, "unset" | "blank_url" | "valid");
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let result = runtime.block_on(app_state::build_test(args(bad)));
    if bad {
        let Err(error) = result else {
            panic!("{scenario} must refuse startup");
        };
        let error = error.to_string();
        let expected = if scenario == "non_utf8_url" {
            "OPENSESAME_OPENFGA_URL"
        } else if matches!(scenario, "query" | "fragment") {
            "PDP URL"
        } else {
            "OPENSESAME_OPENFGA_STORE_ID"
        };
        // The unusable database path proves the configuration is rejected
        // before persistent state is opened.
        assert!(
            error.contains(expected),
            "unexpected startup error: {error}"
        );
    } else {
        let state = result.unwrap();
        assert_eq!(state.openfga.is_some(), scenario == "valid");
    }
}

#[test]
#[ignore = "child helper invoked only with a cleared environment"]
fn openfga_startup_child() {
    if let Ok(scenario) = std::env::var(CASE) {
        run_child(&scenario);
        println!("OPENFGA_STARTUP_CASE_EXECUTED={scenario}");
    }
}

#[test]
fn configured_openfga_must_be_valid_before_host_starts() {
    let mut scenarios = vec![
        "unset",
        "blank_url",
        "valid",
        "missing_store",
        "blank_store",
        "unsafe_store",
        "query",
        "fragment",
    ];
    if cfg!(unix) {
        scenarios.push("non_utf8_url");
    }
    for scenario in scenarios {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .env_clear()
            .env(CASE, scenario)
            .env("OPENSESAME_TASKBUS", "memory")
            .args([
                "--exact",
                "app_state::tests::openfga_startup_child",
                "--ignored",
                "--nocapture",
            ]);
        match scenario {
            "unset" => {}
            "blank_url" => {
                command.env("OPENSESAME_OPENFGA_URL", "  ");
            }
            "non_utf8_url" => {
                #[cfg(unix)]
                {
                    use std::os::unix::ffi::OsStringExt;
                    command.env(
                        "OPENSESAME_OPENFGA_URL",
                        std::ffi::OsString::from_vec(vec![0xff]),
                    );
                }
            }
            _ => {
                let url = match scenario {
                    "query" => "http://127.0.0.1:1?x=1",
                    "fragment" => "http://127.0.0.1:1#frag",
                    _ => "http://127.0.0.1:1",
                };
                command.env("OPENSESAME_OPENFGA_URL", url);
                match scenario {
                    "missing_store" => {}
                    "blank_store" => {
                        command.env("OPENSESAME_OPENFGA_STORE_ID", "  ");
                    }
                    "unsafe_store" => {
                        command.env("OPENSESAME_OPENFGA_STORE_ID", "../other");
                    }
                    _ => {
                        command.env("OPENSESAME_OPENFGA_STORE_ID", "store-01");
                    }
                }
            }
        }
        let output = command.output().expect("launch isolated startup case");
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            output.status.success(),
            "{scenario}: {stdout} {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            stdout.contains(&format!("OPENFGA_STARTUP_CASE_EXECUTED={scenario}")),
            "startup child test did not run for {scenario}: {stdout}"
        );
    }
}

#[path = "task_invocation_roundtrip_tests.rs"]
mod task_invocation_roundtrip_tests;
