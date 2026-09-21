// [xihanzu-NR]
//! Hydra compiler — Pythonic syntax for React (HSX) and Node (HX).
//!
//! One binary, no runtime dependencies.
//!   hydra <file.hsx>            compile to stdout
//!   hydra <file.hsx> -o out.tsx compile to file
//!   hydra --json <file.hsx>     emit {code, map} JSON for editor/plugin use
//!   hydra --check <file.hsx>    parse only, exit 1 on error
//!   hydra --stdin               read source from stdin (used by the Vite plugin)

use hydra::compile;
use std::io::{Read, Write};
use std::process::ExitCode;

const VERSION: &str = env!("CARGO_PKG_VERSION");

fn usage() -> String {
    format!(
        "hydra {VERSION} — Pythonic syntax for React (HSX) & Node (HX)\n\
         \n\
         USAGE:\n\
         \x20 hydra <file.hsx>            compile to stdout\n\
         \x20 hydra <file.hx> -o out.mjs  compile to output file\n\
         \x20 hydra --json <file.hsx>     emit {{code, map}} JSON\n\
         \x20 hydra --check <file.hsx>    parse only; exit 1 on error\n\
         \x20 hydra --stdin [filename]    read source from stdin\n\
         \x20 hydra --version\n\
         \x20 hydra build|check|init      project commands\n"
    )
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();

    if args.is_empty() {
        eprint!("{}", usage());
        return ExitCode::from(2);
    }
    if args[0] == "--version" || args[0] == "-v" {
        println!("hydra {}", VERSION);
        return ExitCode::SUCCESS;
    }
    if args[0] == "--help" || args[0] == "-h" {
        print!("{}", usage());
        return ExitCode::SUCCESS;
    }
    if matches!(args[0].as_str(), "build" | "check" | "init") {
        return hydra::cli::run(&args);
    }

    let json_mode = args.iter().any(|a| a == "--json");
    let check_only = args.iter().any(|a| a == "--check");
    let from_stdin = args.iter().any(|a| a == "--stdin");
    let out_file = args
        .iter()
        .position(|a| a == "-o" || a == "--out")
        .and_then(|idx| args.get(idx + 1).cloned());

    let (src, filename) = if from_stdin {
        let mut buf = String::new();
        if let Err(e) = std::io::stdin().read_to_string(&mut buf) {
            eprintln!("serpent: cannot read stdin: {}", e);
            return ExitCode::from(1);
        }
        let name = args
            .iter()
            .skip_while(|a| *a != "--stdin")
            .nth(1)
            .cloned()
            .unwrap_or_else(|| "stdin.hsx".to_string());
        (buf, name)
    } else {
        let mut positional = Vec::new();
        let mut skip_next = false;
        for a in &args {
            if skip_next {
                skip_next = false;
                continue;
            }
            if a == "-o" || a == "--out" {
                skip_next = true;
                continue;
            }
            if !a.starts_with('-') {
                positional.push(a.clone());
            }
        }
        let path = match positional.first() {
            Some(p) => p.clone(),
            None => {
                eprint!("{}", usage());
                return ExitCode::from(2);
            }
        };
        match std::fs::read_to_string(&path) {
            Ok(s) => (s, path),
            Err(e) => {
                eprintln!("serpent: cannot read {}: {}", path, e);
                return ExitCode::from(1);
            }
        }
    };

    match compile(&src, &filename) {
        Ok((code, map)) => {
            if check_only {
                println!("ok: {}", filename);
                return ExitCode::SUCCESS;
            }
            if json_mode {
                // Hand-rolled so the binary needs no JSON crate.
                let payload = format!("{{\"code\":{},\"map\":{}}}", json_string(&code), map);
                if let Some(out_path) = out_file {
                    if let Err(e) = std::fs::write(&out_path, payload) {
                        eprintln!("serpent: cannot write {}: {}", out_path, e);
                        return ExitCode::from(1);
                    }
                } else {
                    let mut out = std::io::stdout();
                    let _ = out.write_all(payload.as_bytes());
                }
                return ExitCode::SUCCESS;
            }
            // Default: append an inline source map so a browser stack trace
            // points back at the .hsx source.
            let b64 = base64(map.as_bytes());
            let full_out = format!("{}\n//# sourceMappingURL=data:application/json;base64,{}\n", code, b64);
            if let Some(out_path) = out_file {
                if let Err(e) = std::fs::write(&out_path, full_out) {
                    eprintln!("serpent: cannot write {}: {}", out_path, e);
                    return ExitCode::from(1);
                }
            } else {
                print!("{}", full_out);
            }
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("{}", e.pretty());
            ExitCode::from(1)
        }
    }
}

fn json_string(s: &str) -> String {
    let mut o = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            '\t' => o.push_str("\\t"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            other => o.push(other),
        }
    }
    o.push('"');
    o
}

const B64_STD: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(B64_STD[(n >> 18) as usize & 63] as char);
        out.push(B64_STD[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            B64_STD[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            B64_STD[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}
