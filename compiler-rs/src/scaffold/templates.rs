//! The scaffold's templates, and the rendering that fills them in.

use std::io::Write;
use std::path::Path;

use super::util::*;

pub(crate) const PACKAGE_JSON_TEMPLATE: &str = r#"{
  "name": "__NAME__",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "hydra dev",
    "build": "hydra build",
    "preview": "hydra preview",
    "check": "hydra check",
    "clean": "hydra clean"
  },
  "dependencies": {
    "react": "^19.1.0",
    "react-dom": "^19.1.0"
  },
  "devDependencies": {
    "@types/react": "^19.1.0",
    "@types/react-dom": "^19.1.0",
    "autoprefixer": "^10.4.20",
    "esbuild": "^0.25.0",
    "postcss": "^8.4.49",
    "tailwindcss": "^3.4.16"
  }
}
"#;

/// The framework owns the Tailwind config for every project it builds: the
/// runner merges `content` from the project layout and reads theme and plugins
/// from `hydraconfig.json`'s `tailwind` key, so this file is for editors and
/// for anyone running the Tailwind CLI by hand.
pub(super) const TAILWIND_CONFIG_TEMPLATE: &str = r#"// [xihanzu-NR]
/**
 * Tailwind is configured from hydraconfig.json's "tailwind" key at build time.
 * This file mirrors that config so editor tooling and a bare `npx tailwindcss`
 * produce the same classes; keep the two in step when you change the theme.
 */
export default {
  content: ['./index.html', './src/**/*.{hyx,hys,hsx,hs,tsx,ts,jsx,js,mjs,html}'],
  theme: { extend: {} },
  plugins: [],
};
"#;

pub(super) const INDEX_HTML_TEMPLATE: &str = r#"<!-- [xihanzu-NR] -->
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="description" content="__NAME__ — a HydraScript app" />
    <title>__NAME__</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.hyx"></script>
  </body>
</html>
"#;

pub(super) const MAIN_HYX_TEMPLATE: &str = r#"# [xihanzu-NR]
from hydra import mount
from "./App.hyx" import App
import "./index.css"

root_element = document.getElementById("root")
mount(App, root_element)
"#;

pub(super) const APP_HYX_TEMPLATE: &str = r#"# [xihanzu-NR]
from hydra import state, Link, Router
from "./components/Header.hyx" import Header
from "./components/Card.hyx" import Card
from "./components/Button.hyx" import Button
from "./lib/stats.hys" import greeting

component App():
    clicks, set_clicks = state(0)
    samples, set_samples = state([2, 4, 6])

    div(className="min-h-screen bg-slate-50 text-slate-900"):
        # The nav is plain <a> links: the router owns the URL, so a link is a
        # link. `Link` intercepts the click for a client-side transition and
        # still renders an href that works without JavaScript.
        header(className="border-b border-slate-200 bg-white"):
            div(className="mx-auto flex max-w-3xl items-center justify-between gap-4 p-4"):
                span(className="text-lg font-black tracking-tight text-indigo-600"): "HydraScript"
                nav(className="flex items-center gap-1"):
                    Link(to="/", className="rounded-lg px-3 py-1.5 text-sm font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-900"):
                        "Home"
                    Link(to="/about", className="rounded-lg px-3 py-1.5 text-sm font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-900"):
                        "About"

        main(className="mx-auto max-w-3xl space-y-6 p-6"):
            # `Router()` renders src/pages for the current URL, so the folder is
            # the route table and this file does not grow an if/elif per page.
            Router()

            Card(title="State + interop", subtitle="App owns the state; stats.hys does the maths"):
                div(className="flex items-center gap-3"):
                    Button(label="Add a sample", on_press=lambda: set_samples(samples + [clicks + 2]))
                    Button(label="Reset", variant="ghost", on_press=lambda: set_samples([2, 4, 6]))
                    span(className="text-sm text-slate-500"): f"clicks: {clicks}"

        footer(className="p-6 text-center text-xs text-slate-400"): greeting("HydraScript")
"#;

