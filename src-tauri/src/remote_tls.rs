//! HTTPS for a single, explicitly selected network interface.

use std::io;
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use rcgen::{
    BasicConstraints, CertificateParams, CertifiedIssuer, DnType, ExtendedKeyUsagePurpose, IsCa, KeyPair,
    KeyUsagePurpose,
};
use rustls::pki_types::PrivatePkcs8KeyDer;
use time::OffsetDateTime;
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinSet;
use tokio_rustls::{TlsAcceptor, server::TlsStream};

pub(crate) struct CertificateAuthority(CertifiedIssuer<'static, KeyPair>);

impl CertificateAuthority {
    pub fn new() -> Result<Self, rcgen::Error> {
        let mut params = CertificateParams::default();
        params
            .distinguished_name
            .push(DnType::CommonName, "Terminal Canvas Browser Access");
        params.is_ca = IsCa::Ca(BasicConstraints::Constrained(0));
        params.key_usages = vec![KeyUsagePurpose::KeyCertSign];
        let now = OffsetDateTime::now_utc();
        params.not_before = now - time::Duration::days(1);
        params.not_after = now + time::Duration::days(365);
        CertifiedIssuer::self_signed(params, KeyPair::generate()?).map(Self)
    }

    pub fn certificate(&self) -> &[u8] {
        self.0.der().as_ref()
    }

    pub fn acceptor(&self, address: Ipv4Addr) -> Result<TlsAcceptor, String> {
        let mut params = CertificateParams::new(vec![address.to_string()]).map_err(|error| error.to_string())?;
        params.distinguished_name.push(DnType::CommonName, address.to_string());
        params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
        let now = OffsetDateTime::now_utc();
        params.not_before = now - time::Duration::days(1);
        params.not_after = now + time::Duration::days(90);
        let key = KeyPair::generate().map_err(|error| error.to_string())?;
        let cert = params.signed_by(&key, &self.0).map_err(|error| error.to_string())?;
        let config = rustls::ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .map_err(|error| error.to_string())?
            .with_no_client_auth()
            .with_single_cert(
                vec![cert.der().clone()],
                PrivatePkcs8KeyDer::from(key.serialize_der()).into(),
            )
            .map_err(|error| error.to_string())?;
        Ok(TlsAcceptor::from(Arc::new(config)))
    }
}

pub(crate) struct Listener {
    tcp: TcpListener,
    acceptor: TlsAcceptor,
    handshakes: JoinSet<Option<(TlsStream<TcpStream>, SocketAddr)>>,
}

impl Listener {
    pub fn new(tcp: TcpListener, acceptor: TlsAcceptor) -> Self {
        Self {
            tcp,
            acceptor,
            handshakes: JoinSet::new(),
        }
    }
}

impl axum::serve::Listener for Listener {
    type Io = TlsStream<TcpStream>;
    type Addr = SocketAddr;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        loop {
            tokio::select! {
                connection = self.tcp.accept(), if self.handshakes.len() < 16 => match connection {
                    Ok((stream, address)) => {
                        let acceptor = self.acceptor.clone();
                        self.handshakes.spawn(async move {
                            let stream = tokio::time::timeout(Duration::from_secs(5), acceptor.accept(stream)).await.ok()?.ok()?;
                            Some((stream, address))
                        });
                    }
                    Err(_) => tokio::time::sleep(Duration::from_secs(1)).await,
                },
                Some(result) = self.handshakes.join_next(), if !self.handshakes.is_empty() => {
                    if let Ok(Some(connection)) = result { return connection; }
                }
            }
        }
    }

    fn local_addr(&self) -> io::Result<Self::Addr> {
        self.tcp.local_addr()
    }
}
