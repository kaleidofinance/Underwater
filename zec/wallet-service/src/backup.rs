//! Sealed backups of the wallet's seed. The seed is encrypted here, inside
//! the wallet service, to the operator's backup public key, so it never
//! exists unencrypted anywhere else. Only the private key the operator keeps
//! offline opens it.
//!
//! The same sealed box as zec/server/backup.ts, byte for byte:
//!   ephemeral X25519; key = HKDF-SHA256(shared, salt = epk || recipient, info);
//!   AES-256-GCM with a random 12-byte nonce, aad = info, tag appended.

use anyhow::{anyhow, bail, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ring::{
    aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM},
    agreement::{self, EphemeralPrivateKey, UnparsedPublicKey, X25519},
    hkdf::{Salt, HKDF_SHA256},
    rand::{SecureRandom, SystemRandom},
};
use serde_json::{json, Value};

const INFO: &[u8] = b"uwzec-backup-v1";

/// Seal `plaintext` to `recipient` (a base64url X25519 public key).
pub fn seal(recipient: &str, plaintext: &[u8]) -> Result<Value> {
    let recipient = URL_SAFE_NO_PAD.decode(recipient.trim()).map_err(|e| anyhow!("backup public key: {e}"))?;
    if recipient.len() != 32 {
        bail!("a backup public key is 32 bytes");
    }
    let rng = SystemRandom::new();
    let eph = EphemeralPrivateKey::generate(&X25519, &rng).map_err(|_| anyhow!("key generation failed"))?;
    let epk = eph.compute_public_key().map_err(|_| anyhow!("public key failed"))?;
    let epk = epk.as_ref().to_vec();

    let mut salt = epk.clone();
    salt.extend_from_slice(&recipient);
    let key = agreement::agree_ephemeral(eph, &UnparsedPublicKey::new(&X25519, &recipient), |shared| {
        let prk = Salt::new(HKDF_SHA256, &salt).extract(shared);
        let okm = prk.expand(&[INFO], &AES_256_GCM).ok()?;
        Some(LessSafeKey::new(UnboundKey::from(okm)))
    })
    .map_err(|_| anyhow!("key agreement failed"))?
    .ok_or_else(|| anyhow!("key derivation failed"))?;

    let mut nonce = [0u8; 12];
    rng.fill(&mut nonce).map_err(|_| anyhow!("no randomness"))?;
    let mut data = plaintext.to_vec();
    key.seal_in_place_append_tag(Nonce::assume_unique_for_key(nonce), Aad::from(INFO), &mut data)
        .map_err(|_| anyhow!("encryption failed"))?;

    Ok(json!({
        "v": 1,
        "epk": URL_SAFE_NO_PAD.encode(&epk),
        "nonce": URL_SAFE_NO_PAD.encode(nonce),
        "ct": URL_SAFE_NO_PAD.encode(&data),
    }))
}