/// The home page. It is a PAGE, not a component: `Router()` renders it and
/// passes `params`, and its URL comes from its filename.
pub(super) const HOME_HYX_TEMPLATE: &str = r#"# [xihanzu-NR]
from "../components/Card.hyx" import Card
from "../lib/stats.hys" import summarise

component Home(greeting: str = "Hello", samples = []):
    stats = summarise(samples)

    div(className="space-y-6"):
        Card(title=greeting, subtitle="src/pages/index.hyx — this file IS the `/` route"):
            div(className="grid grid-cols-3 gap-3 text-center"):
                div(className="rounded-xl bg-slate-50 p-3"):
                    p(className="text-xs uppercase tracking-wide text-slate-400"): "count"
                    p(className="text-xl font-bold text-slate-900"): stats["count"]
                div(className="rounded-xl bg-slate-50 p-3"):
                    p(className="text-xs uppercase tracking-wide text-slate-400"): "total"
                    p(className="text-xl font-bold text-slate-900"): stats["total"]
                div(className="rounded-xl bg-slate-50 p-3"):
                    p(className="text-xs uppercase tracking-wide text-slate-400"): "mean"
                    p(className="text-xl font-bold text-slate-900"): stats["mean"]
        Card(title="Samples", subtitle="One <li> per entry, from a for loop"):
            ul(className="space-y-1 text-sm text-slate-600"):
                # `key=` on the element returned by a `for` loop. Without it React
                # warns on the very first build, and a scaffold should not open
                # with a warning.
                for value in samples:
                    li(key=value): f"sample {value} squared is {value * value}"
"#;

/// The about page, reached at `/about` because that is its filename. The
/// parameter name is `version`, so the URL does not have to agree with it.
pub(super) const ABOUT_HYX_TEMPLATE: &str = r#"# [xihanzu-NR]
from "../components/Card.hyx" import Card

component About(version: str = "0.1.0", built_on: str = "?"):
    features = ["Pythonic syntax", "Two targets: .hyx and .hys", "SSG on by default"]

    div(className="space-y-6"):
        Card(title="About", subtitle=f"version {version}"):
            p(className="text-sm text-slate-600"):
                "src/pages/about.hyx, so the router serves it at /about."
            p(className="text-sm text-slate-600"):
                f"`version` and `built_on` came from about.server.hys, at build time ({built_on})."
            ul(className="list-disc space-y-1 pl-5 text-sm text-slate-600"):
                for index, feature in enumerate(features):
                    li(key=index): feature
"#;

/// A page's server half: the loader, and the shape of an action.
///
/// Two things this teaches by existing: a loader runs at build time and its
/// result reaches the page as props, and `hydra/server` is only importable from
/// a `.server.hys`.
pub(super) const ABOUT_SERVER_HYS_TEMPLATE: &str = r#"# [xihanzu-NR]
# The server half of src/pages/about.hyx.
#
# Separate FILE, not an `export def loader` inside the page, and that is the
# design: a page module is a CLIENT module (it renders in the browser, its
# imports end up in the client bundle), so a loader declared there could only be
# server-only by convention. This file is not reachable from the client at all.
#
# Called with ONE argument, an event object:
#     event.params   dict of URL parameters
#     event.url      the path
#     event.query    the query string, with .get()
#     event.request  method / headers / body (an action)

from "hydra/server" import env

export async def loader(event):
    return {
        "version": "0.1.0",
        "built_on": env("HYDRA_BUILD_HOST", "this machine"),
    }
"#;

/// A `_404.hyx` so a wrong URL says so, instead of rendering nothing.
pub(super) const NOTFOUND_HYX_TEMPLATE: &str = r#"# [xihanzu-NR]
from "../components/Card.hyx" import Card

component NotFound(path: str = "/"):
    div(className="space-y-6"):
        Card(title="404", subtitle="No route matched"):
            p(className="text-sm text-slate-600"):
                f"{path} is not a page. Add src/pages for it, or go back."
"#;

/// CSS needs the `/* */` watermark form. The `#` form used for the Pythonic
/// sources is not a CSS comment, and PostCSS rejects the file outright with
/// "Unknown word #" — which is how this was caught.
pub(super) const INDEX_CSS_TEMPLATE: &str = r#"/* [xihanzu-NR] */
@tailwind base;
@tailwind components;
@tailwind utilities;
"#;

