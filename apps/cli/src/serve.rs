//! The long-running roles of this binary: the Host API (`opensesame host run`),
//! the local agent daemon (`opensesame daemon run`) and the workload connector
//! host (`opensesame worker run`). One binary serves every native role; the
//! role is the subcommand, not a separate executable (ADR 0138).
use crate::Commands;
use anyhow::Context as _;
use clap::Subcommand;
use opensesame_redaction::{Format, ScrubMakeWriter};
use std::io::Read as _;
use std::path::PathBuf;

/// `opensesame host`.
#[derive(Subcommand, Debug)]
pub enum HostCmd {
    /// Serve the Host API until it is stopped.
    Run(Box<opensesame_gateway::Args>),
    /// Initialize complete source-trust history while all Hosts sharing the store are stopped.
    TrustHistoryInit {
        /// Existing Host `SQLite` database; this action does not apply migrations.
        #[arg(
            long,
            env = "OPENSESAME_DB",
            default_value = ".tools/run/opensesame.db"
        )]
        database_url: String,
        /// JSON document containing the trust owner, actor, change reference and complete names.
        #[arg(long)]
        attestation: PathBuf,
        /// Attest that the list is complete and every Host using this store is stopped.
        #[arg(long)]
        attest_complete_and_hosts_stopped: bool,
    },
}

/// `opensesame worker`.
#[derive(Subcommand, Debug)]
pub enum WorkerCmd {
    /// Serve the workload connector host until it is stopped.
    Run(Box<opensesame_worker::Args>),
}

pub async fn host(cmd: HostCmd) -> anyhow::Result<()> {
    match cmd {
        HostCmd::Run(args) => opensesame_gateway::run(*args).await,
        HostCmd::TrustHistoryInit {
            database_url,
            attestation,
            attest_complete_and_hosts_stopped,
        } => {
            if !attest_complete_and_hosts_stopped {
                anyhow::bail!("source trust history requires --attest-complete-and-hosts-stopped");
            }
            let limit = opensesame_gateway::SOURCE_HISTORY_ATTESTATION_LIMIT;
            let mut document = Vec::new();
            std::fs::File::open(&attestation)
                .context("open source trust history attestation")?
                .take(u64::try_from(limit).expect("attestation limit fits u64") + 1)
                .read_to_end(&mut document)
                .context("read source trust history attestation")?;
            if document.len() > limit {
                anyhow::bail!("source trust history attestation exceeds {limit} bytes");
            }
            let history =
                opensesame_gateway::initialize_host_history(&database_url, document, true).await?;
            println!(
                "Initialized source trust history with {} reserved names at revision {}.",
                history.names().len(),
                history.revision()
            );
            Ok(())
        }
    }
}

pub async fn worker(cmd: WorkerCmd) -> anyhow::Result<()> {
    match cmd {
        WorkerCmd::Run(args) => opensesame_worker::run(*args).await,
    }
}

/// A server logs to stdout at `info` (the Host API as JSON lines, as its
/// collectors expect); every other command logs warnings to stderr so its
/// stdout stays the command's output.
///
/// Every sink is wrapped in a scrubbing writer (ADR 0157): a call site that
/// logs a secret by mistake, a library error that echoes a URL with a token in
/// it and a panic message all reach the collector or the file already scrubbed.
/// With `OPENSESAME_LOG_FILE` set the server's lines are sealed into that file
/// instead of written to stdout.
pub fn init_tracing(command: &Commands) {
    match command {
        Commands::Host {
            cmd: HostCmd::Run(_),
        } => init_host(),
        Commands::Worker { .. } => init_text(),
        Commands::Daemon(args) if args.is_run() => init_text(),
        _ => tracing_subscriber::fmt()
            .with_env_filter("warn")
            .with_ansi(false)
            .with_writer(ScrubMakeWriter::new(std::io::stderr, Format::Text))
            .init(),
    }
}

fn init_host() {
    let filter = "info,tower_http=info";
    match crate::log_sink::from_env() {
        Some(sink) => tracing_subscriber::fmt()
            .with_env_filter(filter)
            .json()
            .with_writer(ScrubMakeWriter::new(move || sink.writer(), Format::Json))
            .init(),
        None => tracing_subscriber::fmt()
            .with_env_filter(filter)
            .json()
            .with_writer(ScrubMakeWriter::new(std::io::stdout, Format::Json))
            .init(),
    }
    crate::log_sink::install_panic_hook();
}

