//! An exact-tuple, deny-by-default [`RemotePdp`] for consumer tests.
//!
//! This does not interpret an `OpenFGA` authorization model, including
//! usersets, inherited relations, wildcards, conditions, or consistency.

use std::collections::HashSet;
use std::sync::{Arc, RwLock, RwLockReadGuard, RwLockWriteGuard};

use async_trait::async_trait;

use crate::{OpenFgaError, RemotePdp, Result, TupleKey};

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct Key {
    user: String,
    relation: String,
    object: String,
}

impl Key {
    fn from_tuple(tuple: &TupleKey) -> Result<Self> {
        if tuple.user.trim().is_empty()
            || tuple.relation.trim().is_empty()
            || tuple.object.trim().is_empty()
        {
            return Err(OpenFgaError::Config("empty test tuple field".into()));
        }
        Ok(Self {
            user: tuple.user.clone(),
            relation: tuple.relation.clone(),
            object: tuple.object.clone(),
        })
    }
}

#[derive(Default)]
struct State {
    allowed: HashSet<Key>,
    unavailable: bool,
    closed: bool,
}

/// A fresh instance denies all checks. Clones share state; create one per test.
#[derive(Clone, Default)]
pub struct FakeRemotePdp {
    state: Arc<RwLock<State>>,
}

impl FakeRemotePdp {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    fn read(&self) -> Result<RwLockReadGuard<'_, State>> {
        self.state
            .read()
            .map_err(|_| OpenFgaError::Unavailable("test PDP state unavailable".into()))
    }

    fn write(&self) -> Result<RwLockWriteGuard<'_, State>> {
        self.state
            .write()
            .map_err(|_| OpenFgaError::Unavailable("test PDP state unavailable".into()))
    }

    /// Permit this exact tuple. No other relationship is implied.
    ///
    /// # Errors
    ///
    /// Empty fields, a closed instance, or unavailable internal state.
    pub fn allow(&self, tuple: &TupleKey) -> Result<()> {
        let key = Key::from_tuple(tuple)?;
        let mut state = self.write()?;
        ensure_open(&state)?;
        state.allowed.insert(key);
        Ok(())
    }

    /// Remove this exact permission; removing an absent tuple is harmless.
    ///
    /// # Errors
    ///
    /// Empty fields, a closed instance, or unavailable internal state.
    pub fn revoke(&self, tuple: &TupleKey) -> Result<()> {
        let key = Key::from_tuple(tuple)?;
        let mut state = self.write()?;
        ensure_open(&state)?;
        state.allowed.remove(&key);
        Ok(())
    }

    /// Make checks fail as unavailable (or restore the existing seeded state).
    ///
    /// # Errors
    ///
    /// A closed instance or unavailable internal state.
    pub fn set_unavailable(&self, unavailable: bool) -> Result<()> {
        let mut state = self.write()?;
        ensure_open(&state)?;
        state.unavailable = unavailable;
        Ok(())
    }

    /// Clear permissions and restore availability. A closed instance stays closed.
    ///
    /// # Errors
    ///
    /// A closed instance or unavailable internal state.
    pub fn reset(&self) -> Result<()> {
        let mut state = self.write()?;
        ensure_open(&state)?;
        state.allowed.clear();
        state.unavailable = false;
        Ok(())
    }

    /// Clear and permanently close this instance, including all of its clones.
    ///
    /// # Errors
    ///
    /// Unavailable internal state.
    pub fn close(&self) -> Result<()> {
        let mut state = self.write()?;
        state.allowed.clear();
        state.closed = true;
        Ok(())
    }
}

fn ensure_open(state: &State) -> Result<()> {
    if state.closed {
        return Err(OpenFgaError::Unavailable("test PDP closed".into()));
    }
    Ok(())
}

#[async_trait]
impl RemotePdp for FakeRemotePdp {
    async fn check(&self, tuple: &TupleKey) -> Result<bool> {
        let key = Key::from_tuple(tuple)?;
        let state = self.read()?;
        ensure_open(&state)?;
        if state.unavailable {
            return Err(OpenFgaError::Unavailable("test PDP unavailable".into()));
        }
        Ok(state.allowed.contains(&key))
    }
}