/// The nav row is its own component on purpose: an `if / else` that is the
/// *only* statement inside a `for` body emits an object literal where JS needs
/// an expression, so the branch moves into a component that returns early.
pub(super) const HEADER_HYX_TEMPLATE: &str = r#"# [xihanzu-NR]
component NavLink(link = {}, current: str = "/", on_nav = None):
    if link["path"] == current:
        span(className="rounded-lg bg-indigo-50 px-3 py-1.5 text-sm font-semibold text-indigo-700"): link["label"]
    else:
        button(
            on_click=lambda: on_nav(link["path"]),
            className="rounded-lg px-3 py-1.5 text-sm font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-900",
        ): link["label"]

component Header(title: str = "HydraScript", links = [], current: str = "/", on_nav = None):
    header(className="border-b border-slate-200 bg-white"):
        div(className="mx-auto flex max-w-3xl items-center justify-between gap-4 p-4"):
            span(className="text-lg font-black tracking-tight text-indigo-600"): title
            nav(className="flex items-center gap-1"):
                for link in links:
                    NavLink(key=link["path"], link=link, current=current, on_nav=on_nav)
"#;

pub(super) const CARD_HYX_TEMPLATE: &str = r#"# [xihanzu-NR]
component Card(title: str = "Card", subtitle: str = ""):
    section(className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-100"):
        h2(className="text-xl font-bold text-slate-900"): title
        if subtitle:
            p(className="mt-1 text-sm text-slate-500"): subtitle
        div(className="mt-4"):
            slot
"#;

/// The variant lookup is an if/elif chain on purpose: a Python-style
/// `styles.get(variant, fallback)` compiles to a literal `.get(...)` call, and
/// a JS object literal has no such method.
pub(super) const BUTTON_HYX_TEMPLATE: &str = r#"# [xihanzu-NR]
component Button(label: str = "Button", variant: str = "primary", on_press = None):
    styles = "bg-indigo-600 text-white hover:bg-indigo-700"
    if variant == "ghost":
        styles = "bg-white text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50"
    elif variant == "danger":
        styles = "bg-rose-600 text-white hover:bg-rose-700"

    button(
        on_click=on_press,
        className=f"rounded-lg px-4 py-2 text-sm font-semibold transition {styles}",
    ): label
"#;



/// Plain ESM with no React: App.hyx imports summarise() and greeting() from
/// here, which is what proves the two targets interoperate.
///
/// Every name another module needs carries `export`. A bare `def` emits a
/// plain `function`, and esbuild then reports the import as "always undefined".
pub(super) const STATS_HYS_TEMPLATE: &str = r#"# [xihanzu-NR]
export def total(values):
    acc = 0
    for value in values:
        acc = acc + value
    return acc

export def mean(values):
    n = len(values)
    if n == 0:
        return 0
    return total(values) / n

export def summarise(values):
    return {"count": len(values), "total": total(values), "mean": mean(values)}

export def greeting(name):
    return f"Hello, {name}!"
"#;

pub(super) const README_TEMPLATE: &str = r#"# __NAME__

A HydraScript app — Pythonic syntax that compiles to React. Built with
`hydra`; the generated output is plain React TSX and plain ESM.

## Getting started

```bash
npm install
npx hydra dev
```

The dev server prints a local URL (default <http://localhost:5173>).

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Dev server: builds once, serves `dist/`, rebuilds on change |
| `npm run build` | Production build into `dist/`, pre-rendered to HTML |
| `npm run preview` | Serve the production build |
| `npm run check` | Type-check-free parse check of every `.hyx` / `.hys` |
| `npm run clean` | Delete `dist/` (`-- --all` also clears `node_modules`) |
| `npx hydra add <pkg> --dev` | Install a dependency and record it in `package.json` |
| `npx hydra list` | Show declared vs installed dependencies |
| `npx hydra analyze` | Bundle size report from the last build |
| `npx hydra fmt` | Format sources |
| `npx hydra doctor` | Check the local toolchain |

## Layout

```
hydraconfig.json        project config: name, root, outputDir, server, rendering
index.html              SPA mount point (#root); the build inlines the pre-render
tailwind.config.js      mirrors the "tailwind" key in hydraconfig.json
src/main.hyx            entry — mounts App into #root
src/App.hyx             owns the state, picks the page, wires the components
src/components/         Header.hyx, Card.hyx, Button.hyx
src/lib/stats.hys       pure helpers, imported by App.hyx and the pages
src/pages/index.hyx     the `/` route
src/pages/about.hyx     the `/about` route
src/pages/_404.hyx      shown when no route matches
src/index.css           the three Tailwind directives
dist/                   build output (git-ignored), pre-rendered to HTML
```

Two file types, one language:

- **`.hyx`** — React components. `component Name(props):` returns a tree.
- **`.hys`** — plain ESM modules. `def name(args):` returns a value.

`src/App.hyx` importing from `src/lib/stats.hys` is the point: a component and
a plain module calling each other with no glue in between.

## Writing code

```python
# src/components/Button.hyx
component Button(label: str = "Button", on_press = None):
    button(on_click=on_press, className="rounded-lg px-4 py-2"): label
```

```python
# src/lib/stats.hys
def summarise(values):
    return {"count": len(values), "total": sum(values)}
```

Control flow reads like Python — `if / elif / else`, `for x in xs`, `lambda`,
f-strings — and conditional children become lazy JSX, so `if subtitle:` only
renders when there is a subtitle.

Notes worth knowing before you hit them:

- Variant lookups use `if / elif`, not `styles.get(...)`. A Python dict literal
  compiles to a JS object literal, which has no `.get` method.
- A component call cannot be the only statement in a component body — it would
  be emitted as a discarded expression. Wrap it in an element (`div:`), or give
  it siblings.
- An `if / else` cannot be the only statement inside a `for` body. Move the
  branch into a small component that returns early; `Header.hyx` does this with
  `NavLink`.
- A bare string as the first line of a component body is emitted as an
  expression statement, so keep prose in comments (`# ...`), not in docstrings.
- Anything in a `.hys` file that another module imports needs `export def`, not
  a bare `def`.

## Configuring

`hydraconfig.json` is read by the runner:

| Key | Meaning |
|---|---|
| `outputDir` | Where the build lands (default `dist`) |
| `server.port` / `server.host` | What `dev` and `preview` bind to |
| `base` | Public base path |
| `rendering.ssg` | Pre-render `App.hyx` into `dist/index.html` (default `true`) |
| `tailwind` | Merged into the Tailwind config: `theme`, `plugins`, extra `content` |

## Checking your work

```bash
npx hydra check          # parse every source, no output written
npx hydra check src/App.hyx
npx hydra build && npx hydra analyze
```
"#;

/// Render a template, substituting `__NAME__` with the (JSON-escaped) name.
pub(super) fn render(template: &str, name: &str) -> String {
    template.replace("__NAME__", &json_escape(name))
}

/// Escape a value for HTML text or an attribute.
pub(super) fn html_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            other => out.push(other),
        }
    }
    out
}