fn init_text() {
    match crate::log_sink::from_env() {
        Some(sink) => tracing_subscriber::fmt()
            .with_ansi(false)
            .with_writer(ScrubMakeWriter::new(move || sink.writer(), Format::Text))
            .init(),
        None => tracing_subscriber::fmt()
            .with_ansi(false)
            .with_writer(ScrubMakeWriter::new(std::io::stdout, Format::Text))
            .init(),
    }
    crate::log_sink::install_panic_hook();
}

#[cfg(all(test, unix))]
mod tests {
    use clap::Parser;

    use super::{host, HostCmd};

    const KEY: &str = "transport.source_trust_history.host_tls.v1";

    fn init_command(url: &str, path: &std::path::Path, attest: bool) -> HostCmd {
        let mut args = vec![
            "opensesame".to_owned(),
            "host".to_owned(),
            "trust-history-init".to_owned(),
            "--database-url".to_owned(),
            url.to_owned(),
            "--attestation".to_owned(),
            path.display().to_string(),
        ];
        if attest {
            args.push("--attest-complete-and-hosts-stopped".to_owned());
        }
        match crate::Cli::try_parse_from(args).unwrap().command {
            crate::Commands::Host { cmd } => cmd,
            _ => panic!("expected the Host command"),
        }
    }

    #[tokio::test]
    async fn offline_attestation_handles_fresh_and_legacy_databases_once() {
        for (change, names) in [
            ("fresh-install", vec![]),
            ("legacy-upgrade", vec!["partner.test"]),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let db_path = dir.path().join("host.db");
            let url = format!("sqlite:{}?mode=rwc", db_path.display());
            let path = dir.path().join("attestation.json");
            std::fs::write(
                &path,
                serde_json::to_vec(&serde_json::json!({
                    "owner": "host-tls", "actor": "operator", "change_ref": change,
                    "names": names,
                }))
                .unwrap(),
            )
            .unwrap();

            // Even explicit attestation cannot create a database or schema.
            assert!(host(init_command(&url, &path, true)).await.is_err());
            assert!(!db_path.exists());
            // A failed attempt on an existing file retains its lease until
            // this process exits, so use a separate file for that case.
            let empty = dir.path().join("unmigrated.db");
            let empty_url = format!("sqlite:{}?mode=rwc", empty.display());
            std::fs::File::create(&empty).unwrap();
            assert!(host(init_command(&empty_url, &path, true)).await.is_err());
            let inspect = sqlx::SqlitePool::connect(&empty_url).await.unwrap();
            let table_count: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM main.sqlite_master WHERE type = 'table' AND name = 'host_kv'",
            )
            .fetch_one(&inspect)
            .await
            .unwrap();
            assert_eq!(table_count, 0, "the offline action must not migrate");
            inspect.close().await;

            // Normal Host startup creates/migrates the database first. Its
            // configured transport refuses the missing row (covered by the
            // gateway runtime regression), then the operator runs this action.
            let db = opensesame_storage::Db::connect_sqlite(&url).await.unwrap();
            assert!(host(init_command(&url, &path, false)).await.is_err());
            assert!(db.get_host_kv(KEY).await.unwrap().is_none());
            host(init_command(&url, &path, true)).await.unwrap();
            let first = db.get_host_kv(KEY).await.unwrap().unwrap();
            let recorded: serde_json::Value = serde_json::from_str(&first).unwrap();
            assert_eq!(recorded["names"], serde_json::json!(names));
            assert_eq!(recorded["change_ref"], change);
            assert!(host(init_command(&url, &path, true)).await.is_err());
            assert_eq!(
                db.get_host_kv(KEY).await.unwrap().as_deref(),
                Some(first.as_str())
            );
            db.pool().close().await;
        }
    }

    #[tokio::test]
    async fn oversized_attestation_does_not_write_a_history() {
        let dir = tempfile::tempdir().unwrap();
        let url = format!("sqlite:{}?mode=rwc", dir.path().join("host.db").display());
        let db = opensesame_storage::Db::connect_sqlite(&url).await.unwrap();
        let path = dir.path().join("attestation.json");
        std::fs::write(
            &path,
            vec![b'x'; opensesame_gateway::SOURCE_HISTORY_ATTESTATION_LIMIT + 1],
        )
        .unwrap();
        assert!(host(init_command(&url, &path, true)).await.is_err());
        assert!(db.get_host_kv(KEY).await.unwrap().is_none());
    }
}
