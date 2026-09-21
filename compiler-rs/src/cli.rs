// [xihanzu-NR]
//! Developer CLI: build, check, init.
//!
//! Subcommands on the same binary as the compiler, so the whole toolchain ships
//! as one 464KB executable with no Python anywhere in the loop.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Instant;

use crate::compile;

pub fn run(args: &[String]) -> ExitCode {
    match args.first().map(|s| s.as_str()) {
        Some("run") => run_script(&args[1..]),
        Some("build") => build(&args[1..]),
        Some("check") => check(&args[1..]),
        Some("init") => init(&args[1..]),
        Some(other) => {
            eprintln!("hydra: unknown command {:?}", other);
            eprintln!("try: hydra run | build | check | init | --help");
            ExitCode::from(2)
        }
        None => {
            eprintln!("hydra: missing command");
            ExitCode::from(2)
        }
    }
}

pub fn run_script(args: &[String]) -> ExitCode {
    let file_arg = match args.iter().find(|a| !a.starts_with('-')) {
        Some(f) => PathBuf::from(f),
        None => {
            eprintln!("hydra: run requires a script file (e.g. hydra run script.hs)");
            return ExitCode::from(2);
        }
    };
    let Ok(src) = fs::read_to_string(&file_arg) else {
        eprintln!("hydra: cannot read {}", file_arg.display());
        return ExitCode::from(1);
    };

    let filename = file_arg
        .file_name()
        .map_or_else(|| "script.hs".into(), |n| n.to_string_lossy().to_string());
    let (code, _map) = match compile(&src, &filename) {
        Ok(res) => res,
        Err(e) => {
            eprintln!("{}", e.pretty());
            return ExitCode::from(1);
        }
    };

    let file_str = file_arg.to_string_lossy();
    let file_idx = args.iter().position(|a| a == &file_str).unwrap_or(0);
    let script_args = &args[file_idx + 1..];

    let parent_dir = file_arg.parent().unwrap_or_else(|| Path::new("."));

    let mut child = match std::process::Command::new("node")
        .current_dir(parent_dir)
        .arg("--input-type=module")
        .arg("-")
        .args(script_args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::inherit())
        .stderr(std::process::Stdio::inherit())
        .spawn()
    {
        Ok(c) => c,
        Err(_) => match std::process::Command::new("bun")
            .current_dir(parent_dir)
            .arg("-")
            .args(script_args)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::inherit())
            .stderr(std::process::Stdio::inherit())
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                eprintln!("hydra: neither node nor bun runtime found: {}", e);
                return ExitCode::from(1);
            }
        },
    };

    if let Some(mut stdin) = child.stdin.take() {
        use std::io::Write;
        let _ = stdin.write_all(code.as_bytes());
    }

    match child.wait() {
        Ok(status) => {
            if let Some(c) = status.code() {
                ExitCode::from(c as u8)
            } else {
                ExitCode::SUCCESS
            }
        }
        Err(e) => {
            eprintln!("hydra: execution error: {}", e);
            ExitCode::from(1)
        }
    }
}

/// Recursively collect every file under `dir` whose extension is `ext`.
fn collect(dir: &Path, ext: &str, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            if p.file_name().map_or(false, |n| n == "node_modules" || n == "dist" || n == ".git") {
                continue;
            }
            collect(&p, ext, out);
        } else if p.extension().map_or(false, |x| x == ext) {
            out.push(p);
        }
    }
}

fn targets(args: &[String]) -> Vec<PathBuf> {
    let files: Vec<PathBuf> = args.iter().filter(|a| !a.starts_with('-')).map(PathBuf::from).collect();
    if !files.is_empty() {
        return files;
    }
    let mut found = Vec::new();
    for ext in &["hsx", "hs", "hx"] {
        collect(Path::new("src"), ext, &mut found);
    }
    if found.is_empty() {
        for ext in &["hsx", "hs", "hx"] {
            collect(Path::new("."), ext, &mut found);
        }
    }
    found.sort();
    found
}

