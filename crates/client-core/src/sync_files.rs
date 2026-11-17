//! Bounded native persistence for ciphertext sync stores.

use crate::{sync_limits, ClientCoreError, DeviceKey, SyncStore, MAX_SYNC_JSON_BYTES};

impl SyncStore {
    /// Native filesystem persistence (OPFS equivalent for browsers lives in packages/client-core).
    #[cfg(not(target_arch = "wasm32"))]
    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    pub fn save_path(
        &self,
        key: &DeviceKey,
        path: &std::path::Path,
    ) -> Result<(), ClientCoreError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| ClientCoreError::Persist(e.to_string()))?;
        }
        let json = self.to_persisted_json(key)?;
        // Refuse to write if plaintext-looking keys somehow appear (defense in depth).
        if json.contains("\"plaintext\"") {
            return Err(ClientCoreError::Persist(
                "refusing to persist structure with plaintext field".into(),
            ));
        }
        std::fs::write(path, json).map_err(|e| ClientCoreError::Persist(e.to_string()))
    }

    #[cfg(not(target_arch = "wasm32"))]
    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    pub fn load_path(key: &DeviceKey, path: &std::path::Path) -> Result<Self, ClientCoreError> {
        use std::io::Read as _;
        let before =
            std::fs::metadata(path).map_err(|e| ClientCoreError::Persist(e.to_string()))?;
        if !before.is_file() || before.len() > MAX_SYNC_JSON_BYTES as u64 {
            return Err(ClientCoreError::Persist(
                "invalid or oversized sync file".into(),
            ));
        }
        let mut options = std::fs::OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt as _;
            options.custom_flags(libc::O_NONBLOCK | libc::O_CLOEXEC);
        }
        let file = options
            .open(path)
            .map_err(|e| ClientCoreError::Persist(e.to_string()))?;
        let metadata = file
            .metadata()
            .map_err(|e| ClientCoreError::Persist(e.to_string()))?;
        if !metadata.is_file() || metadata.len() > MAX_SYNC_JSON_BYTES as u64 {
            return Err(ClientCoreError::Persist(
                "invalid or oversized sync file".into(),
            ));
        }
        let mut bytes = Vec::new();
        file.take(MAX_SYNC_JSON_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| ClientCoreError::Persist(e.to_string()))?;
        sync_limits::check_json_size(bytes.len())?;
        let json = String::from_utf8(bytes)
            .map_err(|_| ClientCoreError::Persist("sync file is not UTF-8".into()))?;
        Self::from_persisted_json(key, &json)
    }
}
