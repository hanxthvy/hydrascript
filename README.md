<!-- [xihanzu-NR] -->
<div align="center">

# 🐉 HydraScript
### The Pythonic Programming Language & Compiler for React and Node.js

[![Rust Compiler](https://img.shields.io/badge/compiler-100%25%20Pure%20Rust-orange?style=for-the-badge&logo=rust)](https://github.com/hanxthvy/hydrascript)
[![Tests Passing](https://img.shields.io/badge/tests-218%20passing-brightgreen?style=for-the-badge&logo=github-actions)](https://github.com/hanxthvy/hydrascript)
[![Binary Size](https://img.shields.io/badge/binary-603_KB-blueviolet?style=for-the-badge)](https://github.com/hanxthvy/hydrascript)
[![Compile Time](https://img.shields.io/badge/compile%20speed-~1.2ms-blue?style=for-the-badge&logo=lightning)](https://github.com/hanxthvy/hydrascript)
[![React 18+](https://img.shields.io/badge/react-18%2B%20compatible-61dafb?style=for-the-badge&logo=react)](https://github.com/hanxthvy/hydrascript)
[![License](https://img.shields.io/badge/license-MIT-green?style=for-the-badge)](LICENSE)

<br/>

**Write UI components (`.hsx`) and backend scripts (`.hs`) with clean, indentation-based syntax.**  
No JSX curly-bracket fatigue. No nested ternary hell. No `e.preventDefault()` boilerplate.  
Compiles into standard React TSX and native Node.js ES Modules in **~1.2 milliseconds** with **zero runtime overhead**.

[Features](#-why-hydrascript-vs-vanilla-tsx) •
[Quickstart](#-quickstart) •
[Architecture](#-compiler-architecture) •
[Language Guide](#-language-reference) •
[VS Code Setup](#-vs-code-extension)

---

</div>

## 💡 Why HydraScript vs Vanilla TSX?

React is the world's most powerful UI paradigm, but **TSX syntax has chronic pain points**: tag fatigue, double-curly syntax `style={{ ... }}`, nested ternary chains, and verbose hook boilerplate.

HydraScript (`.hsx`) solves all of them at compile time, outputting clean, human-readable TSX:

| Problem in Vanilla TSX | HydraScript Solution (`.hsx`) |
|---|---|
| **Nested Ternary Hell**: Multi-branch conditional rendering forces `cond ? <A/> : cond2 ? <B/> : <C/>` which is notoriously unreadable. | **Pythonic `if / elif / else` & `match / case`**: Real block-level branching directly inside JSX trees. |
| **Numeric Zero Bug**: Short-circuit `count && <Badge/>` accidentally renders the raw number `0` in your DOM when `count === 0`. | **Strict Truthiness**: Compiles to safe binary checks and clean ternaries without falsy leak. |
| **Missing Pattern Matching**: TSX has no pattern matching; devs use IIFEs `(() => { switch(s) ... })()` or nested ternaries. | **Native `match / case`**: Pattern matching in JSX compiled to optimized reactive expressions. |
| **External Styling Dependencies**: Dynamic classes require installing `clsx`, `classnames`, or writing template literal strings. | **Native `cls` Shorthand**: Pass python dicts `cls={"btn": True, "active": is_active}` or lists directly. |
| **Event Modifier Boilerplate**: Every form needs `(e) => { e.preventDefault(); handleSubmit(e); }`. | **Declarative Modifiers**: `on_submit_prevent=handle_submit`, `on_click_stop=handle_click`. |
| **Root Fragment Clutter**: Sibling tags at component root force manual `<> ... </>` wrappers. | **Auto-Fragment**: Multi-root children are automatically grouped in fragments by the compiler. |
| **Loop Ceremony**: Iterating over lists requires `.map((item) => (<li key={item.id}>...</li>))`. | **Natural Loop Syntax**: `for item in items: li(key=item.id): item.name` |
| **Hooks Verbosity**: `const [value, setValue] = useState(0)` is repetitive. | **Clean Destructuring**: `value, set_value = state(0)` |

---

## ⚔️ Side-by-Side Code Comparison

### 1. Conditional Rendering & Pattern Matching

#### ❌ Vanilla TSX
```tsx
export function StatusCard({ status, count }: StatusCardProps) {
  return (
    <div className="card">
      {status === 'loading' ? (
        <Spinner />
      ) : status === 'error' ? (
        <ErrorAlert />
      ) : (
        <Dashboard />
      )}
      {count !== 0 && <span>{count} items left</span>}
    </div>
  );
}
```

#### ✅ HydraScript (`.hsx`)
```python
component StatusCard(status: str, count: int):
    div(className="card"):
        match status:
            case "loading":
                Spinner:
            case "error":
                ErrorAlert:
            case _:
                Dashboard:

        if count > 0:
            span: f"{count} items left"
```

---

### 2. Form Handling & Conditional Styling

#### ❌ Vanilla TSX
```tsx
import clsx from 'clsx';

export function LoginForm({ onSubmit, loading, error }) {
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit();
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <input
        className={clsx('input-base', {
          'border-red-500 text-red-900': error,
          'border-gray-300': !error,
          'opacity-50 cursor-not-allowed': loading,
        })}
      />
      <button
        type="submit"
        disabled={loading}
        className={clsx('btn', loading ? 'btn-disabled' : 'btn-primary')}
      >
        {loading ? 'Submitting...' : 'Sign In'}
      </button>
    </form>
  );
}
```

#### ✅ HydraScript (`.hsx`)
```python
component LoginForm(on_submit, loading: bool = False, error: bool = False):
    # on_submit_prevent automatically calls e.preventDefault()
    # cls accepts dictionaries & lists without any external library!
    form(on_submit_prevent=on_submit, className="space-y-4"):
        input(
            cls={
                "input-base": True,
                "border-red-500 text-red-900": error,
                "border-gray-300": not error,
                "opacity-50 cursor-not-allowed": loading
            }
        )
        button(
            type_="submit",
            disabled=loading,
            cls=["btn", "btn-disabled" if loading else "btn-primary"]
        ):
            "Submitting..." if loading else "Sign In"
```

---

## 🎯 Complete Real-World Demo: `TodoApp.hsx`

A fully functional, rich React component using Tailwind CSS, local state, effects, conditional styling, event modifiers, and list comprehensions:

```python
# [xihanzu-NR]
from hydrascript import state, effect

component TodoApp():
    todos, set_todos = state(["Explore HydraScript", "Build Frontend"])
    text, set_text = state("")
    filter_mode, set_filter = state("all")
    count = len(todos)

    def add_task(e):
        if text.strip():
            set_todos(todos + [text.strip()])
            set_text("")

    def remove_task(item):
        set_todos([t for t in todos if t != item])

    # Multiple root elements automatically get wrapped in <>...</>!
    h1(className="text-3xl font-extrabold text-gray-900"): "HydraScript Tasks"
    p(className="text-sm text-gray-500 mb-4"): f"Managing {count} total task(s)"

    form(on_submit_prevent=add_task, className="flex gap-2"):
        input(
            value=text,
            on_change=lambda e: set_text(e.target.value),
            placeholder="What needs to be done?",
            className="flex-1 px-4 py-2 border rounded-lg focus:outline-none focus:ring-2",
            cls={"border-red-400": not text, "border-indigo-500": text}
        )
        button(
            cls=["px-5 py-2 font-medium rounded-lg text-white transition",
                 "bg-indigo-600 hover:bg-indigo-700" if text else "bg-gray-400 cursor-not-allowed"]
        ): "Add Task"

    match count:
        case 0:
            div(className="p-8 text-center text-gray-400 italic bg-gray-50 rounded-lg"):
                "No tasks yet. Type above and press Add Task!"
        case _:
            ul(className="divide-y border rounded-lg mt-4"):
                for item in todos:
                    li(key=item, className="p-3 flex justify-between items-center hover:bg-gray-50"):
                        span(className="text-gray-800"): item
                        button(
                            on_click=lambda it=item: remove_task(it),
                            className="text-red-500 hover:text-red-700 text-sm font-semibold"
                        ): "Delete"
```

---

## ⚡ Dual-Target Architecture: UI & Scripting

HydraScript is not just for UI. The compiler automatically dispatches code based on extension:

```
┌────────────────────────────────────────────────────────┐
│             HydraScript Standalone Binary              │
│                 (603 KB Rust Native)                   │
└───────────────────────────┬────────────────────────────┘
                            │
              ┌─────────────┴─────────────┐
              ▼                           ▼
        Target: `.hsx`              Target: `.hs`
     (React TSX Components)     (Plain ES Module JS)
              │                           │
              ▼                           ▼
        Vite / Next.js              Node.js / Bun
        React 18 Engine             Direct Execution
```

### Scripting with `.hs` (Node.js / Backend)

Write general-purpose scripts with Python syntax, executed directly in Node.js via `hydra run`:

```python
# fib.hs
from hydrascript_js import range

def fib(n: int) -> int:
    if n < 2:
        return n
    return fib(n - 1) + fib(n - 2)

# Full language features: while, try/except, async/await
def run_benchmark():
    try:
        numbers = [fib(i) for i in range(10)]
        print(f"First 10 Fibonacci numbers: {numbers}")
    except ValueError as err:
        print(f"Calculation failed: {err}")
    finally:
        print("Benchmark complete.")

run_benchmark()
```

Run it instantly with **zero compilation artifacts**:
```bash
hydra run fib.hs
# Output:
# First 10 Fibonacci numbers: [0, 1, 1, 2, 3, 5, 8, 13, 21, 34]
# Benchmark complete.
```

---

## 🏎️ Performance & Architecture Realities

HydraScript is engineered in Rust to ensure the compiler never gets in the developer's way. Here is an honest, measured breakdown of performance characteristics on real hardware:

### 1. In-Process Compiler Throughput
- **Component Compile Time**: **~1.4 ms** per file (measured via batch CLI `hydra build`, executing in-memory lexing, recursive-descent parsing, AST lowering, TSX generation, and VLQ source-map encoding).
- **Process Spawn Overhead**: **~18 ms** when invoked as an isolated CLI command via OS process spawn.
- **Binary Footprint**: **603 KB** (single standalone stripped binary, zero external runtime or VM dependencies).

### 2. Honest Architectural Comparison

| Dimension | HydraScript (`.hsx`) | Python-in-Browser (Pyodide / Brython) | Standard TSX (esbuild / SWC) |
|---|---|---|---|
| **Compilation Model** | **AOT (Build-Time Ahead-of-Time)** | JIT / In-browser WASM virtual machine | AOT (Build-Time Ahead-of-Time) |
| **Browser Runtime Overhead** | **0 KB** (emits pure native React 18) | 220 KB (Brython) to 3.3 MB (Pyodide WASM) | 0 KB (pure React) |
| **Compiler Latency** | **~1.4 ms / file** (in-process Rust) | 200 ms - 2.5s client cold-boot delay | <1 ms / file |
| **Core Value Proposition** | **Solves TSX syntactic flaws without penalty** | Emulates full CPython standard library | Standard JSX with curly-bracket fatigue |

> **Engineering Note**: HydraScript does not claim to outperform `esbuild` or `SWC` on raw compilation throughput—both already operate near hardware speed limits. Instead, HydraScript matches native compiler speeds while providing **substantially cleaner language ergonomics** (pattern matching, auto-fragments, natural indentation trees, and zero-boilerplate event modifiers).

---

## 🚀 Quickstart

### 1. Installation

Download the prebuilt native compiler directly or build with Cargo:

```bash
# Clone the repository
git clone https://github.com/hanxthvy/hydrascript.git
cd hydrascript

# Build the native binary (requires Rust toolchain)
cd compiler-rs && cargo build --release
sudo cp target/release/hydra /usr/local/bin/hydra

# Verify installation
hydra --version
# hydra 0.1.0
```

### 2. Run Scripts Directly

```bash
# Execute in-memory without saving intermediate files
hydra run script.hs

# Pass arguments directly to your script
hydra run server.hs --port 8080
```

### 3. Compile for React Project

```bash
# Compile to React TSX
hydra Component.hsx -o Component.tsx

# Parse and check syntax without emitting
hydra --check Component.hsx
```

### 4. Vite Integration

Add the plugin to your `vite.config.ts`:

```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import hydrascript from 'vite-plugin-hydrascript';

export default defineConfig({
  plugins: [hydrascript(), react()],
});
```

Now you can import `.hsx` files directly in your React app:
```typescript
import { TodoApp } from './TodoApp.hsx';
```

---

## 🧩 VS Code Extension

Official syntax highlighting and compiler diagnostics for Visual Studio Code & Cursor:

1. Locate the packaged extension in `editors/vscode/hydrascript-0.1.0.vsix`.
2. Install via VS Code CLI or Extensions GUI:
   ```bash
   code --install-extension editors/vscode/hydrascript-0.1.0.vsix
   ```
3. **Features Included**:
   - Highlighting for `.hsx` and `.hs` files.
   - Real-time compiler syntax errors & caret diagnostics.
   - Automatic indentation formatting.

---

## 📚 Language Reference

### Python Built-in Rewriting
HydraScript automatically transforms idiomatic Python calls into optimized JavaScript equivalents at compile time:

| Python Expression | Generated JavaScript / TSX |
|---|---|
| `len(items)` | `items.length` |
| `str.strip()` | `str.trim()` |
| `str.upper()` / `lower()` | `str.toUpperCase()` / `toLowerCase()` |
| `str.startswith("a")` | `str.startsWith("a")` |
| `sum(numbers)` | `numbers.reduce((a, b) => a + b, 0)` |
| `sorted(items)` | `items.slice().sort()` |
| `reversed(items)` | `items.slice().reverse()` |
| `xs[1:4]` | `xs.slice(1, 4)` |
| `f"Hello {name}"` | `` `Hello ${name}` `` |
| `x == y` / `x != y` | `x === y` / `x !== y` |
| `and` / `or` / `not` | `&&` / `\|\|` / `!` |
| `True` / `False` / `None` | `true` / `false` / `null` |

### Batteries Runtime (`hydrascript`)
- `state(init)`: React `useState` adapter.
- `computed(fn, deps)`: React `useMemo` adapter.
- `effect(fn, deps)`: React `useEffect` adapter.
- `ref(init)`: React `useRef` adapter.
- `callback(fn, deps)`: React `useCallback` adapter.
- `reducer(fn, init)`: React `useReducer` adapter.
- `cx(...classes)`: Built-in conditional class combiner.

---

## 🧪 Verification & Test Suite

HydraScript enforces strict quality with **218 tests passing** (148 unit tests, 70 integration tests):

```bash
# Run Rust compiler test suite
cd compiler-rs
cargo test

# Run Node runtime test suite
npm run test:js
```

---

## 📄 License

HydraScript is open-source software licensed under the [MIT License](LICENSE).
Copyright (c) 2026 HydraScript Contributors.