/// Render a template whose substitution lands in MARKUP.
///
/// `json_escape` leaves `<` alone — it is correct inside JSON and wrong inside
/// HTML — so a directory named `<script>alert(1)</script>` produced a scaffolded
/// `index.html` that ran script the moment the new project was opened. Stored
/// XSS in the file every app starts from, from a name the archive gets to choose.
pub(super) fn render_html(template: &str, name: &str) -> String {
    template.replace("__NAME__", &html_escape(name))
}

// ---------------------------------------------------------------------------
// `hydra init` — the choices it can make on the user's behalf
// ---------------------------------------------------------------------------

/// Which starter the project gets.
///
/// The scaffold used to have exactly one shape: a project with `src/pages`,
/// Tailwind, and SSG. That is a fine default and a bad only option — a user who
/// wanted a single-page app with plain CSS had to delete four generated folders
/// and hunt for the right keys in `hydraconfig.json` to stop Tailwind running.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Template {
    /// `src/pages/**` file-based router, several example pages.
    App,
    /// One entry, one root component. No router, no pages folder.
    Blank,
}

impl Template {
    pub(super) fn slug(self) -> &'static str {
        match self {
            Template::App => "app",
            Template::Blank => "blank",
        }
    }

    pub(super) fn label(self) -> &'static str {
        match self {
            Template::App => "App — routing by file, several pages (recommended)",
            Template::Blank => "Blank — one page, one component, no router",
        }
    }

    pub(super) fn parse(value: &str) -> Option<Self> {
        match value {
            "app" => Some(Template::App),
            "blank" => Some(Template::Blank),
            _ => None,
        }
    }
}

