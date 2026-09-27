<!-- [xihanzu-NR] -->
# HydraScript

### Pythonic Syntax for React, Node.js, and Modern Web Applications
A standalone native Rust compiler and zero-config meta-framework with zero runtime overhead.

---

## Overview

HydraScript is an indentation-based language and compiler that brings the ergonomics, clarity, and conciseness of Python to the React and Node.js ecosystems. It eliminates JSX boilerplate, closing tag clutter, nested ternary expressions, and framework configuration fatigue.

HydraScript compiles into human-readable React TSX and native ES Modules in sub-millisecond timeframes using a native Rust binary (`hydra`) and an in-memory Node-API addon (`hydra.node`).

* **Component Files (`.hsx`)**: Declarative UI trees compiled to React 18/19 components.
* **Script Files (`.hs` / `.hx`)**: Pure logic, utilities, backend servers, and CLI scripts compiled to standard ES modules.
* **Meta-Framework Mode**: Native CLI commands (`hydra dev`, `hydra build`, `hydra preview`) with zero configuration files required in the repository.

---

## Why HydraScript vs Vanilla TSX

React remains a dominant UI paradigm, but JSX syntax carries chronic structural pain points: verbose closing tags, double-curly braces for objects and styles, fragile ternary chains, and repetitive event handler ceremony.

HydraScript solves these issues at compile time:

| Concern | Vanilla TSX | HydraScript (`.hsx` / `.hs`) |
|---|---|---|
| **Structure** | Mandatory opening and closing tags (`<div>...</div>`) | Indentation-based hierarchy (`div: ...`) |
| **Branching** | Nested ternary operators (`a ? <B/> : c ? <D/> : <E/>`) | Pythonic `if / elif / else` directly in UI tree |
| **Pattern Matching** | IIFEs `(() => { switch(...) ... })()` | Native `match / case` directly inside elements |
| **Zero Bug** | Short-circuit `count && <Tag/>` leaks `0` to DOM | Strict compile-time truthiness and boolean coercion |
| **Dynamic Styling** | External packages (`clsx`, `classnames`) | Native `cls={"btn": True, "active": active}` dict/list syntax |
| **Event Modifiers** | Manual boilerplate `(e) => { e.preventDefault(); fn(e); }` | Declarative modifiers: `on_submit_prevent=handler` |
| **Iteration** | Mandatory `.map((item) => <li key={item.id}>...</li>)` | Clean loops: `for item in items: li(key=item.id): item.name` |
| **String Interpolation** | Template strings with backticks: `` `${prefix}-${id}` `` | Standard f-strings: `f"{prefix}-{id}"` |
| **Root Sibling Tags** | Manual fragment wrappers `<> ... </>` | Auto-fragment insertion by compiler for multi-root nodes |
| **State Declaration** | Verbose destructuring `const [val, setVal] = useState(0)` | Clean Pythonic unpacking: `val, set_val = state(0)` |
| **Configuration** | Multiple config files (`vite.config`, `tsconfig`, `tailwind`) | Single optional `hydraconfig.json` or zero-config defaults |

---

## Code Comparison

### 1. Conditional Rendering and Pattern Matching

#### Vanilla TSX
```tsx
export function StatusCard({ status, count }: StatusCardProps) {
  return (
    <div className="card">
      {status === 'loading' ? (
        <Spinner />
      ) : status === 'error' ? (
        <ErrorAlert />
      ) : status === 'empty' ? (
        <EmptyPlaceholder />
      ) : (
        <DashboardView />
      )}
      {count !== 0 && <span>{count} pending actions</span>}
    </div>
  );
}
```

#### HydraScript (`.hsx`)
```python
# [xihanzu-NR]
component StatusCard(status: str, count: int):
    div(className="card"):
        match status:
            case "loading":
                Spinner:
            case "error":
                ErrorAlert:
            case "empty":
                EmptyPlaceholder:
            case _:
                DashboardView:

        if count > 0:
            span: f"{count} pending actions"
```

---

### 2. Form Submission with Event Modifiers and Dynamic Classes

#### Vanilla TSX
```tsx
import clsx from 'clsx';

export function AuthForm({ onSubmit, loading, hasError }) {
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onSubmit();
  };

  return (
    <form onSubmit={handleSubmit} className="form-container">
      <input
        type="email"
        placeholder="user@example.com"
        className={clsx('input-field', {
          'border-red-500': hasError,
          'opacity-50 cursor-not-allowed': loading,
        })}
        disabled={loading}
      />
      <button type="submit" disabled={loading}>
        {loading ? 'Authenticating...' : 'Sign In'}
      </button>
    </form>
  );
}
```

