//! A configuration refusal must precede `SQLite` creation and listener startup.
#[cfg(unix)]
use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

fn refuses_before_storage(
    mode: Option<&str>,
    node: Option<&str>,
    dev: Option<&str>,
    networked: bool,
    pepper: bool,
) {
    let directory =
        std::env::temp_dir().join(format!("opensesame-startup-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&directory).unwrap();
    let database = directory.join("must-not-exist.db");
    let secret = || {
        format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        )
    };
    let mut command = Command::new(env!("CARGO_BIN_EXE_opensesame"));
    command
        .env_clear()
        .args(["host", "run"])
        .env("OPENSESAME_OPERATOR_TOKEN", secret())
        .args([
            "--listen",
            if networked {
                "0.0.0.0:0"
            } else {
                "127.0.0.1:0"
            },
        ])
        .args([
            "--resource",
            "http://127.0.0.1:8787",
            "--issuer",
            "http://127.0.0.1:8788",
        ])
        .arg("--database-url")
        .arg(format!("sqlite://{}?mode=rwc", database.display()))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(mode) = mode {
        command.env("OPENSESAME_ENV", mode);
    }
    if let Some(node) = node {
        command.env("NODE_ENV", node);
    }
    if let Some(dev) = dev {
        command.env("OPENSESAME_ALLOW_DEV_DEFAULTS", dev);
    }
    if pepper {
        command.env("OPENSESAME_CLAIM_PEPPER", secret());
    }
    let mut child = command.spawn().unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if child.try_wait().unwrap().is_some() {
            break;
        }
        if Instant::now() >= deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("invalid configuration did not abort startup");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let output = child.wait_with_output().unwrap();
    assert!(!output.status.success());
    assert!(!database.exists(), "configuration failure mutated SQLite");
    assert!(!String::from_utf8_lossy(&output.stdout).contains("gateway listening"));
    let error = String::from_utf8_lossy(&output.stderr);
    assert!(
        error.contains("OPENSESAME_") || error.contains("NODE_ENV"),
        "unexpected startup failure: {error}"
    );
    std::fs::remove_dir(directory).unwrap();
}

#[test]
fn strict_mode_and_missing_pepper_refuse_before_database_mutation() {
    for mode in [
        None,
        Some(""),
        Some("prod"),
        Some("Production"),
        Some(" production "),
    ] {
        refuses_before_storage(mode, None, None, false, true);
    }
    refuses_before_storage(Some("development"), Some("production"), None, false, true);
    refuses_before_storage(Some("development"), None, Some("1"), true, true);
    refuses_before_storage(Some("production"), None, None, false, false);
    refuses_before_storage(Some("development"), None, None, true, false);
}

#[cfg(unix)]
fn wait_for_exit(mut child: std::process::Child) -> std::process::Output {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if child.try_wait().unwrap().is_some() {
            return child.wait_with_output().unwrap();
        }
        if Instant::now() >= deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("Host command did not exit");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(unix)]
fn serving_response_matches(address: std::net::SocketAddr, resource: &str) -> bool {
    let Ok(mut stream) = std::net::TcpStream::connect_timeout(&address, Duration::from_millis(50))
    else {
        return false;
    };
    stream
        .set_read_timeout(Some(Duration::from_secs(1)))
        .unwrap();
    let request = b"GET /.well-known/oauth-protected-resource HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n";
    if stream.write_all(request).is_err() {
        return false;
    }
    let mut response = String::new();
    stream.read_to_string(&mut response).is_ok()
        && response.starts_with("HTTP/1.1 200")
        && response.contains(resource)
        && response.contains("opensesame_task_api")
}

#[cfg(unix)]
fn wait_until_serving(
    serving: &mut std::process::Child,
    address: std::net::SocketAddr,
    resource: &str,
) {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if let Some(status) = serving.try_wait().unwrap() {
            panic!("attested Host exited before serving: {status}");
        }
        if serving_response_matches(address, resource) {
            assert!(
                serving.try_wait().unwrap().is_none(),
                "Host exited after its response"
            );
            break;
        }
        assert!(
            Instant::now() < deadline,
            "attested Host did not begin serving"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[cfg(unix)]
#[test]
fn configured_host_requires_offline_attestation_before_it_serves() {
    let directory = tempfile::tempdir().unwrap();
    let db = format!(
        "sqlite:{}?mode=rwc",
        directory.path().join("host.db").display()
    );
    let bindings = directory.path().join("bindings.json");
    let attestation = directory.path().join("history.json");
    std::fs::write(&bindings, r#"{"revision":1,"bindings":[]}"#).unwrap();
    std::fs::write(
        &attestation,
        r#"{"owner":"host-tls","actor":"operator","change_ref":"fresh-install","names":[]}"#,
    )
    .unwrap();
    let socket = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = socket.local_addr().unwrap();
    drop(socket);
    let resource = format!(
        "http://localhost:8787/source-history-{}",
        uuid::Uuid::new_v4()
    );
    let host = |database: &str, configured: bool| {
        let mut command = Command::new(env!("CARGO_BIN_EXE_opensesame"));
        command
            .env_clear()
            .args(["host", "run"])
            .args(["--listen", &address.to_string(), "--database-url", database])
            .args(["--resource", &resource, "--issuer", "http://localhost:8788"])
            .env("OPENSESAME_ENV", "development")
            .env("OPENSESAME_ALLOW_DEV_DEFAULTS", "1")
            .env("TOKIO_WORKER_THREADS", "1")
            .env(
                "OPENSESAME_OPERATOR_TOKEN",
                "test-operator-token-0123456789abcdef",
            )
            .env(
                "OPENSESAME_CLAIM_PEPPER",
                "test-claim-pepper-0123456789abcdef",
            )
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if configured {
            command.env("OPENSESAME_SERVICE_BINDINGS_FILE", &bindings);
        }
        command
    };
    let first = wait_for_exit(host(&db, true).spawn().unwrap());
    assert!(!first.status.success());
    assert!(directory.path().join("host.db").is_file());
    assert!(String::from_utf8_lossy(&first.stderr).contains("not been explicitly initialized"));

    let initialize = |database: &str, attest: bool| {
        let mut command = Command::new(env!("CARGO_BIN_EXE_opensesame"));
        command
            .env_clear()
            .env("TOKIO_WORKER_THREADS", "1")
            .args(["host", "trust-history-init", "--database-url", database])
            .arg("--attestation")
            .arg(&attestation);
        if attest {
            command.arg("--attest-complete-and-hosts-stopped");
        }
        command.output().unwrap()
    };
    assert!(!initialize(&db, false).status.success());
    let initialized = initialize(&db, true);
    assert!(initialized.status.success(), "{initialized:?}");
    assert!(String::from_utf8_lossy(&initialized.stdout).contains("0 reserved names"));
    let repeated = initialize(&db, true);
    assert!(!repeated.status.success());
    assert!(String::from_utf8_lossy(&repeated.stderr).contains("already exists"));

    let mut lease_holder = initializer_owner(&db, &attestation, &directory.path().join("ready"));
    for configured in [true, false] {
        let blocked = wait_for_exit(host(&db, configured).spawn().unwrap());
        assert!(!blocked.status.success());
        assert!(
            String::from_utf8_lossy(&blocked.stderr).contains("Host database lease unavailable")
        );
    }
    lease_holder.finish();

    let mut serving = ChildGuard(host(&db, true).spawn().unwrap());
    wait_until_serving(&mut serving.0, address, &resource);
    check_competing_hosts(directory.path(), &db, &host, &initialize);
    serving.stop();
    let mut restarted = ChildGuard(host(&db, true).spawn().unwrap());
    wait_until_serving(&mut restarted.0, address, &resource);
    restarted.stop();
}

#[cfg(unix)]
fn check_competing_hosts(
    directory: &std::path::Path,
    database: &str,
    host: &impl Fn(&str, bool) -> Command,
    initialize: &impl Fn(&str, bool) -> std::process::Output,
) {
    for configured in [true, false] {
        let other = wait_for_exit(host(database, configured).spawn().unwrap());
        assert!(!other.status.success());
        assert!(String::from_utf8_lossy(&other.stderr).contains("Host database lease unavailable"));
    }
    let blocked = initialize(database, true);
    assert!(!blocked.status.success());
    assert!(String::from_utf8_lossy(&blocked.stderr).contains("Host database lease unavailable"));
    #[cfg(unix)]
    {
        let alias = directory.join("directory-alias");
        std::os::unix::fs::symlink(directory, &alias).unwrap();
        let alternate = format!("sqlite:{}/host.db?mode=rwc", alias.display());
        let other = wait_for_exit(host(&alternate, false).spawn().unwrap());
        assert!(!other.status.success());
        assert!(String::from_utf8_lossy(&other.stderr).contains("Host database lease unavailable"));
        let hardlink = directory.join("hardlink.db");
        std::fs::hard_link(directory.join("host.db"), &hardlink).unwrap();
        let other = wait_for_exit(
            host(&format!("sqlite:{}", hardlink.display()), false)
                .spawn()
                .unwrap(),
        );
        std::fs::remove_file(hardlink).unwrap();
        assert!(!other.status.success());
        assert!(String::from_utf8_lossy(&other.stderr)
            .contains("SQLite database identity is unsupported"));
    }
}

#[cfg(unix)]
struct ChildGuard(std::process::Child);

#[cfg(unix)]
impl ChildGuard {
    fn stop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }

    fn finish(&mut self) {
        self.0.stdin.as_mut().unwrap().write_all(b"x").unwrap();
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            if let Some(status) = self.0.try_wait().unwrap() {
                assert!(status.success(), "initializer child failed: {status}");
                break;
            }
            assert!(Instant::now() < deadline, "initializer child did not stop");
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

#[cfg(unix)]
impl Drop for ChildGuard {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(unix)]
fn initializer_owner(
    database: &str,
    attestation: &std::path::Path,
    ready: &std::path::Path,
) -> ChildGuard {
    let mut child = ChildGuard(
        Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "history_initializer_owner_child",
                "--ignored",
                "--nocapture",
            ])
            .env_clear()
            .env("HISTORY_TEST_DB", database)
            .env("HISTORY_TEST_ATTESTATION", attestation)
            .env("HISTORY_TEST_READY", ready)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let deadline = Instant::now() + Duration::from_secs(15);
    while !ready.exists() {
        if let Some(status) = child.0.try_wait().unwrap() {
            let mut error = String::new();
            child
                .0
                .stderr
                .take()
                .unwrap()
                .read_to_string(&mut error)
                .unwrap();
            panic!("initializer child exited before holding the lease: {status}: {error}");
        }
        assert!(
            Instant::now() < deadline,
            "initializer child did not acquire the lease"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    child
}

#[cfg(unix)]
#[test]
#[ignore = "spawned explicitly by the process-lifetime lease control"]
fn history_initializer_owner_child() {
    let Ok(database) = std::env::var("HISTORY_TEST_DB") else {
        return;
    };
    let document = std::fs::read(std::env::var("HISTORY_TEST_ATTESTATION").unwrap()).unwrap();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let error = runtime
        .block_on(opensesame_gateway::initialize_host_history(
            &database, document, true,
        ))
        .unwrap_err();
    assert!(error.to_string().contains("already exists"));
    std::fs::write(std::env::var("HISTORY_TEST_READY").unwrap(), b"held").unwrap();
    let mut release = [0_u8; 1];
    std::io::stdin().read_exact(&mut release).unwrap();
}
