//! Chain-depth bounds around rustls's built-in verifiers.
//!
//! `rustls-webpki` allows up to six sub-CAs on a path; this crate promises
//! [`MAX_CHAIN_DEPTH`] certificates in total (leaf plus intermediates) on
//! every verifier, so the built-in `WebPKI` verifiers are wrapped and a longer
//! presented chain is refused before path building starts. A SPIFFE client
//! bundle also requires the verified leaf to satisfy its explicit domain and
//! X.509-SVID profile; handshake signatures remain delegated to rustls.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::server::danger::{ClientCertVerified, ClientCertVerifier};
use rustls::{DigitallySignedStruct, DistinguishedName, SignatureScheme};

use crate::error::pki_error;
use crate::svid_profile::SvidRole;
use crate::svid_tls::verify_svid;
use crate::MAX_CHAIN_DEPTH;

fn check_depth(intermediates: &[CertificateDer<'_>]) -> Result<(), rustls::Error> {
    if intermediates.len() + 1 > MAX_CHAIN_DEPTH {
        return Err(pki_error(webpki::Error::MaximumPathDepthExceeded));
    }
    Ok(())
}

/// A client-certificate verifier that refuses chains longer than
/// [`MAX_CHAIN_DEPTH`] and delegates the rest.
#[derive(Debug)]
pub(crate) struct BoundedClientVerifier {
    inner: Arc<dyn ClientCertVerifier>,
    spiffe_domain: Option<String>,
}

impl BoundedClientVerifier {
    pub(crate) fn new(
        inner: Arc<dyn ClientCertVerifier>,
        spiffe_domain: Option<String>,
    ) -> Arc<Self> {
        Arc::new(Self {
            inner,
            spiffe_domain,
        })
    }
}

impl ClientCertVerifier for BoundedClientVerifier {
    fn offer_client_auth(&self) -> bool {
        self.inner.offer_client_auth()
    }

    fn client_auth_mandatory(&self) -> bool {
        self.inner.client_auth_mandatory()
    }

    fn root_hint_subjects(&self) -> &[DistinguishedName] {
        self.inner.root_hint_subjects()
    }

    fn verify_client_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        now: UnixTime,
    ) -> Result<ClientCertVerified, rustls::Error> {
        check_depth(intermediates)?;
        let verified = self
            .inner
            .verify_client_cert(end_entity, intermediates, now)?;
        if let Some(domain) = &self.spiffe_domain {
            verify_svid(end_entity, domain, None, SvidRole::Client, now)?;
        }
        Ok(verified)
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls12_signature(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.inner.supported_verify_schemes()
    }

    fn requires_raw_public_keys(&self) -> bool {
        self.inner.requires_raw_public_keys()
    }
}

/// A server-certificate verifier that refuses chains longer than
/// [`MAX_CHAIN_DEPTH`] and delegates the rest.
#[derive(Debug)]
pub(crate) struct BoundedServerVerifier {
    inner: Arc<dyn ServerCertVerifier>,
}

impl BoundedServerVerifier {
    pub(crate) fn new(inner: Arc<dyn ServerCertVerifier>) -> Arc<Self> {
        Arc::new(Self { inner })
    }
}

impl ServerCertVerifier for BoundedServerVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        check_depth(intermediates)?;
        self.inner
            .verify_server_cert(end_entity, intermediates, server_name, ocsp_response, now)
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls12_signature(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.inner.supported_verify_schemes()
    }

    fn requires_raw_public_keys(&self) -> bool {
        self.inner.requires_raw_public_keys()
    }

    fn root_hint_subjects(&self) -> Option<&[DistinguishedName]> {
        self.inner.root_hint_subjects()
    }
}

/// Admit only the first server certificate verification made by the shared
/// configuration. The allowance is consumed even if verification fails.
#[derive(Debug)]
pub(crate) struct SingleHandshakeServerVerifier {
    inner: Arc<dyn ServerCertVerifier>,
    used: AtomicBool,
}