#### HydraScript (`.hsx`)
```python
# [xihanzu-NR]
component AuthForm(on_submit, loading: bool = False, has_error: bool = False):
    form(on_submit_prevent_stop=on_submit, className="form-container"):
        input(
            type="email",
            placeholder="user@example.com",
            cls={
                "input-field": True,
                "border-red-500": has_error,
                "opacity-50 cursor-not-allowed": loading,
            },
            disabled=loading,
        )
        button(type="submit", disabled=loading):
            "Authenticating..." if loading else "Sign In"
```

---

### 3. Application Entrypoint (`src/main.hsx`)

HydraScript supports full application mounting without any intermediate `.tsx` or `.ts` files:

```python
# [xihanzu-NR]
from "react-dom/client" import createRoot
from "./App.hsx" import App
import "./index.css"

root_el = document.getElementById("root")
createRoot(root_el).render(App())
```

---

### 4. Backend and Script Logic (`.hs` / `.hx`)

HydraScript compiles non-component code to clean, tree-shakeable ES modules:

```python
# [xihanzu-NR]
from "node:fs/promises" import readFile, writeFile
from "node:path" import join

async def process_telemetry(data_dir: str, threshold: float):
    raw = await readFile(join(data_dir, "metrics.json"), "utf8")
    payload = JSON.parse(raw)
    
    filtered = [
        item for item in payload.entries
        if item.score >= threshold and item.valid
    ]
    
    output = {
        "timestamp": Date.now(),
        "total": len(filtered),
        "results": filtered,
    }
    
    await writeFile(
        join(data_dir, "summary.json"),
        JSON.stringify(output, None, 2),
        "utf8",
    )
    return output
```

---

## Compiler Architecture

The compiler is built in pure Rust with zero external runtime dependencies.

```
Source (.hs / .hsx)
        │
        ▼
   [ Lexer ]  ──────────────── Indentation & Dedent Tokenizer
        │
        ▼
   [ Parser ] ──────────────── Recursive Descent with Pythonic Precedence
        │
        ▼
 [ Semantic Pass ] ────────── Scope Resolution, JS Builtin Whitelist, Mutability
        │
        ▼
   [ Emitter ]
   ├── Target::React ──────── Emit TSX / JSX for React 18+
   └── Target::Js    ──────── Emit clean ES Modules
        │
        ▼
 Output (TypeScript / JavaScript + VLQ Source Maps)
```

### Compiler Modules in `compiler-rs`
* `lexer.rs`: Handles indentation levels via dedicated `INDENT` and `DEDENT` tokens, Unicode identifiers, string literals, and f-strings.
* `parser.rs`: Recursive descent parser supporting component blocks, inline elements, expressions, comprehensions, and control flow.
* `emitter.rs`: Transforms AST into valid TypeScript/JSX with React prop mapping, event modifiers, and import deduplication.
* `hx_target.rs`: JavaScript target emitter for pure logic modules (`.hs` / `.hx`).
* `napi.rs`: Node-API shared library bindings (`hydra.node`) exposing direct in-memory compilation without subprocess overhead.
* `cli.rs`: Command dispatcher supporting single-file execution and meta-framework orchestration.

---

## Meta-Framework Mode

HydraScript functions as a complete, self-contained web framework.

### Commands
* `hydra dev`: Starts a local development server with instant Hot Module Replacement (HMR).
* `hydra build`: Compiles all assets, performs tree-shaking, extracts CSS, and outputs a production-ready bundle.
* `hydra preview`: Launches a local production preview server.
* `hydra run <file.hs>`: Executes a HydraScript logic file directly in memory via Node or Bun.

### Zero Configuration by Default
When running `hydra dev` or `hydra build`, HydraScript automatically:
1. Detects `hydraconfig.json` in the project root.
2. Injects the native `hydra.node` compiler into the bundling pipeline.
3. Automatically inlines Tailwind CSS and Autoprefixer without requiring `tailwind.config.ts` or `postcss.config.js`.
4. Establishes module aliases (`hydra` -> `src/hydra.hs`, `@` -> `src/`).

### Configuration Specification (`hydraconfig.json`)
All project settings can be defined in a single JSON file:

