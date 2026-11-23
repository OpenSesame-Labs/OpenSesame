use super::*;
use opensesame_storage::authority::ProjectionMark;

pub(super) async fn catch_up_openfga_projection(
    state: &AppState,
    organization_id: &str,
    grant_id: &str,
) {
    let fenced = state
        .db
        .fenced_authority(organization_id, grant_id, Utc::now())
        .await
        .expect("fenced authority")
        .expect("authority sidecar");
    state
        .db
        .mark_projection_dirty(&ProjectionMark {
            store: "openfga",
            organization_id,
            subject_kind: "grant",
            subject_id: grant_id,
            committed_revision: fenced.revision,
        })
        .await
        .expect("mark dirty");
    assert!(state
        .db
        .record_projection_applied(
            &ProjectionMark {
                store: "openfga",
                organization_id,
                subject_kind: "grant",
                subject_id: grant_id,
                committed_revision: fenced.revision,
            },
            None,
        )
        .await
        .expect("record applied"));
}