impl SingleHandshakeServerVerifier {
    pub(crate) fn new(inner: Arc<dyn ServerCertVerifier>) -> Arc<Self> {
        Arc::new(Self {
            inner,
            used: AtomicBool::new(false),
        })
    }
}

impl ServerCertVerifier for SingleHandshakeServerVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        if self.used.swap(true, Ordering::AcqRel) {
            return Err(rustls::Error::General(
                "single-handshake TLS configuration already used".to_owned(),
            ));
        }
        self.inner
            .verify_server_cert(end_entity, intermediates, server_name, ocsp_response, now)
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls12_signature(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.inner.supported_verify_schemes()
    }

    fn requires_raw_public_keys(&self) -> bool {
        self.inner.requires_raw_public_keys()
    }

    fn root_hint_subjects(&self) -> Option<&[DistinguishedName]> {
        self.inner.root_hint_subjects()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::time::Duration;

    #[derive(Debug)]
    struct CountingVerifier {
        calls: AtomicUsize,
        succeeds: bool,
    }

    impl ServerCertVerifier for CountingVerifier {
        fn verify_server_cert(
            &self,
            _end_entity: &CertificateDer<'_>,
            _intermediates: &[CertificateDer<'_>],
            _server_name: &ServerName<'_>,
            _ocsp_response: &[u8],
            _now: UnixTime,
        ) -> Result<ServerCertVerified, rustls::Error> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if self.succeeds {
                Ok(ServerCertVerified::assertion())
            } else {
                Err(rustls::Error::General("underlying verifier refused".into()))
            }
        }

        fn verify_tls12_signature(
            &self,
            _message: &[u8],
            _cert: &CertificateDer<'_>,
            _dss: &DigitallySignedStruct,
        ) -> Result<HandshakeSignatureValid, rustls::Error> {
            unreachable!()
        }

        fn verify_tls13_signature(
            &self,
            _message: &[u8],
            _cert: &CertificateDer<'_>,
            _dss: &DigitallySignedStruct,
        ) -> Result<HandshakeSignatureValid, rustls::Error> {
            unreachable!()
        }

        fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
            Vec::new()
        }
    }

    fn attempt(gate: &SingleHandshakeServerVerifier) -> Result<ServerCertVerified, rustls::Error> {
        gate.verify_server_cert(
            &CertificateDer::from(vec![0]),
            &[],
            &ServerName::try_from("localhost").unwrap(),
            &[],
            UnixTime::since_unix_epoch(Duration::ZERO),
        )
    }

    fn record_admission(gate: &SingleHandshakeServerVerifier, admitted: &AtomicUsize) {
        if attempt(gate).is_ok() {
            admitted.fetch_add(1, Ordering::SeqCst);
        }
    }

    #[test]
    fn single_handshake_gate_consumes_failed_and_concurrent_attempts() {
        for succeeds in [false, true] {
            let inner = Arc::new(CountingVerifier {
                calls: AtomicUsize::new(0),
                succeeds,
            });
            let gate = SingleHandshakeServerVerifier::new(inner.clone());
            assert_eq!(attempt(&gate).is_ok(), succeeds);
            assert!(attempt(&gate).is_err(), "second attempt was admitted");
            assert_eq!(inner.calls.load(Ordering::SeqCst), 1);
        }
        let inner = Arc::new(CountingVerifier {
            calls: AtomicUsize::new(0),
            succeeds: true,
        });
        let gate = SingleHandshakeServerVerifier::new(inner.clone());
        let admitted = AtomicUsize::new(0);
        std::thread::scope(|scope| {
            for _ in 0..2 {
                let _ = scope.spawn(|| record_admission(&gate, &admitted));
            }
        });
        assert_eq!(admitted.load(Ordering::SeqCst), 1);
        assert_eq!(inner.calls.load(Ordering::SeqCst), 1);
    }
}