fn build(args: &[String]) -> ExitCode {
    let verbose = args.iter().any(|a| a == "-v" || a == "--verbose");
    let files = targets(args);
    if files.is_empty() {
        eprintln!("hydra: no .hsx, .hs, or .hx files found");
        return ExitCode::from(1);
    }

    let t0 = Instant::now();
    let mut errors = 0usize;

    for path in &files {
        let Ok(src) = fs::read_to_string(path) else {
            eprintln!("hydra: cannot read {}", path.display());
            errors += 1;
            continue;
        };
        let name = path.file_name().map_or_else(|| "out.hsx".into(), |n| n.to_string_lossy().to_string());
        match compile(&src, &name) {
            Ok((code, map)) => {
                let is_js = path.extension().map_or(false, |x| x == "hs" || x == "hx");
                let out_ext = if is_js { "mjs" } else { "tsx" };
                let out_file = path.with_extension(out_ext);
                let map_path = path.with_extension(format!("{}.map", out_ext));
                let map_name = map_path.file_name().map_or_else(|| "out.map".into(), |n| n.to_string_lossy().to_string());
                let with_ref = format!("{}\n//# sourceMappingURL={}\n", code, map_name);
                if let Err(e) = fs::write(&out_file, with_ref) {
                    eprintln!("hydra: cannot write {}: {}", out_file.display(), e);
                    errors += 1;
                    continue;
                }
                let _ = fs::write(&map_path, map);
                if verbose {
                    println!("  \x1b[32mcompiled\x1b[0m {} -> {}", path.display(), out_file.display());
                }
            }
            Err(e) => {
                eprintln!("{}", e.pretty());
                errors += 1;
            }
        }
    }

    let ms = t0.elapsed().as_secs_f64() * 1000.0;
    if errors > 0 {
        eprintln!("\n\x1b[1;31mbuild failed\x1b[0m: {} error(s) in {:.1}ms", errors, ms);
        return ExitCode::from(1);
    }
    println!("\x1b[32mOK\x1b[0m: compiled {} file(s) in {:.1}ms", files.len(), ms);
    ExitCode::SUCCESS
}

fn check(args: &[String]) -> ExitCode {
    let files = targets(args);
    let mut errors = 0usize;
    for path in &files {
        let Ok(src) = fs::read_to_string(path) else { continue };
        let name = path.file_name().map_or_else(|| "out.hsx".into(), |n| n.to_string_lossy().to_string());
        if let Err(e) = compile(&src, &name) {
            eprintln!("{}", e.pretty());
            errors += 1;
        }
    }
    if errors > 0 {
        eprintln!("\n{} error(s) found", errors);
        return ExitCode::from(1);
    }
    println!("\x1b[32mclean\x1b[0m: {} file(s) checked", files.len());
    ExitCode::SUCCESS
}

fn init(args: &[String]) -> ExitCode {
    let Some(name) = args.first() else {
        eprintln!("serpent: init needs a project name");
        return ExitCode::from(2);
    };
    let root = Path::new(name);
    if root.exists() {
        eprintln!("serpent: {} already exists", name);
        return ExitCode::from(1);
    }

    println!("Scaffolding {}...", name);
    let src = root.join("src");
    if fs::create_dir_all(&src).is_err() {
        eprintln!("serpent: cannot create {}", src.display());
        return ExitCode::from(1);
    }

    let files: Vec<(PathBuf, String)> = vec![
        (
            root.join("package.json"),
            format!(
                r#"{{
  "name": "{name}",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {{
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  }},
  "dependencies": {{
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "serpent": "file:../runtime"
  }},
  "devDependencies": {{
    "@types/react": "^18.3.1",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.4",
    "vite": "^6.0.3",
    "vite-plugin-serpent": "file:../vite-plugin"
  }}
}}
"#
            ),
        ),
        (
            src.join("App.hsx"),
            r#"# [xihanzu-NR]
from serpent import state

component App():
    count, set_count = state(0)

    div(className="min-h-screen bg-gray-50 flex items-center justify-center"):
        div(className="bg-white p-8 rounded-2xl shadow-xl max-w-sm w-full text-center space-y-4"):
            h1(className="text-3xl font-extrabold text-gray-900"): "Serpent"
            p(className="text-sm text-gray-500"): "Pythonic syntax, React speed"
            div(className="text-6xl font-black text-indigo-600 py-4"): count
            div(className="flex justify-center gap-3"):
                button(
                    on_click=lambda: set_count(count - 1),
                    className="px-4 py-2 bg-gray-100 hover:bg-gray-200 rounded-lg font-medium"
                ): "-1"
                button(
                    on_click=lambda: set_count(0),
                    className="px-4 py-2 bg-gray-100 hover:bg-gray-200 rounded-lg font-medium"
                ): "Reset"
                button(
                    on_click=lambda: set_count(count + 1),
                    className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-medium"
                ): "+1"
"#
            .to_string(),
        ),
        (
            root.join("index.html"),
            format!(
                r#"<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>{name}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
"#
            ),
        ),
        (
            src.join("main.tsx"),
            r#"// [xihanzu-NR]
import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App.hsx'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
"#
            .to_string(),
        ),
        (
            root.join("vite.config.ts"),
            r#"// [xihanzu-NR]
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import serpent from 'vite-plugin-serpent'

export default defineConfig({
  plugins: [serpent(), react()],
})
"#
            .to_string(),
        ),
        (
            root.join("tsconfig.json"),
            r#"{
  "compilerOptions": {
    "target": "ES2020",
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["vite/client"]
  },
  "include": ["src"]
}
"#
            .to_string(),
        ),
    ];

    for (path, content) in files {
        if let Err(e) = fs::write(&path, content) {
            eprintln!("serpent: cannot write {}: {}", path.display(), e);
            return ExitCode::from(1);
        }
    }

    println!("Created {}! Run:\n  cd {} && bun install && bun run dev", name, name);
    ExitCode::SUCCESS
}