/// How stylesheets are processed.
///
/// This mirrors what the runner actually supports (see `styling` in
/// `schema.json`): Tailwind, a PostCSS plugin list, or nothing but plain CSS.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Styling {
    Tailwind,
    Postcss,
    Plain,
}

impl Styling {
    pub(super) fn slug(self) -> &'static str {
        match self {
            Styling::Tailwind => "tailwind",
            Styling::Postcss => "postcss",
            Styling::Plain => "plain",
        }
    }

    pub(super) fn label(self) -> &'static str {
        match self {
            Styling::Tailwind => "Tailwind — utility classes, configured in hydraconfig.json",
            Styling::Postcss => "PostCSS — your own plugin list, no Tailwind",
            Styling::Plain => "Plain CSS — no transform step at all",
        }
    }

    pub(super) fn parse(value: &str) -> Option<Self> {
        match value {
            "tailwind" => Some(Styling::Tailwind),
            "postcss" => Some(Styling::Postcss),
            "plain" => Some(Styling::Plain),
            _ => None,
        }
    }
}

/// What the project gets instead of `src/pages`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Layout {
    /// File-based router under `src/pages`.
    Pages,
    /// Single page mounted from `src/main.hyx`.
    Single,
}

impl Layout {
    pub(super) fn slug(self) -> &'static str {
        match self {
            Layout::Pages => "pages",
            Layout::Single => "single",
        }
    }

    pub(super) fn label(self) -> &'static str {
        match self {
            Layout::Pages => "Pages — one file per URL under src/pages (recommended)",
            Layout::Single => "Single — one page, no file-based router",
        }
    }

    pub(super) fn parse(value: &str) -> Option<Self> {
        match value {
            "pages" => Some(Layout::Pages),
            "single" => Some(Layout::Single),
            _ => None,
        }
    }
}

/// Everything `init` needs. Built from flags, from the prompts, or both.
#[derive(Clone, Debug)]
pub(crate) struct InitOptions {
    pub template: Template,
    pub styling: Styling,
    pub layout: Layout,
    pub ssg: bool,
    /// TypeScript `.d.ts` generation for `.hyx` modules.
    pub types: bool,
    /// Server-side rendering instead of a client shell.
    pub ssr: bool,
}

impl Default for InitOptions {
    fn default() -> Self {
        InitOptions {
            template: Template::App,
            styling: Styling::Tailwind,
            layout: Layout::Pages,
            ssg: true,
            types: true,
            ssr: false,
        }
    }
}

impl InitOptions {
    /// Apply a `--template=` style flag. Returns Err with the accepted values so
    /// the caller can print a message that lists what would have worked.
    pub(super) fn apply_flag(&mut self, key: &str, value: &str) -> Result<(), String> {
        match key {
            "template" => {
                self.template =
                    Template::parse(value).ok_or_else(|| "app, blank".to_string())?;
                // A blank template has no pages folder by construction; don't
                // let a flag pair produce a project that contradicts itself.
                if self.template == Template::Blank {
                    self.layout = Layout::Single;
                }
            }
            "styling" | "css" => {
                self.styling = Styling::parse(value)
                    .ok_or_else(|| "tailwind, postcss, plain".to_string())?
            }
            "layout" => {
                self.layout = Layout::parse(value)
                    .ok_or_else(|| "pages, single".to_string())?
            }
            "ssg" => self.ssg = parse_bool(value).ok_or_else(|| "true, false".to_string())?,
            "types" => self.types = parse_bool(value).ok_or_else(|| "true, false".to_string())?,
            "ssr" => {
                self.ssr = parse_bool(value).ok_or_else(|| "true, false".to_string())?;
                // SSR and a static export are not mutually exclusive here — the
                // runner can pre-render AND serve. Keep ssg as given.
            }
            _ => return Err(String::new()),
        }
        Ok(())
    }
}

