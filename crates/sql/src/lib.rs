//! Repository database facade: `SQLite` and `PostgreSQL` runtime APIs only.
//!
//! Depend directly on the drivers so unused `SQLx` macro and `MySQL` dependencies
//! are absent from the lockfile as well as the compiled feature graph.
use sqlx_core::arguments::IntoArguments;
use sqlx_core::database::Database;
use sqlx_core::query::{Query, query_with as core_query_with};
use sqlx_core::query_as::{QueryAs, query_as_with as core_query_as_with};
use sqlx_core::query_scalar::{QueryScalar, query_scalar_with as core_query_scalar_with};

pub use sqlx_core::acquire::Acquire;
pub use sqlx_core::connection::{ConnectOptions, Connection};
pub use sqlx_core::error::{Error, Result};
pub use sqlx_core::executor::{Execute, Executor};
pub use sqlx_core::from_row::FromRow;
pub use sqlx_core::pool::Pool;
pub use sqlx_core::query_builder::QueryBuilder;
pub use sqlx_core::raw_sql::RawSql;
pub use sqlx_core::row::Row;
pub use sqlx_core::sql_str::AssertSqlSafe;
pub use sqlx_core::transaction::Transaction;
pub use sqlx_core::{error, migrate, pool, query_builder, types};
pub use sqlx_postgres::{self as postgres, PgConnection, PgPool, Postgres};
pub use sqlx_sqlite::{self as sqlite, Sqlite, SqliteConnection, SqlitePool};

/// SQLx 0.9 accepts only `'static` SQL literals unless wrapped in [`AssertSqlSafe`].
/// Host SQL in this repo is reviewed (see `tools/security/ast-grep-rules.yml`); the
/// facade wraps dynamic `&str` the same way audited call sites would.
pub fn query<DB>(sql: &str) -> Query<'_, DB, <DB as Database>::Arguments>
where
    DB: Database,
{
    sqlx_core::query::query(sqlx_core::sql_str::AssertSqlSafe(sql))
}

pub fn query_with<'q, DB, A>(sql: &str, arguments: A) -> Query<'q, DB, A>
where
    DB: Database,
    A: 'q + IntoArguments<DB>,
{
    core_query_with(sqlx_core::sql_str::AssertSqlSafe(sql), arguments)
}

pub fn query_as<'q, DB, O>(sql: &str) -> QueryAs<'q, DB, O, <DB as Database>::Arguments>
where
    DB: Database,
    O: for<'r> FromRow<'r, DB::Row>,
{
    sqlx_core::query_as::query_as(sqlx_core::sql_str::AssertSqlSafe(sql))
}

pub fn query_as_with<'q, DB, O, A>(sql: &str, arguments: A) -> QueryAs<'q, DB, O, A>
where
    DB: Database,
    O: for<'r> FromRow<'r, DB::Row>,
    A: 'q + IntoArguments<DB>,
{
    core_query_as_with(sqlx_core::sql_str::AssertSqlSafe(sql), arguments)
}

pub fn query_scalar<'q, DB, O>(
    sql: &str,
) -> QueryScalar<'q, DB, O, <DB as Database>::Arguments>
where
    DB: Database,
    (O,): for<'r> FromRow<'r, DB::Row>,
{
    sqlx_core::query_scalar::query_scalar(sqlx_core::sql_str::AssertSqlSafe(sql))
}

pub fn query_scalar_with<'q, DB, O, A>(
    sql: &str,
    arguments: A,
) -> QueryScalar<'q, DB, O, A>
where
    DB: Database,
    A: IntoArguments<DB>,
    (O,): for<'r> FromRow<'r, DB::Row>,
{
    core_query_scalar_with(sqlx_core::sql_str::AssertSqlSafe(sql), arguments)
}

pub fn raw_sql(sql: &str) -> RawSql {
    sqlx_core::raw_sql::raw_sql(sqlx_core::sql_str::AssertSqlSafe(sql))
}
