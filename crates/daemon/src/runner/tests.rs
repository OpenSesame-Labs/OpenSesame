use super::*;

/// The system's own directories: a snapshot needs a trusted `PATH` entry to
/// find even `sh`.
const SYSTEM_PATH: &str = "/usr/bin:/bin";

fn runner_with(env: &[(&str, &str)]) -> ScrubbedCommandRunner {
    let mut snapshot: BTreeMap<String, String> = BTreeMap::new();
    snapshot.insert("PATH".to_string(), SYSTEM_PATH.to_string());
    snapshot.extend(
        env.iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string())),
    );
    ScrubbedCommandRunner::new(snapshot)
}

#[cfg(unix)]
fn exact_runner(
    source: &str,
    binary: &str,
    env: &[(&str, &str)],
) -> (
    opensesame_trusted_exec::testkit::ExecutableFixture,
    ScrubbedCommandRunner,
) {
    let fixture = opensesame_trusted_exec::testkit::ExecutableFixture::new();
    let executable = fixture.copy(source, binary);
    let runner = runner_with(env).with_exact_program(binary, executable);
    (fixture, runner)
}

#[test]
fn contract_child_env_is_a_whitelist_projection() {
    let mut snapshot = BTreeMap::new();
    snapshot.insert("HOME".to_string(), "/home/tester".to_string());
    snapshot.insert("PATH".to_string(), "/usr/bin".to_string());
    snapshot.insert(
        "OPENSESAME_OPERATOR_TOKEN".to_string(),
        "PLANTED-OPERATOR-TOKEN".to_string(),
    );
    snapshot.insert("AWS_SECRET_ACCESS_KEY".to_string(), "PLANTED".to_string());
    let child_env = minimal_child_env(&snapshot);
    assert!(child_env.contains_key("HOME"));
    assert!(child_env.contains_key("PATH"));
    assert!(!child_env.contains_key("OPENSESAME_OPERATOR_TOKEN"));
    assert!(!child_env.contains_key("AWS_SECRET_ACCESS_KEY"));
}

#[test]
#[cfg(unix)]
fn adversarial_child_never_sees_the_daemons_own_environment() {
    // Even a variable set on the daemon process itself must not reach the
    // child: the runner starts from env_clear, not from inheritance.
    let planted = "OPENSESAME_PLANTED_CHILD_MUST_NOT_SEE";
    std::env::set_var(planted, "PLANTED-SECRET");
    let (_fixture, runner) = exact_runner("/usr/bin/env", "fixture-env", &[("HOME", "/tmp")]);
    let output = runner
        .run_capture(&["fixture-env"], 2_000)
        .expect("captured child environment");
    assert!(
        !secrecy::ExposeSecret::expose_secret(&output).contains(planted),
        "child observed the daemon's environment"
    );
    std::env::remove_var(planted);
}

#[test]
#[cfg(unix)]
fn an_exact_program_gets_common_values_without_an_untrusted_path() {
    let (_fixture, runner) = exact_runner(
        "/usr/bin/env",
        "fixture-env",
        &[("HOME", "/home/tester"), ("PATH", "/usr/bin:/bin")],
    );
    let output = runner
        .run_capture(&["fixture-env"], 2_000)
        .expect("captured child environment");
    let output = secrecy::ExposeSecret::expose_secret(&output);
    assert!(output.lines().any(|line| line == "HOME=/home/tester"));
    assert!(
        !output.lines().any(|line| line.starts_with("PATH=")),
        "an untrusted PATH reached the explicit executable: {output}"
    );
}

#[test]
#[cfg(unix)]
fn contract_a_hung_child_is_killed_at_the_timeout() {
    // Killing the shell leaves its child holding the inherited pipes. The
    // runner must still stop waiting for the drain threads after its bounded
    // join, rather than hanging until the grandchild exits.
    let (_fixture, runner) = exact_runner("/bin/sh", "fixture-shell", &[]);
    let started = Instant::now();
    let result = runner.run_status(&["fixture-shell", "-c", "/bin/sleep 30"], 150);
    let elapsed = started.elapsed();
    assert!(result.is_err(), "timeout must surface as an error");
    assert!(
        elapsed < Duration::from_secs(5),
        "took {elapsed:?} to give up"
    );
}

#[test]
#[cfg(unix)]
fn contract_stdout_is_reduced_to_a_non_empty_bit() {
    // `gh auth token` prints a token; the runner must prove it saw output
    // without any API that could hand the bytes back.
    let directory = tempfile::tempdir().expect("tempdir");
    let planted = directory.path().join("PLANTED-TOKEN-VALUE");
    std::fs::write(&planted, b"").expect("fixture file");
    let (_fixture, runner) = exact_runner("/bin/ls", "fixture-list", &[]);
    let status = runner
        .run_status(
            &[
                "fixture-list",
                planted.to_str().expect("utf-8 fixture path"),
                "/definitely/not/present",
            ],
            2_000,
        )
        .expect("ran");
    assert!(!status.success);
    assert!(status.stdout_non_empty);
}