```json
{
  "$schema": "https://hydrascript.dev/schema.json",
  "name": "my-hydra-app",
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

## Language Reference

### 1. Components
Declared with the `component` keyword. Parameters map to React props.
```python
component MetricDisplay(label: str, value: float, active: bool = False):
    div(className="metric-box"):
        span(className="label"): label
        span(className="value"): f"{value:.2f}"
```

### 2. Elements and Hierarchy
HTML elements are declared by name, followed by optional attributes in parentheses, and a colon:
```python
section(id="overview", className="container"):
    h1: "System Architecture"
    p:
        "Multi-line paragraph text is nested with indentation."
```

### 3. Property and Event Mapping
HydraScript automatically translates snake_case attribute names to React camelCase conventions:
* `class` or `cls` -> `className`
* `for` -> `htmlFor`
* `tab_index` -> `tabIndex`
* `on_click` -> `onClick`
* `on_change` -> `onChange`
* `on_submit` -> `onSubmit`
* `aria_*` -> `aria-*` (dashes preserved)
* `data_*` -> `data-*` (dashes preserved)

Event modifier suffixes:
* `_prevent`: Calls `event.preventDefault()`
* `_stop`: Calls `event.stopPropagation()`
* `_prevent_stop`: Calls both `preventDefault()` and `stopPropagation()`

### 4. Built-in Globals Whitelist
Standard JavaScript globals are recognized by the compiler and are never transformed into JSX tags:
`Math`, `Date`, `Array`, `Object`, `Number`, `String`, `Boolean`, `RegExp`, `JSON`, `Promise`, `Reflect`, `Intl`, `Set`, `Map`, `WeakSet`, `WeakMap`, `Symbol`, `Error`, `TypeError`, `RangeError`, `ResizeObserver`, `IntersectionObserver`, `MutationObserver`, `WebSocket`, `Worker`, `Audio`, `Image`, `FormData`, `URL`, `URLSearchParams`.

Example:
```python
# Compiles to <div>{Math.cos(angle)}</div>, not <Math.cos>
div: Math.cos(angle)
```

### 5. Control Flow
```python
# Conditional blocks
if is_logged_in:
    UserPanel:
elif is_guest:
    GuestBanner:
else:
    LoginPrompt:

# Loops inside UI trees
ul:
    for user in users:
        li(key=user.id): user.name

# List comprehensions
active_names = [u.name.upper() for u in users if u.is_active]
```

### 6. Functions and Lambdas
```python
# Standard function
def compute_total(items, tax_rate=0.1):
    return sum([item.price for item in items]) * (1.0 + tax_rate)

# Inline lambda
button(onClick=lambda: set_count(count + 1)): "Increment"
```

---

## Performance Benchmarks

Measured on Linux x86_64, 16-Core AMD EPYC:

| Benchmark | CLI Execution (`execFileSync`) | Node-API Addon (`hydra.node`) | Improvement |
|---|---|---|---|
| **15 Portfolio Files** | 42.20 ms | **6.60 ms** | **6.4x faster** |
| **1,500 Repeated Compiles** | 235.30 ms | **42.61 ms** | **5.5x faster** |
| **Vite Production Build (45 modules)** | 4.96 s | **3.10 s** | **37% faster** |

* Binary Size: ~756 KB release executable (`strip` enabled, LTO level 3).
* Runtime Footprint: 0 KB runtime tax. The compiled output uses standard React primitives directly.

---

## Installation & Setup

### Building from Source
Ensure Rust (1.80+) and Cargo are installed:

```bash
git clone https://github.com/hanxthvy/hydrascript.git
cd hydrascript/compiler-rs

# Run test suite (248 unit and integration tests)
cargo test

# Build release binary and Node-API addon
cargo build --release

# Install binary to path
cp target/release/hydra /usr/local/bin/hydra
```

### Project Quickstart
Create a new directory with a single `src/main.hsx` and `index.html`:

```bash
mkdir my-app && cd my-app
npm init -y
npm install react react-dom

# Start development server
hydra dev

# Build for production
hydra build
```

---

## Editor Integration

### VS Code Extension
Syntax highlighting grammar for `.hs` and `.hsx` is located under `editors/vscode`:
1. Copy or symlink `editors/vscode` to `~/.vscode/extensions/hydrascript`.
2. Provides syntax coloring, keyword recognition, and indentation formatting for HydraScript files.

---

## License

MIT License. Copyright (c) Reyhan Akhtar Afriansyah (Hanz).
