<!-- [xihanzu-NR] -->
# Serpent — Pythonic Syntax for React & Modern JavaScript

> **The Zen of Python, running at the speed of native React & Node.js.**
> Write React components (`.hsx`) and Node scripts (`.hx`) with clean, indentation-based syntax without JSX curly braces or semicolon fatigue. Compiles in **~1.2ms** via a standalone native Rust binary (~600KB). Zero runtime overhead in the browser.

```serpent
# App.hsx
from serpent import state, fetch_json

component TodoApp():
    todos, set_todos = state(["Belajar Serpent", "Bikin Frontend"])
    text, set_text = state("")
    count = len(todos)

    def add(e):
        if text.strip():
            set_todos(todos + [text])
            set_text("")

    h1(className="text-2xl font-bold"): "Todo Serpent"
    p(className="text-sm text-gray-500"): f"Total: {count} tasks"

    # Event modifier: on_submit_prevent auto preventDefault()
    form(on_submit_prevent=add, className="flex gap-2"):
        input(
            value=text,
            on_change=lambda e: set_text(e.target.value),
            placeholder="Tambah todo...",
            # Conditional styling: dict or list without clsx/classnames library
            cls={"border-red-500": not text, "border-green-500": text}
        )
        button(cls=["px-4 py-2", "bg-blue-600 text-white" if text else "bg-gray-300"]): "Tambah"

    # Pattern matching in JSX: No more messy nested ternaries
    match count:
        case 0:
            p(className="text-gray-400 italic"): "Belum ada tugas."
        case _:
            ul(className="divide-y"):
                for item in todos:
                    li(key=item, className="py-2 flex justify-between"):
                        span: item
                        button(
                            on_click=lambda: set_todos([t for t in todos if t != item]),
                            className="text-red-500 text-sm"
                        ): "Hapus"
```

---

## 🚀 Keunggulan `.hsx` Dibanding TSX Standar

Serpent bukan sekadar sintaks baru, melainkan penyempurna dari kekurangan dan *pain points* terbesar di TSX:

| Fitur | TSX Standar | Serpent (`.hsx`) |
|---|---|---|
| **Conditional Rendering** | Rantai ternary bersarang (`a ? b : c ? d : e`) atau bug angka nol (`count && <div/>` merender `0`). | Blok `if` / `elif` / `else` atau `match / case` berbasis indentasi. Bersih dan aman. |
| **Pattern Matching** | Tidak ada. Terpaksa membuat IIFE `(() => { switch(x)... })()` atau ternary bertingkat. | `match status:` dengan `case "loading":`, `case _:`. Di-compile ke ekspresi reaktif instan. |
| **Styling Kondisional** | Memerlukan dependensi luar (`clsx`, `classnames`, `cn()`) dan template literal rumit. | Native `cls` shorthand: `cls={"btn": True, "active": is_active}` atau list Python. Di-compile otomatis. |
| **Event Boilerplate** | `(e) => { e.preventDefault(); onSubmit(e); }` berulang-ulang. | Deklaratif event modifier: `on_submit_prevent=save`, `on_click_stop=close`. |
| **Root Fragments** | Wajib membungkus elemen bersaudara dengan `<> ... </>` atau `React.Fragment`. | **Auto-Fragment**: Multi-root children otomatis dibungkus fragment tanpa developer perlu mengetiknya. |
| **List Rendering** | Memerlukan `.map(item => (...))` dan kurung kurawal berlapis. | Sintaks Pythonic langsung di dalam tree: `for item in items:` |

---

## ⚡ Dua Target dalam Satu Compiler

Compiler Serpent otomatis mendeteksi target berdasarkan ekstensi file:

```
.hsx  ──►  React TSX    (komponen, pohon JSX, state, hooks)
.hx   ──►  JavaScript   (skrip umum, Node.js, CLI, backend service)
```

### Scripting dengan `.hx` (Plain ES Module)

Untuk kode non-UI / Node.js tanpa React atau JSX:

```serpent
# fib.hx
from serpent_js import range

def fib(n: int) -> int:
    if n < 2:
        return n
    return fib(n - 1) + fib(n - 2)

def fib_list(count: int) -> list:
    return [fib(i) for i in range(count)]

print(f"10 Fibonacci pertama: {fib_list(10)}")
```

Dukungan lengkap statement di `.hx`:
- `while`, `break`, `continue`, `pass`
- `try` / `except ValueError as e:` / `finally` (dengan class exception Python nyata)
- `async def` dan `await`
- `export def` dan `export CONSTANT = ...`
- Slicing `xs[1:5]` -> `xs.slice(1, 5)`

---

## 📦 Quickstart

### 1. Scaffold Project Baru
```bash
serpent init my-app
cd my-app
bun install
bun run dev
```

### 2. Kompilasi Manual CLI
```bash
# Kompilasi React component ke stdout atau file
serpent App.hsx -o App.tsx

# Kompilasi Node script
serpent script.hx -o script.mjs
node script.mjs
```

### 3. Ekstensi VS Code
Ekstensi resmi sudah tersedia di `editors/vscode/serpent-hsx-0.1.0.vsix`:
- Syntax highlighting lengkap untuk `.hsx` dan `.hx`
- Validasi diagnostik real-time langsung dari native binary
- Konfigurasi auto-indentasi dan bracket closing

---

## 📐 Arsitektur Sistem

```
.hsx / .hx (Pythonic source)
        │
        ▼  [~1.2ms compile time]
Standalone Native Rust Compiler (603KB binary)
        │
   ┌────┴────────────────────────┐
   ▼                             ▼
Target: React TSX             Target: Plain JS
(Components, JSX, cx)         (Functions, Node ESM, While, Try)
   │                             │
   ▼                             ▼
Vite + React 18               Node.js runtime
(Browser DOM)                 (Zero runtime overhead)
```

- **Zero Client Overhead**: Tidak ada interpreter Python di browser atau runtime.
- **Source Map v3 Lengkap**: Error stack trace browser dan breakpoint debugger langsung menunjuk ke file asli `.hsx`.
- **100% Rust Native**: Dibangun dengan Rust murni, zero runtime dependencies.

---

## 🧪 Testing & Kualitas

```bash
# 1. Rust test suite (217 tests: unit + integration)
cd compiler-rs && cargo test

# 2. Reference & Parity test suite (100% match)
python3 test_compiler.py
python3 parity.py

# 3. Runtime JS test suite
node --test runtime-js/
```

---

## 📄 Lisensi

MIT License © 2026.