#[test]
#[cfg(unix)]
fn a_chatty_child_cannot_deadlock_the_pipe() {
    // Far more than the 4 KiB observation cap and more than a pipe buffer:
    // only draining keeps this from blocking forever.
    let (_fixture, runner) = exact_runner("/usr/bin/seq", "fixture-seq", &[]);
    let started = Instant::now();
    let status = runner
        .run_status(&["fixture-seq", "1", "50000"], 10_000)
        .expect("ran");
    assert!(status.success);
    assert!(status.stdout_non_empty);
    assert!(started.elapsed() < Duration::from_secs(10));
}

#[test]
fn a_missing_binary_is_an_error_not_a_panic() {
    let runner = runner_with(&[]);
    let result = runner.run_status(&["definitely-not-a-real-binary-xyz"], 1_000);
    assert!(result.is_err());
}

// ——— run_capture: the invoke-through acquisition path ————————————

#[test]
#[cfg(unix)]
fn capture_returns_stdout_trimmed() {
    use secrecy::ExposeSecret;
    let (_fixture, runner) = exact_runner("/bin/echo", "fixture-echo", &[]);
    let token = runner
        .run_capture(&["fixture-echo", "gho_abc123"], 2_000)
        .expect("captured");
    assert_eq!(token.expose_secret(), "gho_abc123");
}

#[test]
#[cfg(unix)]
fn capture_error_never_carries_the_secret() {
    // A failing child that printed a credential-shaped string: the error
    // must name the failure class (exit status), not the output.
    let directory = tempfile::tempdir().expect("tempdir");
    let planted = directory.path().join("PLANTED-TOKEN-IN-OUTPUT");
    std::fs::write(&planted, b"").expect("fixture file");
    let (_fixture, runner) = exact_runner("/bin/ls", "fixture-list", &[]);
    let error = runner
        .run_capture(
            &[
                "fixture-list",
                planted.to_str().expect("utf-8 fixture path"),
                "/definitely/not/present",
            ],
            2_000,
        )
        .expect_err("non-zero exit");
    let rendered = format!("{error} / {error:?}");
    assert!(!rendered.contains("PLANTED-TOKEN-IN-OUTPUT"), "{rendered}");
}

#[test]
#[cfg(unix)]
fn capture_fails_closed_on_empty_output() {
    // Keep the process alive briefly so the drain thread is scheduled even
    // when the whole daemon test binary is saturating the host.
    let (_fixture, runner) = exact_runner("/bin/sleep", "fixture-empty", &[]);
    let error = runner
        .run_capture(&["fixture-empty", "0.1"], 2_000)
        .expect_err("no credential printed");
    assert!(
        format!("{error}").contains("no credential"),
        "unexpected refusal: {error}"
    );
}

#[test]
#[cfg(unix)]
fn capture_is_capped() {
    let (_fixture, runner) = exact_runner("/usr/bin/seq", "fixture-seq", &[]);
    let error = runner
        .run_capture(&["fixture-seq", "1", "50000"], 10_000)
        .expect_err("oversized capture");
    assert!(
        format!("{error}").contains("cap"),
        "unexpected refusal: {error}"
    );
}

#[test]
#[cfg(unix)]
fn capture_honors_the_timeout() {
    let (_fixture, runner) = exact_runner("/bin/sleep", "fixture-sleep", &[]);
    let result = runner.run_capture(&["fixture-sleep", "30"], 150);
    assert!(result.is_err());
}

#[test]
#[cfg(unix)]
fn capture_child_env_is_still_scrubbed() {
    let (_fixture, runner) = exact_runner("/usr/bin/env", "fixture-env", &[("HOME", "/tmp")]);
    // The daemon's own variables must not reach the capturing child
    // either; print the planted variable — empty proves the scrub.
    let planted = "OPENSESAME_PLANTED_CAPTURE_MUST_NOT_SEE";
    std::env::set_var(planted, "PLANTED-SECRET");
    let result = runner.run_capture(&["fixture-env"], 2_000);
    std::env::remove_var(planted);
    let output = result.expect("captured child environment");
    assert!(!secrecy::ExposeSecret::expose_secret(&output).contains(planted));
}

// ——— Windows spells PATH `Path` ———————————————————————————————————————

#[test]
fn a_windows_snapshot_keeps_its_path_under_the_name_windows_gives_it() {
    let snapshot: BTreeMap<String, String> = [
        ("Path", "C:\\Program Files\\GitHub CLI"),
        ("USERPROFILE", "C:\\Users\\dummy"),
        ("OPENSESAME_OPERATOR_TOKEN", "PLANTED-OPERATOR-TOKEN"),
    ]
    .into_iter()
    .map(|(name, value)| (name.to_string(), value.to_string()))
    .collect();
    let kept = minimal_child_env_on(Platform::Windows, &snapshot);
    assert!(kept.contains_key("Path"), "Path was dropped: {kept:?}");
    assert!(kept.contains_key("USERPROFILE"));
    assert!(!kept.contains_key("OPENSESAME_OPERATOR_TOKEN"));
    // What the resolver reads is that same entry, so a probe finds a CLI.
    let lookup = programs::lookup_on(Platform::Windows, &kept);
    assert!(lookup.var("PATH").is_some(), "the resolver saw no PATH");
}

