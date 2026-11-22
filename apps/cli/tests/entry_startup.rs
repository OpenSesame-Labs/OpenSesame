//! The actual CLI entrypoint must reach argument parsing on every native host.
//! Unit-test executables do not exercise the production process main stack.

use std::process::Command;

#[test]
fn the_real_cli_prints_its_version_before_dispatching_a_command() {
    let output = Command::new(env!("CARGO_BIN_EXE_opensesame"))
        .arg("--version")
        .output()
        .expect("run the genuine CLI executable");
    assert!(output.status.success(), "version failed: {output:?}");
    assert_eq!(
        String::from_utf8(output.stdout)
            .expect("version is UTF-8")
            .trim(),
        format!("opensesame {}", env!("CARGO_PKG_VERSION")),
    );
    assert!(output.stderr.is_empty(), "{:?}", output.stderr);
}

#[cfg(windows)]
mod windows_history {
    use std::io::{Read, Write};
    use std::net::{SocketAddr, TcpListener, TcpStream};
    use std::path::Path;
    use std::process::{Command, ExitStatus, Stdio};
    use std::time::{Duration, Instant};

    struct Child(std::process::Child);
    impl Drop for Child {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    fn command() -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_opensesame"));
        command
            .env_clear()
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        if let Some(root) = std::env::var_os("SystemRoot") {
            command.env("SystemRoot", root);
        }
        command
    }

    fn host(url: &str, address: SocketAddr, resource: &str) -> Command {
        let mut command = command();
        command
            .args(["host", "run", "--listen", &address.to_string()])
            .args([
                "--database-url",
                url,
                "--resource",
                resource,
                "--issuer",
                "http://localhost:8788",
            ])
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
            );
        command
    }

    fn wait_for_exit(child: &mut Child) -> (ExitStatus, String) {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            if let Some(status) = child.0.try_wait().unwrap() {
                let mut error = String::new();
                child
                    .0
                    .stderr
                    .take()
                    .unwrap()
                    .read_to_string(&mut error)
                    .unwrap();
                return (status, error);
            }
            assert!(Instant::now() < deadline, "command did not exit");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn address() -> SocketAddr {
        let socket = TcpListener::bind("127.0.0.1:0").unwrap();
        socket.local_addr().unwrap()
    }

    fn assert_unconfigured_serves(url: &str, resource: &str) {
        let address = address();
        let mut child = Child(host(url, address, resource).spawn().unwrap());
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            assert!(child.0.try_wait().unwrap().is_none(), "Host exited");
            if let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(50))
            {
                stream
                    .set_read_timeout(Some(Duration::from_secs(1)))
                    .unwrap();
                let request = b"GET /.well-known/oauth-protected-resource HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n";
                if stream.write_all(request).is_ok() {
                    let mut response = String::new();
                    if stream.read_to_string(&mut response).is_ok()
                        && response.starts_with("HTTP/1.1 200")
                        && response.contains(resource)
                        && response.contains("opensesame_task_api")
                    {
                        assert!(child.0.try_wait().unwrap().is_none());
                        return;
                    }
                }
            }
            assert!(Instant::now() < deadline, "unconfigured Host did not serve");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn assert_initializer_refuses(database: &str, attestation: &Path) {
        std::fs::write(
            attestation,
            r#"{"owner":"host-tls","actor":"operator","change_ref":"test","names":[]}"#,
        )
        .unwrap();
        let mut child = Child(
            command()
                .args(["host", "trust-history-init", "--database-url", database])
                .arg("--attestation")
                .arg(attestation)
                .arg("--attest-complete-and-hosts-stopped")
                .spawn()
                .unwrap(),
        );
        let (status, error) = wait_for_exit(&mut child);
        assert!(!status.success());
        assert!(
            error.contains("leases are unsupported on this platform"),
            "{error}"
        );
    }

    #[test]
    fn windows_refuses_configured_transport_and_initializer_but_serves_unconfigured() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("host.db");
        let database_url = format!("sqlite:{}?mode=rwc", database.display());
        let bindings = directory.path().join("bindings.json");
        std::fs::write(&bindings, r#"{"revision":1,"bindings":[]}"#).unwrap();
        let resource = format!("http://localhost:8787/history-{}", uuid::Uuid::new_v4());
        let mut configured = host(&database_url, address(), &resource);
        configured.env("OPENSESAME_SERVICE_BINDINGS_FILE", &bindings);
        let (status, error) = wait_for_exit(&mut Child(configured.spawn().unwrap()));
        assert!(!status.success());
        assert!(
            error.contains("requires a supported durable history lease"),
            "{error}"
        );
        assert!(!database.exists());

        assert_unconfigured_serves("sqlite::memory:", &resource);
        assert_unconfigured_serves(&database_url, &resource);
        assert!(database.is_file());
        assert_initializer_refuses(&database_url, &directory.path().join("attestation.json"));
    }
}