pub(super) fn parse_bool(value: &str) -> Option<bool> {
    match value {
        "true" | "yes" | "y" | "1" => Some(true),
        "false" | "no" | "n" | "0" => Some(false),
        _ => None,
    }
}

/// Read one line from stdin, trimmed. `None` on EOF so a piped-in script that
/// runs out of answers cannot spin forever.
pub(super) fn read_line() -> Option<String> {
    use std::io::Write;
    let _ = std::io::stdout().flush();
    let mut buf = String::new();
    match std::io::stdin().read_line(&mut buf) {
        Ok(0) => None,
        Ok(_) => Some(buf.trim().to_string()),
        Err(_) => None,
    }
}

/// Ask a numbered question. `default` is what Enter selects.
///
/// Deliberately not a TUI: no arrow keys, no raw mode, no termios. A prompt that
/// works over SSH, in CI, and in a pipe is worth more here than one that looks
/// modern. Enter accepts the default, so the fast path is four keystrokes.
pub(super) fn ask(question: &str, options: &[(&str, &str)], default: usize) -> Option<usize> {
    println!();
    println!("{}", question);
    for (i, (_, label)) in options.iter().enumerate() {
        let marker = if i == default { "❯" } else { " " };
        println!("  {} {}. {}", marker, i + 1, label);
    }
    print!("  choice [{}]: ", default + 1);

    let answer = read_line()?;
    if answer.is_empty() {
        return Some(default);
    }
    match answer.parse::<usize>() {
        Ok(n) if n >= 1 && n <= options.len() => Some(n - 1),
        _ => {
            eprintln!("  '{}' is not one of 1-{}; using {}", answer, options.len(), default + 1);
            Some(default)
        }
    }
}

pub(super) fn ask_yes_no(question: &str, default: bool) -> Option<bool> {
    let hint = if default { "Y/n" } else { "y/N" };
    print!("{} [{}]: ", question, hint);
    let answer = read_line()?;
    if answer.is_empty() {
        return Some(default);
    }
    parse_bool(&answer.to_lowercase()).or(Some(default))
}

/// Ask the questions that were not answered by a flag.
///
/// `interactive` is false when stdin is not a TTY or `--yes` was passed: in that
/// case the defaults stand and nothing is printed, so `hydra init` in a script
/// behaves exactly as it did before the prompts existed.
pub(super) fn collect_options(
    mut opts: InitOptions,
    interactive: bool,
) -> Option<InitOptions> {
    if !interactive {
        return Some(opts);
    }

    println!();
    println!("  hydra init — a few questions, Enter accepts the default.");
    println!("  (pass --yes to skip these and take the defaults)");

    let template_choices = [
        (Template::App.slug(), Template::App.label()),
        (Template::Blank.slug(), Template::Blank.label()),
    ];
    let t_default = if opts.template == Template::App { 0 } else { 1 };
    let t = ask("Template", &template_choices, t_default)?;
    opts.template = if t == 0 { Template::App } else { Template::Blank };
    if opts.template == Template::Blank {
        opts.layout = Layout::Single;
    }

    let style_choices = [
        (Styling::Tailwind.slug(), Styling::Tailwind.label()),
        (Styling::Postcss.slug(), Styling::Postcss.label()),
        (Styling::Plain.slug(), Styling::Plain.label()),
    ];
    let s_default = match opts.styling {
        Styling::Tailwind => 0,
        Styling::Postcss => 1,
        Styling::Plain => 2,
    };
    let s = ask("Styling", &style_choices, s_default)?;
    opts.styling = match s {
        0 => Styling::Tailwind,
        1 => Styling::Postcss,
        _ => Styling::Plain,
    };

    // A blank template has no pages folder, so asking would be noise.
    if opts.template == Template::App {
        let layout_choices = [
            (Layout::Pages.slug(), Layout::Pages.label()),
            (Layout::Single.slug(), Layout::Single.label()),
        ];
        let l_default = if opts.layout == Layout::Pages { 0 } else { 1 };
        let l = ask("Layout", &layout_choices, l_default)?;
        opts.layout = if l == 0 { Layout::Pages } else { Layout::Single };
    }

    opts.ssg = ask_yes_no("Pre-render pages at build time (SSG)?", opts.ssg)?;
    opts.types = ask_yes_no("Generate TypeScript declarations (.d.ts)?", opts.types)?;

    println!();
    println!("  template : {}", opts.template.slug());
    println!("  styling  : {}", opts.styling.slug());
    println!("  layout   : {}", opts.layout.slug());
    println!("  ssg      : {}", opts.ssg);
    println!("  types    : {}", opts.types);
    println!();

    Some(opts)
}


