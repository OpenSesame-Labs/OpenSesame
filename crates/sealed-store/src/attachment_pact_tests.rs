use super::*;
    use crate::store::{init_store, init_store_key};
    use crate::Entry;
    use tempfile::TempDir;

    fn store() -> (TempDir, StoreRoot, ItemDataKey) {
        let dir = TempDir::new().expect("tempdir");
        let root = init_store(dir.path(), &[]).expect("init");
        let key = init_store_key(dir.path(), b"correct horse").expect("key");
        (dir, root, key)
    }

    fn add(root: &StoreRoot, key: &ItemDataKey, name: &str, bytes: &[u8]) -> AttachmentSummary {
        let mut source = std::io::Cursor::new(bytes.to_vec());
        root.attach_add(
            name,
            &mut source,
            u64::try_from(bytes.len()).expect("fixture length fits u64"),
            AttachMeta {
                filename: "scan.pdf".into(),
                mime: None,
            },
            key,
            false,
        )
        .expect("attach_add")
    }

    fn get(root: &StoreRoot, key: &ItemDataKey, name: &str) -> Result<Vec<u8>, StoreError> {
        let mut sink: Vec<u8> = Vec::new();
        root.attach_get(name, &mut sink, key)?;
        Ok(sink)
    }

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

    // --- adversarial --------------------------------------------------------

    #[test]
    fn tampered_chunk_fails_closed() {
        let (_dir, root, key) = store();
        add(&root, &key, "Taxes/w2", b"sensitive");
        let (_, rel) = root.object_files().unwrap().remove(0);
        let mut frame = confined_read(&root.path, &rel).unwrap();
        let last = frame.len() - 1;
        frame[last] ^= 0x01;
        confined_write(&root.path, &rel, &frame).unwrap();
        assert!(get(&root, &key, "Taxes/w2").is_err());
    }

    #[test]
    fn chunk_from_another_attachment_cannot_be_spliced() {
        let (_dir, root, key) = store();
        add(&root, &key, "One/scan", b"first document");
        add(&root, &key, "Two/scan", b"second document");
        let objects = root.object_files().unwrap();
        let (_, first) = objects[0].clone();
        let (_, second) = objects[1].clone();
        // Overwrite one object with the other's frame. The content address no
        // longer matches, which is caught before the AEAD is even consulted.
        let stolen = confined_read(&root.path, &second).unwrap();
        confined_write(&root.path, &first, &stolen).unwrap();
        let one = get(&root, &key, "One/scan");
        let two = get(&root, &key, "Two/scan");
        assert!(one.is_err() || two.is_err());
    }

    #[test]
    fn missing_chunk_fails_closed() {
        let (_dir, root, key) = store();
        add(&root, &key, "Taxes/w2", b"sensitive");
        let (_, rel) = root.object_files().unwrap().remove(0);
        confined_remove(&root.path, &rel).unwrap();
        assert!(get(&root, &key, "Taxes/w2").is_err());
    }

    #[test]
    fn wrong_key_cannot_open_manifest() {
        let (dir, root, _key) = store();
        let key = init_store_key(dir.path(), b"first").unwrap();
        add(&root, &key, "Taxes/w2", b"sensitive");
        let other = ItemDataKey::generate();
        assert!(root.attach_ls(None, &other).is_err());
    }

    #[test]
    fn declared_length_must_match_source() {
        let (_dir, root, key) = store();
        let mut source = std::io::Cursor::new(b"only nine".to_vec());
        let result = root.attach_add(
            "Taxes/short",
            &mut source,
            9_999,
            AttachMeta {
                filename: "x.pdf".into(),
                mime: None,
            },
            &key,
            false,
        );
        assert!(result.is_err());
    }

    #[test]
    fn an_oversize_attachment_is_refused_before_anything_is_read() {
        // The ceiling is checked against the declared length before a single
        // byte is read, so this needs no gigabyte on disk. Untested, this guard
        // could be inverted and nothing else would notice.
        let (_dir, root, key) = store();
        let mut source = std::io::Cursor::new(b"tiny".to_vec());
        let err = root
            .attach_add(
                "Taxes/huge",
                &mut source,
                MAX_ATTACHMENT_BYTES + 1,
                AttachMeta {
                    filename: "x.pdf".into(),
                    mime: None,
                },
                &key,
                false,
            )
            .unwrap_err();
        assert!(
            err.to_string().contains("over the"),
            "should refuse on size, not on a later length mismatch: {err}"
        );
        // Nothing was written on the way to refusing.
        assert!(root.object_files().unwrap().is_empty());
    }

    #[test]
    fn an_overlong_filename_is_refused() {
        let (_dir, root, key) = store();
        let mut source = std::io::Cursor::new(b"x".to_vec());
        assert!(root
            .attach_add(
                "Taxes/long",
                &mut source,
                1,
                AttachMeta {
                    filename: "a".repeat(300),
                    mime: None
                },
                &key,
                false,
            )
            .is_err());
    }

    #[test]
    fn a_source_longer_than_declared_is_refused() {
        // The counterpart to declared_length_must_match_source. A file that
        // grew between stat and read must not silently seal truncated: the
        // chunk count is already bound into every frame.
        let (_dir, root, key) = store();
        let mut source = std::io::Cursor::new(vec![7u8; 5000]);
        let err = root
            .attach_add(
                "Taxes/grew",
                &mut source,
                100,
                AttachMeta {
                    filename: "x.pdf".into(),
                    mime: None,
                },
                &key,
                false,
            )
            .unwrap_err();
        assert!(
            err.to_string().contains("longer than the declared length"),
            "{err}"
        );
    }

    #[test]
    fn existing_name_needs_force() {
        let (_dir, root, key) = store();
        add(&root, &key, "Taxes/w2", b"one");
        let mut source = std::io::Cursor::new(b"two".to_vec());
        assert!(root
            .attach_add(
                "Taxes/w2",
                &mut source,
                3,
                AttachMeta {
                    filename: "x.pdf".into(),
                    mime: None
                },
                &key,
                false,
            )
            .is_err());
    }

    #[test]
    fn filename_is_sanitized_for_local_use() {
        assert_eq!(
            sanitize_filename("../../etc/passwd").as_deref(),
            Some("passwd")
        );
        assert_eq!(sanitize_filename("a/b/c.pdf").as_deref(), Some("c.pdf"));
        assert_eq!(sanitize_filename(".."), None);
        assert_eq!(sanitize_filename("   "), None);
        assert_eq!(sanitize_filename(""), None);
    }

    #[test]
    fn integer_boundaries_fail_closed_instead_of_truncating() {
        assert_eq!(saturating_millis(u128::from(u64::MAX)), u64::MAX);
        assert_eq!(saturating_millis(u128::from(u64::MAX) + 1), u64::MAX);

        assert_eq!(chunk_count_for(u64::from(u32::MAX), 1).unwrap(), u32::MAX);
        assert!(matches!(
            chunk_count_for(u64::from(u32::MAX) + 1, 1),
            Err(StoreError::Crypto(message)) if message == "attachment needs too many chunks"
        ));
        assert!(matches!(
            chunk_count_for(1, 0),
            Err(StoreError::Crypto(message)) if message == "chunk size must be non-zero"
        ));
    }

    // --- chaos --------------------------------------------------------------

    #[test]
    fn gc_spares_young_orphans_and_keeps_referenced() {
        let (_dir, root, key) = store();
        add(&root, &key, "Taxes/w2", b"sensitive");
        // Simulate a crashed add: an orphan object written moments ago.
        let orphan = object_relative(&"ab".repeat(32)).unwrap();
        confined_write(&root.path, &orphan, b"not a real frame").unwrap();
        let outcome = root.attach_gc(&key).unwrap();
        assert_eq!(outcome.removed, 0, "young orphan must survive");
        assert_eq!(outcome.skipped_recent, 1);
        assert_eq!(outcome.kept, 1);
        assert!(get(&root, &key, "Taxes/w2").is_ok());
    }

    #[test]
    fn gc_reclaims_an_orphan_once_it_is_past_the_grace_window() {
        // The other GC tests both assert nothing was removed, which leaves the
        // reclaim path itself unproven: GC could silently never free space and
        // they would all still pass. Backdate an orphan past the grace window
        // and require that it actually goes.
        let (_dir, root, key) = store();
        add(&root, &key, "Taxes/w2", b"sensitive");
        let live_before = root.object_files().unwrap().len();

        let orphan = object_relative(&"cd".repeat(32)).unwrap();
        confined_write(&root.path, &orphan, b"orphaned ciphertext").unwrap();
        let aged =
            std::time::SystemTime::now() - std::time::Duration::from_secs(GC_GRACE_SECONDS + 60);
        let handle = std::fs::File::options()
            .write(true)
            .open(root.path.join(&orphan))
            .unwrap();
        handle
            .set_times(std::fs::FileTimes::new().set_modified(aged))
            .unwrap();
        drop(handle);

        let outcome = root.attach_gc(&key).unwrap();
        assert_eq!(outcome.removed, 1, "an aged orphan must be reclaimed");
        assert_eq!(outcome.kept, live_before, "referenced chunks must survive");
        assert_eq!(outcome.skipped_recent, 0);
        assert!(!root.path.join(&orphan).exists(), "the file must be gone");
        // And the attachment that was never orphaned still opens.
        assert_eq!(get(&root, &key, "Taxes/w2").unwrap(), b"sensitive".to_vec());
    }

    #[test]
    fn gc_removes_nothing_when_a_manifest_will_not_open() {
        let (_dir, root, key) = store();
        add(&root, &key, "Taxes/w2", b"sensitive");
        let rel = attach_relative("Broken/one").unwrap();
        confined_write(&root.path, &rel, b"OSSEAL1\n{not json").unwrap();
        let before = root.object_files().unwrap().len();
        assert!(root.attach_gc(&key).is_err());
        assert_eq!(root.object_files().unwrap().len(), before);
    }

    #[test]
    fn removing_one_attachment_leaves_the_other_readable() {
        let (_dir, root, key) = store();
        add(&root, &key, "One/scan", b"first");
        add(&root, &key, "Two/scan", b"second");
        root.attach_rm("One/scan", &key).unwrap();
        assert!(get(&root, &key, "One/scan").is_err());
        assert_eq!(get(&root, &key, "Two/scan").unwrap(), b"second".to_vec());
    }

    // --- contract -----------------------------------------------------------

    #[test]
    fn listing_is_metadata_only_and_excludes_entries() {
        let (_dir, root, key) = store();
        root.insert("Dev/token", &Entry::parse("hunter2"), &key)
            .expect("entry");
        add(&root, &key, "Taxes/w2", b"sensitive");
        let listed = root.attach_ls(None, &key).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "Taxes/w2");
        assert_eq!(listed[0].filename, "scan.pdf");
        assert_eq!(listed[0].mime, "application/pdf");
        // And the entry walker still ignores attachments.
        let entries = root.ls("").unwrap();
        assert!(entries.iter().all(|e| !e.contains("Taxes/w2")));
    }

    #[test]
    fn replication_units_need_no_key() {
        let (_dir, root, key) = store();
        add(&root, &key, "Taxes/w2", b"sensitive");
        let units = root.attach_replication_units().unwrap();
        assert!(units.iter().any(|(rel, _)| rel.ends_with(".osattach")));
        assert!(units.iter().any(|(rel, _)| rel.ends_with(".oschunk")));
    }

    /// Re-seal `name`'s manifest after `mutate` has tampered with it, keeping
    /// the envelope perfectly valid. This models the one attacker who gets
    /// past the AEAD: someone holding the key.
    fn reseal_manifest_with(
        root: &StoreRoot,
        key: &ItemDataKey,
        name: &str,
        mutate: impl FnOnce(&mut AttachmentManifest),
    ) {
        let (mut manifest, _) = root.open_manifest(name, key).unwrap();
        mutate(&mut manifest);
        let revision = root.attachment_revisions().unwrap()[name];
        let plaintext = serde_json::to_vec(&manifest).unwrap();
        let sealed =
            seal_osseal_in(COLLECTION_ATTACHMENTS, &plaintext, key, name, revision).unwrap();
        confined_write(&root.path, &attach_relative(name).unwrap(), &sealed).unwrap();
    }

    #[test]
    fn a_manifest_that_decrypts_but_lies_is_refused() {
        // These guards sit behind the AEAD, so only a key-holder or a bug can
        // reach them — which is exactly why nothing was exercising them.
        let (_dir, root, key) = store();

        // Claims more chunks than it lists.
        add(&root, &key, "A/one", b"payload one");
        reseal_manifest_with(&root, &key, "A/one", |m| m.chunk_count += 1);
        assert!(get(&root, &key, "A/one").is_err(), "chunk count must agree");

        // Chunk sizes no longer sum to the declared total.
        add(&root, &key, "B/two", b"payload two");
        reseal_manifest_with(&root, &key, "B/two", |m| m.total_bytes += 512);
        assert!(get(&root, &key, "B/two").is_err(), "sizes must agree");

        // An unsupported format version.
        add(&root, &key, "C/three", b"payload three");
        reseal_manifest_with(&root, &key, "C/three", |m| m.format = 99);
        assert!(get(&root, &key, "C/three").is_err(), "format must be known");

        // A filename long enough to be a problem downstream.
        add(&root, &key, "D/four", b"payload four");
        reseal_manifest_with(&root, &key, "D/four", |m| m.filename = "z".repeat(300));
        assert!(
            get(&root, &key, "D/four").is_err(),
            "filename must be bounded"
        );

        // A digest that is not a digest never reaches the filesystem as a path.
        add(&root, &key, "E/five", b"payload five");
        reseal_manifest_with(&root, &key, "E/five", |m| {
            m.chunks[0].digest = "../../etc/passwd".into();
        });
        assert!(get(&root, &key, "E/five").is_err(), "digest must be hex");
    }

    #[test]
    fn a_chunk_of_unexpected_length_is_refused() {
        let (_dir, root, key) = store();
        add(&root, &key, "A/one", b"payload one");
        // The manifest is honest about the digest but lies about the size.
        reseal_manifest_with(&root, &key, "A/one", |m| m.chunks[0].ct_bytes += 1);
        assert!(get(&root, &key, "A/one").is_err());
    }

    #[test]
    fn manifest_is_bound_to_its_path() {
        let (_dir, root, key) = store();
        add(&root, &key, "One/scan", b"first");
        let from = attach_relative("One/scan").unwrap();
        let to = attach_relative("Two/scan").unwrap();
        let blob = confined_read(&root.path, &from).unwrap();
        confined_write(&root.path, &to, &blob).unwrap();
        // Same ciphertext, different logical path: the associated data no
        // longer reconstructs, so it must not open.
        assert!(root.attach_ls(Some("Two/"), &key).is_err());
    }
