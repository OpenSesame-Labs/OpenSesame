use super::pact_fixture::*;
use super::*;

// --- property -----------------------------------------------------------

#[test]
fn round_trips_across_chunk_boundaries() {
    let (_dir, root, key) = store();
    for (i, size) in [
        0usize,
        1,
        CHUNK_PLAINTEXT_BYTES - 1,
        CHUNK_PLAINTEXT_BYTES,
        CHUNK_PLAINTEXT_BYTES + 1,
        3 * CHUNK_PLAINTEXT_BYTES + 17,
    ]
    .into_iter()
    .enumerate()
    {
        let payload: Vec<u8> = (0..size)
            .map(|n| u8::try_from(n % 251).expect("fixture byte fits u8"))
            .collect();
        let name = format!("Taxes/doc{i}");
        add(&root, &key, &name, &payload);
        assert_eq!(get(&root, &key, &name).unwrap(), payload, "size {size}");
    }
}

#[test]
fn empty_attachment_writes_no_chunks() {
    let (_dir, root, key) = store();
    let summary = add(&root, &key, "Empty/file", b"");
    assert_eq!(summary.chunk_count, 0);
    assert!(root.object_files().unwrap().is_empty());
    assert_eq!(get(&root, &key, "Empty/file").unwrap(), Vec::<u8>::new());
}

#[test]
fn identical_bytes_share_no_digests() {
    let (_dir, root, key) = store();
    let payload = b"identical government id scan".to_vec();
    let a = add(&root, &key, "One/scan", &payload);
    let b = add(&root, &key, "Two/scan", &payload);
    assert_ne!(a.attachment_id, b.attachment_id);
    // Same plaintext digest, but the object pool holds two distinct frames.
    assert_eq!(a.content_digest, b.content_digest);
    assert_eq!(root.object_files().unwrap().len(), 2);
}
