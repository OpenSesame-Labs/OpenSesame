//! Optional wasm-bindgen façade for browser/extension (feature `wasm-bindgen`).
use crate::{open, open_sync_blob, seal, DeviceKey, SyncBlob, SyncCursor, SyncStore};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct WasmDeviceKey {
    inner: DeviceKey,
}

#[wasm_bindgen]
impl WasmDeviceKey {
    #[wasm_bindgen(constructor)]
    #[must_use]
    pub fn generate() -> WasmDeviceKey {
        WasmDeviceKey {
            inner: DeviceKey::generate(),
        }
    }

    /// Restore a client-held sync key supplied by the application.
    ///
    /// # Errors
    ///
    /// Returns an error unless the key is exactly 32 bytes.
    pub fn from_bytes(bytes: &[u8]) -> Result<WasmDeviceKey, JsValue> {
        let key: [u8; 32] = bytes
            .try_into()
            .map_err(|_| JsValue::from_str("sync key must be 32 bytes"))?;
        Ok(WasmDeviceKey {
            inner: DeviceKey::from_bytes(key),
        })
    }
}

#[wasm_bindgen]
///
/// # Errors
///
/// Returns an error when validation or the underlying operation fails.
pub fn wasm_seal(key: &WasmDeviceKey, plaintext: &[u8], aad: &[u8]) -> Result<Vec<u8>, JsValue> {
    seal(&key.inner, plaintext, aad).map_err(|e| JsValue::from_str(&e.to_string()))
}

#[wasm_bindgen]
///
/// # Errors
///
/// Returns an error when validation or the underlying operation fails.
pub fn wasm_open(key: &WasmDeviceKey, sealed: &[u8], aad: &[u8]) -> Result<Vec<u8>, JsValue> {
    open(&key.inner, sealed, aad).map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Authenticate and open a versioned sync blob.
///
/// # Errors
///
/// Returns an error for malformed or unauthenticated input.
#[wasm_bindgen]
pub fn wasm_open_sync_blob(key: &WasmDeviceKey, blob: JsValue) -> Result<Vec<u8>, JsValue> {
    let blob: crate::sync_limits::BoundedBlob = serde_wasm_bindgen::from_value(blob)
        .map_err(|error| JsValue::from_str(&error.to_string()))?;
    let blob: SyncBlob = blob.into();
    open_sync_blob(&key.inner, &blob).map_err(|error| JsValue::from_str(&error.to_string()))
}

#[wasm_bindgen]
pub struct WasmSyncStore {
    inner: SyncStore,
}

#[wasm_bindgen]
impl WasmSyncStore {
    #[wasm_bindgen(constructor)]
    #[must_use]
    pub fn new(device_id: String) -> WasmSyncStore {
        WasmSyncStore {
            inner: SyncStore::new(device_id),
        }
    }

    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn epoch(&self) -> u64 {
        self.inner.cursor.epoch
    }

    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn device_id(&self) -> String {
        self.inner.cursor.device_id.clone()
    }

    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    pub fn put_local(
        &mut self,
        key: &WasmDeviceKey,
        id: String,
        plaintext: &[u8],
    ) -> Result<JsValue, JsValue> {
        let blob = self
            .inner
            .put_local(&key.inner, id, plaintext)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        serde_wasm_bindgen::to_value(&blob).map_err(|e| JsValue::from_str(&e.to_string()))
    }

    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    pub fn to_persisted_json(&self, key: &WasmDeviceKey) -> Result<String, JsValue> {
        self.inner
            .to_persisted_json(&key.inner)
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    pub fn load_persisted_json(key: &WasmDeviceKey, json: &str) -> Result<WasmSyncStore, JsValue> {
        let inner = SyncStore::from_persisted_json(&key.inner, json)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        Ok(WasmSyncStore { inner })
    }

    /// Migrate a provenance-checked legacy store supplied by the person.
    /// Never use server-provided state as the trusted migration source.
    ///
    /// # Errors
    ///
    /// Returns an error for invalid or foreign-key legacy data.
    pub fn migrate_trusted_legacy_json(
        key: &WasmDeviceKey,
        json: &str,
    ) -> Result<WasmSyncStore, JsValue> {
        let inner = SyncStore::migrate_trusted_legacy_json(&key.inner, json)
            .map_err(|error| JsValue::from_str(&error.to_string()))?;
        Ok(WasmSyncStore { inner })
    }
}

#[wasm_bindgen]
#[must_use]
pub fn wit_package() -> String {
    crate::wit_contract::PACKAGE.to_string()
}

#[allow(dead_code)]
fn _cursor_shape(c: SyncCursor) -> SyncCursor {
    c
}