/// `hydraconfig.json`, written to match the chosen options.
///
/// Written as text rather than by parsing and re-serialising a JSON value: the
/// output is what a person reads and edits first, so the key order and the
/// comments the user is most likely to want to change stay put.
pub(super) fn render_config(name: &str, opts: &InitOptions) -> String {
    let name = json_escape(name);

    let entries = match opts.layout {
        Layout::Pages => "",
        Layout::Single => "",
    };

    let styling = match opts.styling {
        Styling::Tailwind => ",\n  \"styling\": { \"tailwind\": true }",
        Styling::Postcss => ",\n  \"styling\": [\"autoprefixer\"]",
        Styling::Plain => "",
    };

    let rendering = match (opts.ssg, opts.ssr) {
        (true, true) => "{\n    \"ssg\": true,\n    \"ssr\": true\n  }",
        (true, false) => "{\n    \"ssg\": true\n  }",
        (false, true) => "{\n    \"ssr\": true\n  }",
        (false, false) => "{}",
    };

    let types = if opts.types {
        ",\n  \"types\": { \"emit\": true }"
    } else {
        ""
    };

    format!(
        r#"{{
  "$schema": "https://raw.githubusercontent.com/hanxthvy/hydrascript/main/schema.json",
  "name": "{name}",
  "version": "0.1.0",
  "root": "./src",
  "outputDir": "./dist",
  "base": "/",
  "entries": {{
    "app": "./src/main.hyx"
  }},
  "server": {{
    "port": 5173,
    "host": "127.0.0.1"
  }},
  "compiler": {{
    "target": "react-19",
    "strict": true
  }},
  "rendering": {rendering}{styling}{types}{entries}
}}
"#
    )
}

/// `package.json` with only the dependencies the chosen pipeline needs.
///
/// Shipping `tailwindcss`, `postcss` and `autoprefixer` to a project that asked
/// for plain CSS is dead weight the user then has to notice and remove.
pub(super) fn render_package_json(name: &str, opts: &InitOptions) -> String {
    let name = json_escape(name);

    let mut dev = vec![
        "\"@types/react\": \"^19.1.0\"".to_string(),
        "\"@types/react-dom\": \"^19.1.0\"".to_string(),
        "\"esbuild\": \"^0.25.0\"".to_string(),
    ];
    match opts.styling {
        Styling::Tailwind => {
            dev.push("\"autoprefixer\": \"^10.4.20\"".to_string());
            dev.push("\"postcss\": \"^8.4.49\"".to_string());
            dev.push("\"tailwindcss\": \"^3.4.16\"".to_string());
        }
        Styling::Postcss => {
            dev.push("\"autoprefixer\": \"^10.4.20\"".to_string());
            dev.push("\"postcss\": \"^8.4.49\"".to_string());
        }
        Styling::Plain => {}
    }
    dev.sort();

    format!(
        r#"{{
  "name": "{name}",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {{
    "dev": "hydra dev",
    "build": "hydra build",
    "preview": "hydra preview",
    "check": "hydra check",
    "clean": "hydra clean"
  }},
  "dependencies": {{
    "react": "^19.1.0",
    "react-dom": "^19.1.0"
  }},
  "devDependencies": {{
    {}
  }}
}}
"#,
        dev.join(",\n    ")
    )
}

