//! `veil("...")`: a string that should not be greppable in a built bundle.
//!
//! What this is: a build-time transform. The literal is XORed against a key that
//! lives in both this compiler and the runtime, base64'd, and emitted as
//! `__veil("...")`. The runtime undoes it on first use.
//!
//! What this is NOT: encryption. The key ships with the code that uses it, so
//! anyone who opens a console can recover the value in one line. The point is to
//! defeat the machine that greps a directory for `@` or `https://` and the person
//! who copies a promo code out of `dist/` — not the person who runs the app.
//!
//! Because of that, a value that is actually a credential is a COMPILE ERROR
//! rather than an encrypted string: see `looks_like_secret`. The mistake this
//! guards against is not using veil, it is using veil for the wrong thing.

// Three layers, each chosen because it defeats a specific automated attack:
//
//   1. a key PER VALUE, derived from the value itself — no constant to grep, and
//      one recovered key does not open the next value;
//   2. a byte REVERSAL after the XOR — base64-decoding a payload yields noise,
//      not the tail of the plaintext sitting there in order;
//   3. the payload SPLIT into pieces — the longest encoded run in the bundle is
//      short, and a scraper looking for one string finds three.
//
// None of this is encryption, and the code is written so it cannot be mistaken
// for it: there is no key constant left to find, and the runtime helper the
// compiler emits is reachable from a console in one line.

/// Standard base64, no dependencies. Padding is kept because the runtime uses
/// `atob`, which insists on it.
fn b64(bytes: &[u8]) -> String {
    const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(A[(n >> 18) as usize & 63] as char);
        out.push(A[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { A[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { A[n as usize & 63] as char } else { '=' });
    }
    out
}

/// A per-value key.
///
/// Derived, not random: the same source must produce the same bundle, or builds
/// stop being reproducible and a compile cache keyed on the output is worthless.
/// The seed mixes the value, its length and a per-call salt, so two identical
/// strings in one file still get different keys.
pub fn key_for(plain: &str, salt: u32) -> Vec<u8> {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325 ^ salt as u64;
    for b in plain.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h ^= (plain.len() as u64) << 32;
    let mut x = h | 1;
    let mut out = Vec::with_capacity(16);
    for _ in 0..16 {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        out.push((x & 0xff) as u8);
    }
    out
}

/// Encode `plain` into (parts, key).
///
/// The runtime joins the parts, base64-decodes, XORs with the key, then reverses
/// the bytes: the same three layers, undone in the opposite order.
pub fn encode(plain: &str, salt: u32) -> (Vec<String>, Vec<u8>) {
    let key = key_for(plain, salt);
    let mut bytes: Vec<u8> = plain
        .as_bytes()
        .iter()
        .enumerate()
        .map(|(i, b)| b ^ key[i % key.len()])
        .collect();
    bytes.reverse();
    let encoded = b64(&bytes);
    let pieces = if encoded.len() <= 6 { 1 } else { 3 };
    let size = (encoded.len() + pieces - 1) / pieces;
    let parts: Vec<String> = encoded
        .as_bytes()
        .chunks(size.max(1))
        .map(|c| String::from_utf8_lossy(c).to_string())
        .collect();
    (parts, key)
}

/// Strip the surrounding quotes of a `Kind::Str` value.
pub fn literal_body(raw: &str) -> String {
    let bytes: Vec<char> = raw.chars().collect();
    if bytes.len() >= 2 && (bytes[0] == '"' || bytes[0] == '\'') {
        bytes[1..bytes.len() - 1].iter().collect()
    } else {
        raw.to_string()
    }
}

/// The shapes that must never be veiled, because veiling them would imply they
/// are safe to ship.
///
/// Deliberately narrow: a false positive here refuses a build, so this matches
/// the fingerprints, not the idea of a secret.
pub fn looks_like_secret(s: &str) -> Option<&'static str> {
    if s.starts_with("AKIA") && s.len() == 20 {
        return Some("an AWS access key id");
    }
    if s.starts_with("-----BEGIN") && s.contains("PRIVATE KEY") {
        return Some("a private key");
    }
    if s.starts_with("eyJ") && s.matches('.').count() == 2 && s.len() > 60 {
        return Some("a JWT");
    }
    if s.starts_with("sk-") && s.len() > 30 {
        return Some("an API secret key");
    }
    if s.len() == 40 && s.chars().all(|c| c.is_ascii_hexdigit()) {
        return Some("a 40-character hex key");
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The runtime's recipe, written out in Rust, so the two halves are checked
    /// against each other rather than against themselves.
    fn decode(parts: &[String], key: &[u8]) -> String {
        const A: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let joined: String = parts.concat();
        let mut bits = Vec::new();
        for c in joined.chars().filter(|c| *c != '=') {
            bits.push(A.find(c).expect("b64 alphabet") as u8);
        }
        let mut bytes = Vec::new();
        for chunk in bits.chunks(4) {
            let mut n: u32 = 0;
            for (i, b) in chunk.iter().enumerate() {
                n |= (*b as u32) << (18 - 6 * i);
            }
            bytes.push((n >> 16) as u8);
            if chunk.len() > 2 {
                bytes.push((n >> 8) as u8);
            }
            if chunk.len() > 3 {
                bytes.push(n as u8);
            }
        }
        bytes.reverse();
        let out: Vec<u8> = bytes
            .iter()
            .enumerate()
            .map(|(i, b)| b ^ key[i % key.len()])
            .collect();
        String::from_utf8(out).expect("utf8")
    }

    #[test]
    fn round_trips_ascii_and_utf8() {
        for (i, s) in ["kontak@contoh.id", "ünïcode ✓", "a", ""].iter().enumerate() {
            let (parts, key) = encode(s, i as u32);
            assert_eq!(decode(&parts, &key), *s, "round trip for {s:?}");
        }
    }

    #[test]
    fn the_plaintext_does_not_survive_inside_one_part() {
        let plain = "promo-SECRET-2026";
        let (parts, _) = encode(plain, 0);
        for p in &parts {
            assert!(!p.contains("promo"), "a part carried the prefix: {p}");
            assert!(!p.contains("SECRET"), "a part carried the secret: {p}");
        }
        assert!(parts.len() > 1, "a payload this size must be split");
    }

    #[test]
    fn a_different_salt_or_value_gets_a_different_key() {
        let (_, k1) = encode("same", 0);
        let (_, k2) = encode("same", 1);
        assert_ne!(k1, k2, "the salt must move the key");
        let (_, k3) = encode("different", 0);
        assert_ne!(k1, k3, "the value must move the key");
        assert_eq!(encode("x", 7), encode("x", 7), "a build must be reproducible");
    }

    #[test]
    fn quotes_are_stripped() {
        assert_eq!(literal_body("\"a@b.c\""), "a@b.c");
        assert_eq!(literal_body("'x'"), "x");
    }

    #[test]
    fn credentials_are_refused() {
        assert!(looks_like_secret("AKIAABCDEFGHIJKLMNOP").is_some());
        assert!(looks_like_secret("-----BEGIN RSA PRIVATE KEY-----").is_some());
        assert!(looks_like_secret("sk-" ).is_none(), "too short to be a key");
        assert!(looks_like_secret("kontak@contoh.id").is_none());
        assert!(looks_like_secret("https://internal.example/api").is_none());
    }
}
