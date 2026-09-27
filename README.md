<!-- [xihanzu-NR] -->
# HydraScript

**The Pythonic Language and Meta-Framework for React and Modern Web Applications**  
A native Rust compiler, zero-IPC Node-API runtime, and zero-config meta-framework with zero runtime overhead.

[English](README.md) | [Bahasa Indonesia](README.id.md)

---

## Table of Contents

- [Overview](#overview)
- [Design Philosophy](#design-philosophy)
- [Why HydraScript: Pain Points in Vanilla TSX](#why-hydrascript-pain-points-in-vanilla-tsx)
- [Syntax & Feature Matrix](#syntax--feature-matrix)
- [Comprehensive Code Showcases](#comprehensive-code-showcases)
  - [1. Reactive Component with State and Events](#1-reactive-component-with-state-and-events)
  - [2. Multi-Branch Conditionals & Pattern Matching](#2-multi-branch-conditionals--pattern-matching)
  - [3. Dynamic Classes & Event Modifiers](#3-dynamic-classes--event-modifiers)
  - [4. Pure Application Entrypoint (`src/main.hsx`)](#4-pure-application-entrypoint-srcmainhsx)
  - [5. Backend and Script Logic (`.hs` / `.hx`)](#5-backend-and-script-logic-hs--hx)
- [Meta-Framework Mode](#meta-framework-mode)
  - [CLI Commands](#cli-commands)
  - [Zero-Config Architecture](#zero-config-architecture)
  - [Configuration Reference (`hydraconfig.json`)](#configuration-reference-hydraconfigjson)
- [Compiler Architecture & Performance](#compiler-architecture--performance)
  - [Pipeline Flow](#pipeline-flow)
  - [Compilation Latency Benchmarks](#compilation-latency-benchmarks)
- [Language Reference](#language-reference)
  - [Component Definition](#component-definition)
  - [Property and Event Conventions](#property-and-event-conventions)
  - [Hooks & React Batteries](#hooks--react-batteries)
  - [JavaScript Globals Whitelist](#javascript-globals-whitelist)
  - [Module Imports and Exports](#module-imports-and-exports)
- [CLI Reference](#cli-reference)
- [Production Deployment](#production-deployment)
  - [Static Hosting](#static-hosting)
  - [Docker Container](#docker-container)
- [Editor Support](#editor-support)
- [Contributing & Architectural Roadmap](#contributing--architectural-roadmap)
- [License](#license)

---

## Overview

HydraScript is an indentation-based language and complete web meta-framework that combines the conciseness, visual clarity, and readability of Python with the power and ubiquity of the React and JavaScript ecosystems.

The project consists of three core components:
1. **The Native Compiler (`compiler-rs`)**: A self-contained binary written in pure Rust that compiles `.hsx` files to React TypeScript/JSX and `.hs` files to clean ES Modules in sub-millisecond times.
2. **The In-Memory Node-API Bridge (`hydra.node`)**: A native C-ABI shared library allowing bundlers and dev servers to call the compiler in-memory without spawning child processes.
3. **The Standalone Meta-Framework CLI (`packages/cli`)**: An integrated runner that wraps Vite, Tailwind CSS, and Autoprefixer programmatically, eliminating the need for `vite.config.ts`, `tailwind.config.ts`, or `tsconfig.json` in user projects.

---

## Design Philosophy

### 1. Zero Runtime Tax
HydraScript introduces zero proprietary client-side runtimes. The code you write in `.hsx` compiles directly to idiomatic React 18/19 components, JSX calls, and native browser hooks. There is no virtual machine, no interpreter overhead, and zero extra kilobytes sent to the user's browser.

### 2. Syntax-Level Elimination of Boilerplate
JSX requires developers to navigate opening and closing tags, double-curly braces for attribute interpolation, template literals for dynamic class names, and nested ternary chains for multi-branch rendering. HydraScript replaces this with clean Pythonic indentation, f-strings, list comprehensions, native dictionaries, and block-level control flow.

### 3. Radical Toolchain Simplicity
Modern web development often requires 5-8 configuration files before writing a single line of code (`tsconfig.json`, `vite.config.ts`, `tailwind.config.ts`, `postcss.config.js`, `eslint.config.js`). HydraScript reduces this to a single optional `hydraconfig.json`.

---

## Why HydraScript: Pain Points in Vanilla TSX

| Area | Vanilla TSX / React | HydraScript (`.hsx` / `.hs`) |
|---|---|---|
| **Element Hierarchy** | Closing tags required (`<div><header><h1></h1></header></div>`) | Clean indentation-based blocks (`div: header: h1: ...`) |
| **Multi-Branch Rendering** | Nested ternaries (`a ? <B/> : c ? <D/> : <E/>`) | Pythonic `if / elif / else` inside UI trees |
| **Pattern Matching** | IIFEs `(() => { switch(s) { ... } })()` | Native `match / case` directly inside tree blocks |
| **Falsy Zero Leak** | `count && <Badge/>` renders unwanted `0` text | Strict boolean truthiness check compiled automatically |
| **Dynamic Classes** | External libraries (`clsx`, `classnames`) required | Native dictionary syntax: `cls={"btn": True, "active": is_active}` |
| **Event Modifiers** | Repetitive `e.preventDefault(); e.stopPropagation();` | Declarative modifiers: `on_submit_prevent_stop=handle_submit` |
| **List Iteration** | `.map((item, idx) => <li key={item.id}>...</li>)` | Pythonic loop: `for item in items: li(key=item.id): item.name` |
| **String Formatting** | Backtick template literals: `` `${base}/${id}` `` | Clean f-strings: `f"{base}/{id}"` |
| **Multi-Root Nodes** | Manual fragment wrappers `<> ... </>` | Automatic fragment insertion by compiler |
| **State Declaration** | Verbose destructuring `const [val, setVal] = useState(0)` | Pythonic tuple unpacking: `val, set_val = state(0)` |
| **Global Builtins** | Can conflict with custom component names | Whitelist ensures `Math.cos()`, `Date.now()` are never JSX tags |

---

## Syntax & Feature Matrix

### Indentation-Based Layout
Single-line inline children use a colon followed by content; multi-line children use an indented block:

```python
# Inline
h1: "System Status"

# Block
div(className="container"):
    header(className="header"):
        h1: "System Status"
        p: "All telemetry nodes online."
```

### Auto-Fragment Insertion
When a component or block has multiple sibling roots, the compiler wraps them in `<> ... </>` automatically:

```python
component MetricPair(label: str, value: str):
    span(className="label"): label
    span(className="value"): value
```

Compiles to:
```tsx
export function MetricPair({ label, value }: MetricPairProps) {
  return (
    <>
      <span className="label">{label}</span>
      <span className="value">{value}</span>
    </>
  );
}
```

---

## Comprehensive Code Showcases

### 1. Reactive Component with State and Events

```python
# [xihanzu-NR]
from hydra import state, effect

component Counter(initial_count: int = 0, step: int = 1):
    count, set_count = state(initial_count)

    effect(lambda: console.log(f"Current count: {count}"), [count])

    div(className="counter-card"):
        h2: f"Value: {count}"
        div(className="button-group"):
            button(
                type="button",
                onClick=lambda: set_count(count - step),
                className="btn btn-secondary",
            ):
                "-"
            button(
                type="button",
                onClick=lambda: set_count(count + step),
                className="btn btn-primary",
            ):
                "+"
```

---

### 2. Multi-Branch Conditionals & Pattern Matching

```python
# [xihanzu-NR]
component ServerMonitor(status: str, load_average: float, alerts: list):
    section(className="monitor-panel"):
        h3: "Hardware Health"

        # Pattern matching directly inside JSX tree
        match status:
            case "healthy":
                div(className="status-pill status-green"): "Systems Nominal"
            case "degraded":
                div(className="status-pill status-amber"): "High Memory Pressure"
            case "critical":
                div(className="status-pill status-red"): "Node Offline"
            case _:
                div(className="status-pill status-gray"): "Telemetry Initializing"

        # Block-level branching
        if load_average > 4.0:
            div(className="warning-callout"):
                p: f"CPU load critical: {load_average:.2f}"
        elif load_average > 2.0:
            div(className="info-callout"):
                p: f"CPU load moderate: {load_average:.2f}"
        else:
            div(className="normal-callout"):
                p: f"CPU load normal: {load_average:.2f}"

        # Loop rendering
        ul(className="alert-list"):
            for alert in alerts:
                li(key=alert.id, className="alert-item"):
                    span(className="alert-time"): alert.timestamp
                    span(className="alert-msg"): alert.message
```

---

### 3. Dynamic Classes & Event Modifiers

```python
# [xihanzu-NR]
component ContactModal(on_submit, is_open: bool = False, is_submitting: bool = False):
    div(
        cls={
            "modal-backdrop": True,
            "opacity-100 pointer-events-auto": is_open,
            "opacity-0 pointer-events-none": not is_open,
        },
    ):
        div(className="modal-surface"):
            h2: "Dispatch Message"

            # Form with automated preventDefault and stopPropagation
            form(on_submit_prevent_stop=on_submit, className="modal-form"):
                label(for="email_input"): "Email Address"
                input(
                    id="email_input",
                    type="email",
                    required=True,
                    placeholder="name@domain.com",
                    className="input-text",
                )

                label(for="msg_input"): "Message"
                textarea(
                    id="msg_input",
                    rows=4,
                    required=True,
                    placeholder="Describe your inquiry...",
                    className="input-textarea",
                )

                div(className="form-actions"):
                    button(
                        type="submit",
                        disabled=is_submitting,
                        className="btn-submit",
                    ):
                        "Sending..." if is_submitting else "Send Message"
```

---

### 4. Pure Application Entrypoint (`src/main.hsx`)

Hydra projects do not require `main.tsx` or `index.ts`. The browser entrypoint is authored in pure HydraScript:

```python
# [xihanzu-NR]
from "react-dom/client" import createRoot
from "./App.hsx" import App
import "./index.css"

root_element = document.getElementById("root")
createRoot(root_element).render(App())
```

---

### 5. Backend and Script Logic (`.hs` / `.hx`)

HydraScript compiles pure logic files to standard ES Modules:

```python
# [xihanzu-NR]
from "node:fs/promises" import readFile, writeFile
from "node:path" import join

async def audit_metrics(directory: str, max_latency_ms: float):
    config_file = join(directory, "telemetry.json")
    content = await readFile(config_file, "utf8")
    records = JSON.parse(content)

    flagged = [
        item for item in records
        if item.latency > max_latency_ms
    ]

    report = {
        "timestamp": Date.now(),
        "total_records": len(records),
        "breaches": len(flagged),
        "flagged_nodes": flagged,
    }

    report_file = join(directory, "report.json")
    await writeFile(report_file, JSON.stringify(report, None, 2), "utf8")
    return report
```

---

## Meta-Framework Mode

Hydra includes an in-memory application runner that integrates Vite, Rollup, PostCSS, Autoprefixer, and Tailwind CSS into a single CLI workflow.

### CLI Commands
* `hydra dev`: Starts the local development server with Hot Module Replacement (HMR).
* `hydra build`: Runs a production build with asset hashing, dead-code elimination, and CSS minification.
* `hydra preview`: Starts a local HTTP server serving the compiled production output (`dist/`).
* `hydra run <file.hs>`: Executes a HydraScript logic file in-memory using Node or Bun.

### Zero-Config Architecture
When `hydra dev` or `hydra build` runs in a directory containing `hydraconfig.json`:
1. The Rust binary locates `packages/cli/runner.mjs`.
2. The runner dynamically loads Vite and plugins from the local project's `node_modules`.
3. In-memory configuration sets `configFile: false`, preventing Vite from looking for `vite.config.ts`.
4. Tailwind and Autoprefixer are configured in-memory using settings from `hydraconfig.json`.
5. The native Node-API addon (`hydra.node`) handles all `.hsx` and `.hs` transformations.

### Configuration Reference (`hydraconfig.json`)

```json
{
  "$schema": "https://hydrascript.dev/schema.json",
  "name": "production-app",
  "version": "1.0.0",
  "root": "./src",
  "outputDir": "./dist",
  "server": {
    "port": 5173,
    "host": "0.0.0.0"
  },
  "compiler": {
    "target": "react-18",
    "strict": true
  },
  "styling": {
    "tailwind": true
  },
  "tailwind": {
    "theme": {
      "extend": {
        "colors": {
          "primary": "#f54e00",
          "surface": "#f7f7f4",
          "ink": "#26251e"
        },
        "fontFamily": {
          "sans": ["Inter", "sans-serif"],
          "mono": ["JetBrains Mono", "monospace"]
        }
      }
    }
  }
}
```

---

## Compiler Architecture & Performance

### Pipeline Flow

```
                      [ Source: .hsx / .hs ]
                                 │
                                 ▼
                     [ Lexer (lexer.rs) ]
       Indent/Dedent Tracking, F-Strings, Unicode Identifiers
                                 │
                                 ▼
                   [ Parser (parser.rs) ]
     Recursive Descent, Tree Blocks, Comprehensions, Operators
                                 │
                                 ▼
               [ Semantic Analysis (emitter.rs) ]
     JS Builtin Whitelist, Scope Tracker, Mutability Analysis
                                 │
                 ┌───────────────┴───────────────┐
                 ▼                               ▼
       Target: React (.hsx)             Target: JS (.hs)
   TSX Components, Props Mapping     Clean ES Modules Output
                 │                               │
                 └───────────────┬───────────────┘
                                 ▼
         [ Node-API Shared Library (hydra.node) ]
                 In-Memory Transform Pipeline
```

### Compilation Latency Benchmarks
*Tested on Linux x86_64, 16-Core AMD EPYC, Node.js v20.19:*

| Workload | CLI Subprocess (`execFileSync`) | Node-API Addon (`hydra.node`) | Speedup |
|---|---|---|---|
| **15 Component Project** | 42.20 ms | **6.60 ms** | **6.4x faster** |
| **1,500 Repeated Compiles** | 235.30 ms | **42.61 ms** | **5.5x faster** |
| **Vite Full Production Build** | 4.96 s | **3.10 s** | **37% faster** |

* Binary Size: ~756 KB release executable (stripped, LTO enabled).
* Test Suite: 248 automated tests (159 unit tests + 89 end-to-end integration tests).

---

## Language Reference

### Component Definition
```python
component Name(prop_a: str, prop_b: int = 10, on_click=None):
    div: f"{prop_a}: {prop_b}"
```

### Property and Event Conventions
* `class`, `cls` -> `className`
* `for` -> `htmlFor`
* `tab_index` -> `tabIndex`
* `on_click` -> `onClick`
* `on_change` -> `onChange`
* `on_submit` -> `onSubmit`
* `on_key_down` -> `onKeyDown`
* `on_mouse_enter` -> `onMouseEnter`
* `aria_*` -> `aria-*`
* `data_*` -> `data-*`

Event modifier suffixes:
* `_prevent`: Calls `event.preventDefault()`
* `_stop`: Calls `event.stopPropagation()`
* `_prevent_stop`: Calls both

### Hooks & React Batteries
HydraScript exposes Pythonic adapters for standard React primitives via the `hydra` runtime:

| Hydra Function | Underlying React API | Description |
|---|---|---|
| `val, set_val = state(init)` | `useState` | Returns value and setter tuple |
| `r = ref(init)` | `useRef` | Creates a persistent mutable ref |
| `cb = callback(fn, deps)` | `useCallback` | Memoizes callback function |
| `effect(fn, deps)` | `useEffect` | Runs side-effect on dependency change |
| `val, toggle_fn, set_val = toggle(False)` | Custom hook | Boolean toggle with toggle function |
| `is_mounted = use_mounted()` | Custom hook | Returns true after client mount |

### JavaScript Globals Whitelist
The compiler recognizes built-in JavaScript globals and ensures calls to their methods are never emitted as JSX tags:
* `Math`, `Date`, `Array`, `Object`, `Number`, `String`, `Boolean`
* `RegExp`, `JSON`, `Promise`, `Reflect`, `Intl`, `Set`, `Map`
* `WeakSet`, `WeakMap`, `Symbol`, `Error`, `TypeError`, `RangeError`
* `ResizeObserver`, `IntersectionObserver`, `MutationObserver`
* `WebSocket`, `Worker`, `Audio`, `Image`, `FormData`, `URL`, `URLSearchParams`

### Module Imports and Exports
```python
# Named import from package
from "react" import useState, useEffect

# Default / named import from local component
from "./Header.hsx" import Header

# Namespace import
import "three" as THREE

# Side-effect CSS import
import "./index.css"

# Exporting a component
export component Button(label: str):
    button: label

# Exporting a function or variable
export def calculate_tax(amount):
    return amount * 0.11

export API_URL = "https://api.domain.com/v1"
```

---

## CLI Reference

```
hydra [COMMAND] [OPTIONS]

COMMANDS:
  dev                   Start development server with live HMR
  build                 Compile and bundle project for production
  preview               Preview production build locally
  run <file.hs> [args]  Execute HydraScript script in memory
  watch [dir]           Watch directory and recompile on change
  check <file.hsx>      Parse and validate syntax without emitting
  repl                  Start interactive HydraScript REPL session
  --version, -v         Display compiler version information
  --help, -h            Display help information

ENVIRONMENT VARIABLES:
  HYDRA_NATIVE          Explicit path to hydra.node addon
  HYDRA_COMPILER        Explicit path to hydra CLI binary
```

---

## Production Deployment

### Static Hosting
For Vercel, Netlify, Cloudflare Pages, or GitHub Pages:

```bash
# Build static assets
npm run build # executes 'hydra build'

# Output directory
dist/
```

Configure your hosting provider:
* **Build Command**: `hydra build` (or `npm run build`)
* **Output Directory**: `dist`

### Docker Container
A multi-stage Dockerfile for production deployment:

```dockerfile
# [xihanzu-NR]
FROM node:20-alpine AS builder
WORKDIR /app

# Install dependencies
COPY package*.json hydraconfig.json ./
RUN npm ci

# Copy source and native tools
COPY . .

# Build with Hydra
RUN npx hydra build

FROM nginx:alpine AS runner
COPY --from=builder /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
```

---

## Editor Support

### VS Code
Syntax highlighting support is provided in `editors/vscode`:
1. Copy or symlink `editors/vscode` to `~/.vscode/extensions/hydrascript`.
2. Reload VS Code.
3. `.hsx` and `.hs` files will display syntax coloring, keyword recognition, and indentation guides.

---

## Contributing & Architectural Roadmap

HydraScript is actively developing toward a v1.0 GA release. Comprehensive architectural plans, including file-based routing and a native language server (`hydra-lsp`), are documented in:
* [`PRODUCTION_BLUEPRINT.md`](PRODUCTION_BLUEPRINT.md): Architectural roadmap and meta-framework specification.
* [`CRITIQUE_AND_ROADMAP.md`](CRITIQUE_AND_ROADMAP.md): Detailed compiler diagnostics and edge-case analysis.

To run the compiler test suite locally:
```bash
cd compiler-rs
cargo test
```

---

## License

MIT License. Copyright (c) Reyhan Akhtar Afriansyah (Hanz).
All rights reserved.
