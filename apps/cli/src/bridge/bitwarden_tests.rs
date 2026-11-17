use clap::Parser as _;

use super::*;

fn parse(args: &[&str]) -> BitwardenCmd {
    let cli = crate::Cli::try_parse_from(args).unwrap();
    let crate::Commands::Bridge {
        cmd: crate::bridge::BridgeCmd::Bitwarden { cmd },
    } = cli.command
    else {
        panic!("not a bitwarden bridge verb");
    };
    cmd
}

#[test]
fn both_import_sources_parse_with_their_options() {
    let BitwardenCmd::Import {
        from: ImportSource::Vaultwarden { path, target, .. },
    } = parse(&[
        "opensesame",
        "bridge",
        "bitwarden",
        "import",
        "vaultwarden",
        "--from",
        "/srv/vw/db.sqlite3",
        "--db",
        "/var/lib/os.db",
        "--dry-run",
    ])
    else {
        panic!("expected a vaultwarden import");
    };
    assert_eq!(path, PathBuf::from("/srv/vw/db.sqlite3"));
    assert_eq!(target.database, "/var/lib/os.db");
    assert!(target.dry_run && !target.replace);

    let BitwardenCmd::Import {
        from:
            ImportSource::Account {
                server,
                email,
                attachment_origins,
                target,
            },
    } = parse(&[
        "opensesame",
        "bridge",
        "bitwarden",
        "import",
        "account",
        "--from",
        "https://vault.bitwarden.com",
        "--email",
        "me@example.com",
        "--attachment-origin",
        "https://storage.example.com",
        "--attachment-origin",
        "https://storage2.example.com:8443",
        "--replace",
    ])
    else {
        panic!("expected an account import");
    };
    assert_eq!(server, "https://vault.bitwarden.com");
    assert_eq!(email, "me@example.com");
    assert_eq!(
        attachment_origins,
        [
            "https://storage.example.com",
            "https://storage2.example.com:8443"
        ]
    );
    assert!(target.replace);
}

#[cfg(not(feature = "bitwarden-compat"))]
#[tokio::test]
async fn a_build_without_the_bridge_says_how_to_get_one() {
    let cmd = parse(&[
        "opensesame",
        "bridge",
        "bitwarden",
        "import",
        "vaultwarden",
        "--from",
        "x",
    ]);
    let refused = run(cmd).await.unwrap_err();
    assert!(refused.to_string().contains("--features bitwarden-compat"));
}

#[cfg(feature = "bitwarden-compat")]
#[tokio::test]
async fn a_vaultwarden_file_is_read_and_its_unmovable_accounts_reported() {
    use sqlx::sqlite::SqliteConnectOptions;
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("db.sqlite3");
    let pool = sqlx::SqlitePool::connect_with(
        SqliteConnectOptions::new()
            .filename(&source)
            .create_if_missing(true),
    )
    .await
    .unwrap();
    for statement in [
        "CREATE TABLE users (uuid TEXT, email TEXT, password_hash BLOB, salt BLOB, \
         password_iterations INTEGER, akey TEXT)",
        "CREATE TABLE ciphers (uuid TEXT, user_uuid TEXT, atype INTEGER, name TEXT, data TEXT)",
        "CREATE TABLE folders (uuid TEXT, user_uuid TEXT, name TEXT)",
        "INSERT INTO users VALUES ('u', 'invited@example.test', x'', x'', 0, '')",
    ] {
        sqlx::query(statement).execute(&pool).await.unwrap();
    }
    pool.close().await;
    let host = dir.path().join("host.db");
    std::fs::File::create(&host).unwrap();
    let cmd = parse(&[
        "opensesame",
        "bridge",
        "bitwarden",
        "import",
        "vaultwarden",
        "--from",
        source.to_str().unwrap(),
        "--db",
        host.to_str().unwrap(),
    ]);
    run(cmd).await.unwrap();
    let db = opensesame_storage::Db::connect_sqlite(host.to_str().unwrap())
        .await
        .unwrap();
    assert!(db
        .bitwarden_user_by_email("invited@example.test")
        .await
        .unwrap()
        .is_none());
}
