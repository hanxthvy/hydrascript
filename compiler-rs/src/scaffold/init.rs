//! `hydra init`: the questions, and what each answer produces.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use super::*;
use super::templates::*;
use super::util::*;

pub fn init(args: &[String]) -> ExitCode {
    if has_help(args) {
        print!("{}", INIT_USAGE);
        return ExitCode::SUCCESS;
    }

    let force = args.iter().any(|a| a == "--force");
    let assume_yes = args.iter().any(|a| a == "--yes" || a == "-y");
    let root = positional(args).map_or_else(|| PathBuf::from("."), PathBuf::from);

    if root.exists() && !root.is_dir() {
        eprintln!("hydra: {} exists and is not a directory", root.display());
        return ExitCode::from(1);
    }

    let config_path = root.join("hydraconfig.json");
    if config_path.exists() && !force {
        eprintln!("refusing to overwrite hydraconfig.json (use --force)");
        return ExitCode::from(1);
    }

    // Flags first, so `--template=blank` also changes what gets ASKED, not just
    // what gets written. An unknown `--key=value` is an error rather than being
    // ignored: silently dropping `--style=twind` would scaffold Tailwind and
    // leave the user thinking their typo took effect.
    let mut opts = InitOptions::default();
    for arg in args {
        if let Some(rest) = arg.strip_prefix("--") {
            if rest == "force" || rest == "yes" || rest == "help" || rest == "dry-run" {
                continue;
            }
            let (key, value) = match rest.split_once('=') {
                Some(kv) => kv,
                None => {
                    eprintln!("hydra: --{} needs a value, e.g. --{}=...", rest, rest);
                    return ExitCode::from(2);
                }
            };
            if let Err(accepted) = opts.apply_flag(key, value) {
                if accepted.is_empty() {
                    eprintln!(
                        "hydra: unknown option --{}\n  try: --template= --styling= --layout= --ssg= --types=",
                        key
                    );
                } else {
                    eprintln!("hydra: --{}={:?} is not valid (accepted: {})", key, value, accepted);
                }
                return ExitCode::from(2);
            }
        }
    }

    // A terminal gets the questions; a pipe, CI, or `--yes` gets the defaults.
    // `isatty` is the distinction that matters: CI runners have stdin open, so
    // checking for EOF would hang forever waiting for an answer nobody types.
    let interactive = !assume_yes && std::io::IsTerminal::is_terminal(&std::io::stdin());
    let opts = match collect_options(opts, interactive) {
        Some(o) => o,
        // EOF mid-prompt (Ctrl-D): stop cleanly instead of scaffolding half a
        // project from answers the user never finished giving.
        None => {
            eprintln!("\nhydra: no answer (end of input); nothing was written.");
            return ExitCode::from(2);
        }
    };

    let name = project_name(&root);

    let mut dirs = vec!["src", "src/components", "src/lib"];
    if opts.layout == Layout::Pages {
        dirs.push("src/pages");
    }
    for dir in dirs {
        if let Err(e) = fs::create_dir_all(root.join(dir)) {
            eprintln!("hydra: cannot create {}: {}", root.join(dir).display(), e);
            return ExitCode::from(1);
        }
    }

    // Every entry starts with the watermark for its own language: `#` for the
    // Pythonic sources, `<!-- -->` for HTML, `//` for JS.
    let mut files: Vec<(PathBuf, String)> = vec![
        (
            root.join("hydraconfig.json"),
            render_config(&name, &opts),
        ),
        (
            root.join("package.json"),
            render_package_json(&name, &opts),
        ),
        (
            root.join("index.html"),
            render_html(INDEX_HTML_TEMPLATE, &name),
        ),
        (root.join("README.md"), render_readme(&name, &opts)),
        (
            root.join("src").join("main.hyx"),
            render(MAIN_HYX_TEMPLATE, &name),
        ),
        (
            root.join("src").join("index.css"),
            render_index_css(&opts),
        ),
    ];

    if opts.styling == Styling::Tailwind {
        files.push((
            root.join("tailwind.config.js"),
            TAILWIND_CONFIG_TEMPLATE.to_string(),
        ));
    }

    if opts.layout == Layout::Pages {
        // The App template ships the full example: components, helpers, pages,
        // and a loader, because that is what shows the framework's shape.
        files.push((
            root.join("src").join("App.hyx"),
            APP_HYX_TEMPLATE.to_string(),
        ));
        files.push((
            root.join("src").join("components").join("Header.hyx"),
            HEADER_HYX_TEMPLATE.to_string(),
        ));
        files.push((
            root.join("src").join("components").join("Card.hyx"),
            CARD_HYX_TEMPLATE.to_string(),
        ));
        files.push((
            root.join("src").join("components").join("Button.hyx"),
            BUTTON_HYX_TEMPLATE.to_string(),
        ));
        files.push((
            root.join("src").join("lib").join("stats.hys"),
            STATS_HYS_TEMPLATE.to_string(),
        ));
        files.push((
            root.join("src").join("pages").join("index.hyx"),
            render(HOME_HYX_TEMPLATE, &name),
        ));
        files.push((
            root.join("src").join("pages").join("about.hyx"),
            ABOUT_HYX_TEMPLATE.to_string(),
        ));
        files.push((
            root.join("src").join("pages").join("_404.hyx"),
            NOTFOUND_HYX_TEMPLATE.to_string(),
        ));
        files.push((
            root.join("src").join("pages").join("about.server.hys"),
            ABOUT_SERVER_HYS_TEMPLATE.to_string(),
        ));
    } else {
        // Single page: one component, no router, no pages folder. The styles in
        // this file are written against the chosen pipeline, so a plain-CSS
        // project does not ship class names nothing defines.
        files.push((
            root.join("src").join("App.hyx"),
            render_single_page_app(&name, &opts),
        ));
    }

    // Refuse BEFORE writing anything.
    //
    // Running `init` in an existing or half-set-up project used to overwrite
    // package.json, README.md and src/main.hyx without asking — `--force` existed
    // but was not required. That is an unrecoverable loss from a plausible
    // mistake, so every collision is named and the run stops. The same policy the
    // config file already had.
    let mut collisions: Vec<PathBuf> = Vec::new();
    for (path, _) in &files {
        if fs::symlink_metadata(path).is_ok() {
            collisions.push(path.clone());
        }
    }
    if !collisions.is_empty() && !force {
        eprintln!(
            "hydra: {} file(s) already exist; refusing to overwrite them (use --force)",
            collisions.len()
        );
        for path in &collisions {
            eprintln!("  exists {}", path.display());
        }
        return ExitCode::from(1);
    }

    let mut written: Vec<PathBuf> = Vec::with_capacity(files.len());
    for (path, content) in files {
        // `fs::write` FOLLOWS a symlink and truncates whatever it points at, so a
        // `package.json -> ../victim.txt` link in the target directory made `init`
        // destroy an unrelated file outside the project. A symlink is never a file
        // this command may write, with or without --force.
        if let Ok(meta) = fs::symlink_metadata(&path) {
            if meta.file_type().is_symlink() {
                eprintln!(
                    "hydra: refusing to write through the symlink {} (it points outside the file this command owns)",
                    path.display()
                );
                return ExitCode::from(1);
            }
        }
        let mut options = fs::OpenOptions::new();
        options.write(true).truncate(true);
        // `create_new` under no --force closes the window between the collision
        // check above and this write: two runs racing cannot both create the file.
        if force {
            options.create(true);
        } else {
            options.create_new(true);
        }
        match options.open(&path) {
            Ok(mut file) => {
                if let Err(e) = file.write_all(content.as_bytes()) {
                    eprintln!("hydra: cannot write {}: {}", path.display(), e);
                    return ExitCode::from(1);
                }
            }
            Err(e) => {
                eprintln!("hydra: cannot write {}: {}", path.display(), e);
                return ExitCode::from(1);
            }
        }
        written.push(path);
    }

    println!("Scaffolded HydraScript project {:?}", name);
    for path in &written {
        println!("  created {}", path.display());
    }
    println!(
        "Next: cd {} && npm install && npx hydra dev",
        root.display()
    );

    ExitCode::SUCCESS
}

// ---------------------------------------------------------------------------
// `hydra doctor`
// ---------------------------------------------------------------------------

/// Walk up from `start` looking for `filename`. Returns the absolute-ish path.
pub(super) fn find_up(start: &Path, filename: &str) -> Option<PathBuf> {
    let mut current = start.to_path_buf();
    loop {
        let candidate = current.join(filename);
        if candidate.is_file() {
            return Some(candidate);
        }
        if !current.pop() {
            return None;
        }
    }
}
