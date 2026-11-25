//! The two entry points: a whole module, and its source map.

use crate::ast::{Kind, Node, Param};
use crate::error::CompileError;
use crate::emitter::Scope;

use super::*;
use super::util::json_escape;


impl JsEmitter {
    pub fn run(&mut self, module: &Node) -> Result<String, CompileError> {
        let body = match &module.kind {
            Kind::Module(stmts) => stmts,
            _ => unreachable!(),
        };

        // ponytail: top-level scope for mutability tracking
        // Collect every function signature first; a call may appear before the
        // `def` it names, and kwargs are resolved against it.
        {
            let mut table = self.fn_params.borrow_mut();
            for st in body {
                let record = |name: &str, params: &[Param], table: &mut std::collections::HashMap<String, Vec<String>>| {
                    table.insert(
                        name.to_string(),
                        params
                            .iter()
                            .map(|p| p.name.trim_start_matches("...").to_string())
                            .collect(),
                    );
                };
                match &st.kind {
                    Kind::Def { name, params, .. } | Kind::AsyncDef { name, params, .. } => {
                        record(name, params, &mut table)
                    }
                    Kind::Export(inner) => match &inner.kind {
                        Kind::Def { name, params, .. } | Kind::AsyncDef { name, params, .. } => {
                            record(name, params, &mut table)
                        }
                        _ => {}
                    },
                    _ => {}
                }
            }
        }

        // Register EVERY class in this file first: a class declared after its
        // first use would otherwise be unknown at that use, and a user's
        // `class ValidationError(Exception)` collided with the runtime's
        // exception classes — the import was emitted AND the declaration
        // followed, which does not parse (`Identifier 'ValidationError' has
        // already been declared`). The user's class must win.
        for s in body {
            if let Kind::Class { name, .. } = &s.kind {
                self.class_names.borrow_mut().insert(name.clone());
            }
        }

        let top_scope = Scope::scan(body);
        self.scopes.push(top_scope);

        for s in body {
            match &s.kind {
                Kind::Component { .. } | Kind::Tree { .. } => self.stmt(s)?,
                Kind::Import { from, names } => {
                    // Record WHERE each name came from BEFORE emitting the
                    // import line. A keyword argument at a call site is resolved
                    // against the signature in that file, and a top-level import
                    // is the only spelling most `.hys` modules use — the other
                    // match arm in `stmt` handles the ones inside a block.
                    if let Some(f) = from.as_ref() {
                        for nm in names {
                            let bare = nm.trim_start_matches("* as ").trim();
                            if !bare.is_empty() && bare != "default" {
                                self.import_specs
                                    .borrow_mut()
                                    .insert(bare.to_string(), f.clone());
                            }
                        }
                    }
                    if let Some(f) = from {
                        let mod_name = if f == "hydra_js" {
                            "hydra"
                        } else {
                            f.as_str()
                        };
                        if names.is_empty() {
                            self.imports.insert(format!("import '{}';", mod_name));
                        } else if names.len() == 1 && names[0].starts_with("* as ") {
                            self.imports
                                .insert(format!("import {} from '{}';", names[0], mod_name));
                        } else {
                            self.imports.insert(format!(
                                "import {{ {} }} from '{}';",
                                names.join(", "),
                                mod_name
                            ));
                        }
                    } else {
                        self.imports
                            .insert(format!("import {} from 'hydra';", names.join(", ")));
                    }
                }
                _ => self.stmt(s)?,
            }
        }

        self.scopes.pop();

        // Inject helpers the source used but did not import.
        let helpers: Vec<String> = self.used_helpers.borrow().iter().cloned().collect();
        if !helpers.is_empty() {
            let mut h = helpers;
            h.sort();
            // The author may already have imported some of these by hand
            // (`from "hydra" import sorted`). Emitting a second `import { sorted }`
            // is a duplicate binding, which esbuild reports as
            // "The symbol "sorted" has already been declared" — so every helper
            // already named in a hydra import is dropped from the generated one,
            // and the generated line is dropped entirely when nothing is left.
            let already: std::collections::HashSet<String> = self
                .imports
                .iter()
                .filter(|l| l.contains("from 'hydra';"))
                .flat_map(|l| {
                    l.trim()
                        .trim_start_matches("import {")
                        .split('}')
                        .next()
                        .unwrap_or("")
                        .split(',')
                        .map(|n| n.trim().to_string())
                        .collect::<Vec<_>>()
                })
                .collect();
            h.retain(|n| !already.contains(n));
            if !h.is_empty() {
                self.imports
                    .insert(format!("import {{ {} }} from 'hydra';", h.join(", ")));
            }
        }

        let mut head = vec![
            "// [xihanzu-NR]".to_string(),
            "// GENERATED by hydra — edit the .hx file, not this one".to_string(),
        ];
        let mut sorted: Vec<_> = self.imports.iter().cloned().collect();
        sorted.sort();
        head.extend(sorted);
        head.push(String::new());

        // Sisipkan `export function` yang diantre. Deklarasi fungsi diangkat
        // JavaScript, jadi urutannya tidak masalah, dan menaruhnya di atas membuat
        // satu def bisa memanggil def lain yang ditulis belakangan.
        let queued = self.exported_decls.clone();
        for (_, text) in queued.iter() {
            head.push(text.clone());
            head.push(String::new());
        }
        self.head_lines = head.clone();
        Ok(format!("{}\n{}", head.join("\n"), self.lines.join("\n")))
    }

    pub fn sourcemap(&self, filename: &str, src: &str) -> String {
        use crate::emitter::encode_vlq;
        let mut segs = Vec::new();
        let mut prev_src: i64 = 0;
        for _ in 0..self.head_lines.len() {
            segs.push(format!(
                "{}{}{}",
                encode_vlq(0),
                encode_vlq(0),
                encode_vlq(0)
            ));
        }
        for sl in &self.linemap {
            let sl_i = *sl as i64;
            let d = (sl_i - 1) - prev_src;
            prev_src = sl_i - 1;
            segs.push(format!(
                "{}{}{}",
                encode_vlq(0),
                encode_vlq(d),
                encode_vlq(0)
            ));
        }
        format!(
            "{{\"version\":3,\"file\":\"{}\",\"sources\":[\"{}\"],\"sourcesContent\":[{}],\"names\":[],\"mappings\":\"{}\"}}",
            filename.replace(".hx", ".js"),
            filename,
            json_escape(src),
            segs.join(";")
        )
    }
}
