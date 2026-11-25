//! Helpers that are not about state: asset specifiers, JSON escaping, and
//! whether a body contains a yield.

use crate::ast::{Kind, Node};


pub fn asset_import(spec: &str) -> bool {
    let lower = spec.to_ascii_lowercase();
    let path = lower.split(['?', '#']).next().unwrap_or(&lower);
    const EXTS: &[&str] = &[
        ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico", ".bmp", ".css", ".scss",
        ".sass", ".less", ".woff", ".woff2", ".ttf", ".otf", ".eot", ".mp4", ".webm", ".mp3",
        ".wav", ".ogg", ".glb", ".gltf", ".wasm", ".pdf",
    ];
    EXTS.iter().any(|e| path.ends_with(e))
}

pub(super) fn json_escape(s: &str) -> String {
    let mut o = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            '\t' => o.push_str("\\t"),
            other => o.push(other),
        }
    }
    o.push('"');
    o
}

/// True when a function body contains `yield` at its own level (nested
/// functions excluded): such a function is a generator, and JS requires the
/// `*` on the declaration or the emitted `yield` is a syntax error.
pub(super) fn body_has_yield(body: &[Node]) -> bool {
    fn walk(n: &Node) -> bool {
        match &n.kind {
            Kind::Yield(_) => true,
            Kind::If { body, orelse, .. } => {
                body.iter().any(walk) || orelse.as_ref().is_some_and(|b| b.iter().any(walk))
            }
            Kind::While { body, .. } | Kind::For { body, .. } => body.iter().any(walk),
            Kind::Try {
                body,
                handlers,
                finally,
                ..
            } => {
                body.iter().any(walk)
                    || handlers.iter().any(|c| c.body.iter().any(walk))
                    || finally.as_ref().is_some_and(|f| f.iter().any(walk))
            }
            _ => false,
        }
    }
    body.iter().any(walk)
}
