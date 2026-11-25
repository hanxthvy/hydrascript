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

/// Shared with `runtime/hydra.ts`. Changing one without the other breaks every
/// veiled string, so both sides say so in a comment.
pub const KEY: &[u8] = b"hydra-veil-key/2026";

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

/// XOR then base64. Symmetric, so the runtime is the same operation in reverse.
pub fn encode(plain: &str) -> String {
    let keyed: Vec<u8> = plain
        .as_bytes()
        .iter()
        .enumerate()
        .map(|(i, b)| b ^ KEY[i % KEY.len()])
        .collect();
    b64(&keyed)
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

    #[test]
    fn encode_is_symmetric_with_the_runtime_recipe() {
        let plain = "kontak@contoh.id";
        let enc = encode(plain);
        // decode exactly the way the runtime does: base64, then XOR
        const A: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut bits = Vec::new();
        for c in enc.chars().filter(|c| *c != '=') {
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
        let out: String = bytes
            .iter()
            .enumerate()
            .map(|(i, b)| (b ^ KEY[i % KEY.len()]) as char)
            .collect();
        assert_eq!(out, plain);
        assert!(!enc.contains('@'), "the veiled form must not contain the grep bait");
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