/// `src/index.css`, matching the chosen pipeline.
pub(super) fn render_index_css(opts: &InitOptions) -> String {
    match opts.styling {
        Styling::Tailwind => r#"/* [xihanzu-NR] */
@tailwind base;
@tailwind components;
@tailwind utilities;
"#
        .to_string(),
        Styling::Postcss => r#"/* [xihanzu-NR] */
/* Processed by the plugins named in hydraconfig.json ("styling").
   No Tailwind here: write the CSS you want. */
:root {
  color-scheme: light;
  --accent: #4f46e5;
}

body {
  margin: 0;
  font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
}

.page {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  background: #f8fafc;
  color: #0f172a;
}

.title {
  margin: 0;
  font-size: 2.25rem;
  letter-spacing: -0.02em;
}

.subtitle {
  margin: 0;
  color: var(--accent);
}
"#
        .to_string(),
        Styling::Plain => r#"/* [xihanzu-NR] */
/* Copied as-is. No PostCSS, no Tailwind: this file is the final stylesheet. */
:root {
  color-scheme: light;
  --accent: #4f46e5;
}

body {
  margin: 0;
  font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
}

.page {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  background: #f8fafc;
  color: #0f172a;
}

.title {
  margin: 0;
  font-size: 2.25rem;
  letter-spacing: -0.02em;
}

.subtitle {
  margin: 0;
  color: var(--accent);
}
"#
        .to_string(),
    }
}

/// `README.md` for the generated project, describing what was chosen.
pub(super) fn render_readme(name: &str, opts: &InitOptions) -> String {
    let name = json_escape(name);
    let styling = match opts.styling {
        Styling::Tailwind => "Tailwind, enabled by the `styling.tailwind` key in `hydraconfig.json`",
        Styling::Postcss => {
            "PostCSS with the plugin list in `styling` (no Tailwind). Add plugins to that array."
        }
        Styling::Plain => "plain CSS — `src/index.css` is copied through with no transform step",
    };
    let layout = match opts.layout {
        Layout::Pages => "one file per URL under `src/pages`",
        Layout::Single => "one page, mounted from `src/main.hyx`",
    };

    format!(
        r#"# {name}

A HydraScript app. `.hyx` files compile to React; `.hys` files compile to plain
JavaScript.

## Layout

{layout}

## Styling

{styling}

## Commands

```bash
npm install
npx hydra dev       # dev server with live reload
npx hydra build     # production build into dist/
npx hydra preview   # serve the build
npx hydra check     # parse every source, write nothing
```
"#
    )
}

/// A single-page `App.hyx` whose markup matches the chosen styling pipeline.
///
/// Class names are Tailwind's in the Tailwind case; otherwise this uses semantic
/// class names that `src/index.css` actually defines. A blank project that ships
/// `className="p-6"` and no Tailwind is a project that looks broken on first run.
pub(super) fn render_single_page_app(name: &str, opts: &InitOptions) -> String {
    let name = json_escape(name);

    if opts.styling == Styling::Tailwind {
        return format!(
            r#"# [xihanzu-NR]
component App():
    div(className="min-h-screen flex flex-col items-center justify-center gap-4 bg-slate-50 text-slate-900"):
        h1(className="text-4xl font-semibold tracking-tight"): "{name}"
        p(className="text-slate-500"): "Edit src/App.hyx and save."
"#
        );
    }

    format!(
        r#"# [xihanzu-NR]
component App():
    div(className="page"):
        h1(className="title"): "{name}"
        p(className="subtitle"): "Edit src/App.hyx and save."
"#
    )
}

/// Project name derived from the target directory's final path component.
pub(super) fn project_name(root: &Path) -> String {
    root.file_name()
        .and_then(|n| n.to_str())
        .filter(|n| !n.is_empty() && *n != "." && *n != "..")
        .map(|n| n.to_string())
        .unwrap_or_else(|| "hydra-app".to_string())
}