#[test]
fn a_unix_snapshot_keeps_only_the_variable_named_path() {
    let snapshot: BTreeMap<String, String> = [("Path", "/tmp/planted"), ("PATH", "/usr/bin")]
        .into_iter()
        .map(|(name, value)| (name.to_string(), value.to_string()))
        .collect();
    let kept = minimal_child_env_on(Platform::Unix, &snapshot);
    assert!(kept.contains_key("PATH"));
    assert!(!kept.contains_key("Path"), "a different variable was kept");
}

// ——— which CLI runs, and what each is handed ——————————————————————————

#[cfg(unix)]
mod trusted {
    use super::*;
    use opensesame_trusted_exec::testkit::{ExecutableFixture, Fixture, HOSTILE, SECRET};
    use secrecy::ExposeSecret;

    /// The fixture's hostile parent environment as the snapshot discovery
    /// takes, projected the way discovery projects it.
    fn runner_over(fixture: &Fixture, extra: &[(&str, &str)]) -> ScrubbedCommandRunner {
        let snapshot: BTreeMap<String, String> = fixture
            .lookup(extra)
            .vars
            .into_iter()
            .map(|(n, v)| (n.into_string().unwrap(), v.into_string().unwrap()))
            .collect();
        ScrubbedCommandRunner::new(minimal_child_env(&snapshot))
    }

    #[test]
    fn an_operator_named_cli_wins_over_a_planted_path_entry() {
        let fixture = Fixture::new("gh");
        let exact = ExecutableFixture::new();
        let chosen = exact.copy("/bin/echo", "gh");
        let chosen = chosen.to_string_lossy();
        let runner = runner_over(&fixture, &[("OPENSESAME_GH", chosen.as_ref())]);
        let status = runner.run_status(&["gh", "auth", "token"], 2_000);
        let token = runner.run_capture(&["gh", "auth", "token"], 2_000);
        assert!(!fixture.planted_ran(), "the planted gh ran");
        let status = status.unwrap();
        assert!(status.success && status.stdout_non_empty);
        assert_eq!(token.unwrap().expose_secret(), "auth token");
    }

    #[test]
    fn each_cli_is_handed_its_own_configuration_and_no_other() {
        let configured = [
            ("GH_CONFIG_DIR", "/home/dummy/.config/gh"),
            ("KUBECONFIG", "/home/dummy/.kube/config"),
            ("AWS_PROFILE", "dummy"),
        ];
        for (cli, own, others) in [
            ("gh", "GH_CONFIG_DIR", ["KUBECONFIG", "AWS_PROFILE"]),
            ("kubectl", "KUBECONFIG", ["GH_CONFIG_DIR", "AWS_PROFILE"]),
            ("aws", "AWS_PROFILE", ["GH_CONFIG_DIR", "KUBECONFIG"]),
        ] {
            let fixture = ExecutableFixture::new();
            let executable = fixture.copy("/usr/bin/printenv", cli);
            let mut parent = configured.to_vec();
            parent.extend(HOSTILE);
            let runner = runner_with(&parent).with_exact_program(cli, executable);
            let own_value = runner.run_capture(&[cli, own], 2_000).unwrap();
            let expected = configured
                .iter()
                .find(|(name, _)| *name == own)
                .expect("configured variable")
                .1;
            assert_eq!(own_value.expose_secret(), expected);
            let env = runner.run_capture(&[cli], 2_000).unwrap();
            let env = env.expose_secret();
            assert!(!env.contains(SECRET), "hostile value reached {cli}: {env}");
            for other in others {
                assert!(
                    !env.lines()
                        .any(|line| line.starts_with(&format!("{other}="))),
                    "{other} reached {cli}: {env}"
                );
            }
            for (hostile, _) in HOSTILE {
                assert!(!env.contains(hostile), "{hostile} reached {cli}: {env}");
            }
        }
    }

    #[test]
    fn opensesame_gh_names_the_exact_cli_and_is_not_handed_on() {
        let fixture = ExecutableFixture::new();
        let chosen = fixture.copy("/usr/bin/printenv", "gh");
        let value = chosen.to_string_lossy();
        let runner = runner_with(&[("HOME", "/home/dummy"), ("OPENSESAME_GH", value.as_ref())]);
        let env = runner.run_capture(&["gh"], 2_000).unwrap();
        assert!(!env.expose_secret().contains("OPENSESAME_GH="));
    }

    #[test]
    fn a_snapshot_without_a_trusted_path_entry_runs_nothing() {
        let error = ScrubbedCommandRunner::new(BTreeMap::new())
            .run_status(&["sh", "-c", "true"], 2_000)
            .expect_err("no PATH, no program");
        assert!(format!("{error}").contains("PATH is not set"), "{error}");
    }
}
