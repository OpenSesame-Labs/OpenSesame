#[cfg(test)]
mod probes {
    use crate::tests::sync_target_pact_https::credentialed_send_https_gaps;

    #[test]
    fn council_p1_comparison_does_not_swallow_later_sqlx() {
        let http = [
            r#"async fn f() { let client = if port < 443 { pool } else { other }; let query = sqlx::query("select 1"); client.execute(request).await?; }"#,
            r#"async fn f() { let client = if port < 443 { pool } else { other }; client.execute(request).await?; }"#,
            r#"async fn f() { let client = if port <= 443 { pool } else { other }; let query = sqlx::query("select 1"); client.execute(request).await?; }"#,
            r#"async fn f() { let client = if port > 0 && port < 443 { pool } else { other }; client.execute(request).await?; }"#,
            r#"async fn f() { let query = sqlx::query("select 1"); let client = if port < 443 { query } else { query }; client.execute(&pool).await?; }"#,
        ];
        for sample in http {
            assert_eq!(credentialed_send_https_gaps(sample), (1, 1), "{sample}");
        }
        let db = [
            r#"async fn f() { let query = sqlx::query(if port < 443 { "a" } else { "b" }); query.execute(&pool).await?; }"#,
            r#"async fn f() { let client = if port < 443 { pool } else { other }; sqlx::query("select 1").execute(&pool).await?; }"#,
        ];
        for sample in db {
            assert_eq!(credentialed_send_https_gaps(sample), (0, 0), "{sample}");
        }
    }

    #[test]
    fn chunk02_wrapper_around_sqlx_is_still_a_send() {
        let http = [
            r#"async fn f() { let client = wrap(sqlx::query("s")); client.execute(request).await?; }"#,
            r#"async fn f() { let client = wrap(sqlx::query("s")).ready(); client.execute(request).await?; }"#,
            r#"async fn f() { let query = sqlx::query("select 1"); let client = wrap(query); client.execute(request).await?; }"#,
            r#"async fn f() { wrap(sqlx::query("s")).execute(request).await?; }"#,
            r#"async fn f() { wrap(sqlx::query("s")).ready().execute(request).await?; }"#,
            r#"async fn f() { let query = sqlx::query("select 1"); wrap(query).execute(request).await?; }"#,
        ];
        for sample in http {
            assert_eq!(credentialed_send_https_gaps(sample), (1, 1), "{sample}");
        }
        let db = [
            r#"async fn f() { let query = sqlx::query("select 1"); query.execute(&pool).await?; }"#,
            r#"async fn f() { let query = sqlx::query("select 1").bind(1); query.execute(&pool).await?; }"#,
            r#"async fn f() { let query = sqlx::query("select 1"); let client = query; client.execute(&pool).await?; }"#,
            r#"async fn f() { let query = (sqlx::query("select 1")); query.execute(&pool).await?; }"#,
            r#"async fn f() { let query = sqlx::query("select 1"); query.bind(1).execute(&pool).await?; }"#,
            r#"async fn f() { let query = sqlx::query("select 1"); query.bind(1).bind("x").execute(&pool).await?; }"#,
            r#"async fn f() { let query = sqlx::query("select 1"); (query).bind(1).execute(&pool).await?; }"#,
            r#"async fn f() { let q = sqlx::query("select 1"); let query = q; query.bind(1).execute(&pool).await?; }"#,
        ];
        for sample in db {
            assert_eq!(credentialed_send_https_gaps(sample), (0, 0), "{sample}");
        }
        let http = [
            r#"async fn f() { let client = wrap(sqlx::query("s")); client.ready().execute(request).await?; }"#,
            r#"async fn f() { let client = wrap(sqlx::query("s")).ready(); client.execute(request).await?; }"#,
        ];
        for sample in http {
            assert_eq!(credentialed_send_https_gaps(sample), (1, 1), "{sample}");
        }
    }

    /// `let pool = request.build()?; query.execute(pool)` is HTTP: the names
    /// `query` / `pool` alone do not make a SQLx call — the exemption needs an
    /// actual `sqlx::query` value (Codex PRRT_kwDOTwzAKs65i9UG).
    #[test]
    fn codex_thread_query_pool_names_are_not_sqlx() {
        let http = [
            r#"async fn f() { let pool = request.build()?; query.execute(pool).await?; }"#,
            r#"async fn f() { let query = client; let pool = request.build()?; query.execute(pool).await?; }"#,
        ];
        for sample in http {
            assert_eq!(credentialed_send_https_gaps(sample), (1, 1), "{sample}");
        }
        let db = [
            r#"async fn f() { let query = sqlx::query("select 1"); let pool = request.build()?; query.execute(pool).await?; }"#,
        ];
        for sample in db {
            assert_eq!(credentialed_send_https_gaps(sample), (0, 0), "{sample}");
        }
    }
}
