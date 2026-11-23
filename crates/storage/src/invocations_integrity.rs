//! Bind mutable SQL links to the authenticated invocation and signed receipt.

use opensesame_domain::{IntentId, Invocation, InvocationId, ReceiptId};
use sqlx::{sqlite::SqliteRow, Row};

use super::{decode_receipt_for_organization, StoredReceipt};
use crate::sealed;

pub(super) fn linked_receipt(row: &SqliteRow) -> anyhow::Result<StoredReceipt> {
    let organization: String = row.get("authoritative_organization_id");
    let receipt_id: String = row.get("receipt_id");
    let invocation_id: String = row.get("invocation_id");
    let intent_id: String = row.get("intent_id");
    let receipt_body = sealed::open_in(
        &organization,
        "receipts.body_json",
        &receipt_id,
        &row.get::<String, _>("receipt_body_json"),
    )?;
    let stored = decode_receipt_for_organization(&receipt_body, &organization)?;
    let invocation_body = sealed::open_in(
        &organization,
        "invocations.body_json",
        &invocation_id,
        &row.get::<String, _>("invocation_body_json"),
    )?;
    let invocation: Invocation = serde_json::from_str(&invocation_body)?;
    anyhow::ensure!(
        stored.receipt.id == ReceiptId::parse(&receipt_id)?
            && stored.receipt.invocation_id == invocation.id
            && invocation.id == InvocationId::parse(&invocation_id)?
            && invocation.intent_id == IntentId::parse(&intent_id)?,
        "receipt or invocation does not match its stored links"
    );
    Ok(stored)
}
