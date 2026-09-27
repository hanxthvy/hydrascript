<!-- [xihanzu-NR] -->
# HYDRA: BLUEPRINT ARSITEKTUR META-FRAMEWORK TINGKAT PRODUKSI
## PRODUCTION-GRADE SPECIFICATION (v1.0 ARSITEKTUR)

---

### 1. VISI & POSISI ARSITEKTUR

#### 1.1 Premis Inti
Web ecosystem terpolarisasi antara:
1. **Next.js**: Fitur full-stack matang, ekosistem React masif, namun kompleksitas abstraksi server/client boundaries (RSC), cold start dev server lambat, dan coupling ketat terhadap runtime Vercel.
2. **Astro**: Islands architecture superior untuk content-driven web, baseline JavaScript 0 KB, namun format file `.astro` memiliki keterbatasan reusability komponen reaktif murni antar ekosistem.
3. **Python Ecosystem**: Keterbacaan sintaks terbaik di dunia perangkat lunak, namun tidak memiliki representasi native performan di client-side rendering browser.

Hydra memadukan tiga pilar ini menjadi meta-framework terpadu:
* **Pythonic Authoring Syntax (`.hs` / `.hsx`)**: Menghilangkan boilerplate JSX (kurung kurawal ganda, closing tags repetitif, nested ternary expression) menjadi indentation-based syntax yang bersih.
* **Rust Native Engine (`hydra-core`)**: Lexer, parser, semantic analyzer, optimizer, dan compiler berbasis Rust dengan latensi kompilasi sub-milidetik (~0.5ms per file), beroperasi in-memory melalui Node-API tanpa overhead IPC child process.
* **Universal React & Web Standards Compatibility**: Output kompilasi berupa valid TypeScript/JSX standar (ES Modules) yang terintegrasi langsung dengan ekosistem React 18/19, Vite, Rollup, Tailwind CSS, Web Streams API, dan server runtimes modern.

```
+-------------------------------------------------------------------+
|               HYDRA DEVELOPER EXPERIENCE LAYER                     |
|    .hs (Logic/Modules)   |   .hsx (Components/Pages/Layouts)      |
+-------------------------------------------------------------------+
                                  |
                                  v
+-------------------------------------------------------------------+
|               RUST COMPILER ENGINE (hydra-core)                   |
|  Lexer -> Parser -> Semantic Pass (Scopes/Types) -> TSX Emitter   |
|               Latency: ~0.5ms - In-Memory Node-API                |
+-------------------------------------------------------------------+
                                  |
                                  v
+-------------------------------------------------------------------+
|                 HYDRA BUNDLER & RUNTIME ORCHESTRATION             |
|   Vite / Rolldown Core  |  Islands Hydration  |  File-Based Router |
+-------------------------------------------------------------------+
                                  |
        +-------------------------+-------------------------+
        v                         v                         v
+---------------+         +---------------+         +---------------+
| Static (SSG)  |         | Node/Bun SSR  |         | Cloudflare/Edge|
+---------------+         +---------------+         +---------------+
```

---

### 2. ARSITEKTUR CLI & ZERO-CONFIG

#### 2.1 Arsitektur Binary & Orchestration
CLI Hydra diimplementasikan sebagai hybrid binary:
1. Global launcher: `hydra` (Node CLI wrapper yang mengikat binary native Rust via `@hydra/cli`).
2. Bundler core: Embedded Vite runner dengan konfigurasi otomatis internal. Developer tidak diwajibkan membuat `vite.config.ts` manual.

Perintah CLI inti:
* `hydra dev`: Menjalankan development server lokal dengan HMR sub-milidetik, error overlay kustom, dan port dynamic detection (default `3000`).
* `hydra build`: Menjalankan two-pass production build:
  1. *Pass 1 (Server/Static Manifest)*: SSR bundle generation untuk seluruh route dan islands marker analysis.
  2. *Pass 2 (Client Assets)*: Code splitting, tree-shaking, hash minification, dan assets bundling.
* `hydra preview`: Menjalankan lightweight production runtime preview lokal yang membaca adapter output (`dist/`).

#### 2.2 Skema Lengkap `hydraconfig.json` (JSON Schema Specification)

```json
{
  "$schema": "https://hydra.dev/schemas/v1/config.json",
  "name": "hydra-production-app",
  "version": "1.0.0",
  "root": "./src",
  "outputDir": "./dist",
  "compiler": {
    "target": "es2022",
    "jsxRuntime": "automatic",
    "strictMutability": true,
    "sourceMaps": true,
    "builtinsWhitelist": [
      "Math", "Date", "Array", "Object", "JSON", "Promise", 
      "RegExp", "Map", "Set", "ResizeObserver", "IntersectionObserver"
    ]
  },
  "router": {
    "routesDir": "./src/routes",
    "basePath": "/",
    "trailingSlash": "never"
  },
  "rendering": {
    "mode": "hybrid",
    "defaultHydration": "server-only",
    "streaming": true
  },
  "server": {
    "port": 3000,
    "host": "0.0.0.0",
    "cors": true,
    "compression": true
  },
  "adapter": {
    "name": "@hydra/adapter-node",
    "options": {
      "outDir": "./dist/server",
      "precompress": true
    }
  },
  "vite": {
    "plugins": [],
    "resolve": {
      "alias": {
        "@": "./src"
      }
    }
  }
}
```

---

### 3. RENDERING ENGINE: ISLANDS ARCHITECTURE & HYDRATION

#### 3.1 Masalah Monolithic SPA/SSR
Next.js tradisional mengirimkan seluruh bundle JavaScript komponen ke client untuk proses hydration penuh, bahkan untuk elemen statis seperti header navigasi, footer, dan artikel teks. Hal ini membebani Time to Interactive (TTI) dan Total Blocking Time (TBT).

#### 3.2 Model Arsitektur Hydra: Islands-First dengan Native React Primitives
Hydra mengadopsi model **Zero JS by default** layaknya Astro, namun komponen interaktif ditulis langsung menggunakan sintaks Pythonic `.hsx` yang dikompilasi menjadi React client components.

Directive Komponen (Islands Contract):
* `client:load`: Diunduh dan dihidrasi segera saat initial page load (skenario: Navigation Drawer, Critical Cart Dropdown).
* `client:idle`: Dihidrasi ketika browser mencapai kondisi `requestIdleCallback` (skenario: Search Bar, Analytics Tracker).
* `client:visible`: Dihidrasi hanya ketika elemen memasuki viewport menggunakan `IntersectionObserver` (skenario: Interactive Charts, Comments Section).
* `client:media="(max-width: 768px)"`: Dihidrasi kondisional berdasarkan media query query match (skenario: Mobile Menu).
* `client:only`: Tidak dirender pada server-side sama sekali. Langsung dirender di client-side (skenario: WebGL Canvas, Camera Scanner, LocalStorage Dependent Widget).

#### 3.3 Representasi Sintaks `.hsx` untuk Islands

```python
# [xihanzu-NR]
# File: src/routes/dashboard/+page.hsx
component Page(props):
    # Static content: Zero Client JavaScript emitted
    div(className="layout-container"):
        header(className="hero-header"):
            h1: "Sistem Analitik Produksi"
            p: "Halaman ini dirender 100% statis dari server."

        # Interactive Island: Client bundle di-code split terpisah
        div(className="interactive-grid"):
            AnalyticsChart(
                data=props.metrics, 
                client:visible=True
            )
            
            RealtimeTicker(
                interval=1000, 
                client:load=True
            )
```

#### 3.4 Runtime Wrapper Hydration Emitter

Compiler mentranspilasikan pemanggilan komponen ber-directive menjadi client wrapper:

```tsx
// [xihanzu-NR]
// Output TSX transpilasi otomatis oleh hydra-core
import React from "react";
import { HydraIsland } from "@hydra/runtime/island";

export default function Page({ metrics }) {
  return (
    <div className="layout-container">
      <header className="hero-header">
        <h1>Sistem Analitik Produksi</h1>
        <p>Halaman ini dirender 100% statis dari server.</p>
      </header>
      <div className="interactive-grid">
        <HydraIsland
          component={() => import("@/components/AnalyticsChart")}
          strategy="visible"
          props={{ data: metrics }}
        />
        <HydraIsland
          component={() => import("@/components/RealtimeTicker")}
          strategy="load"
          props={{ interval: 1000 }}
        />
      </div>
    </div>
  );
}
```

---

### 4. SISTEM ROUTING & LAYOUT FILE-BASED

#### 4.1 Topologi Direktori `src/routes`
Hydra menggunakan konvensi penamaan berbasis explicit contract (mengadopsi paradigma SvelteKit):
* `+page.hsx`: Representasi UI halaman pada segmen URL tersebut.
* `+layout.hsx`: Layout pembungkus hierarkis rekursif untuk segmen dan children di bawahnya.
* `+server.hs`: Endpoint API backend murni (GET, POST, PUT, DELETE, PATCH).
* `+error.hsx`: Boundary penanganan exception HTTP / runtime error per level route.
* `+loading.hsx`: Streaming fallback UI (React Suspense skeleton).

Struktur direktori:
```
src/routes/
├── +layout.hsx                   # Root Shell (HTML, Head, Global Nav)
├── +error.hsx                    # Root 404 / 500 error boundary
├── +page.hsx                     # Route: /
├── api/
│   └── telemetry/
│       └── +server.hs            # Endpoint: /api/telemetry
├── auth/
│   ├── login/
│   │   └── +page.hsx             # Route: /auth/login
│   └── +layout.hsx               # Layout khusus grup auth
└── products/
    ├── +layout.hsx
    ├── +page.hsx                 # Route: /products (Katalog)
    └── [id]/
        ├── +page.hsx             # Route: /products/123 (Dynamic Route)
        └── +server.hs            # API handler spesifik id
```

#### 4.2 Data Fetching & Server Loaders (`load`)
Setiap `+page.hsx` dapat mengekspos fungsi `load` server-side untuk fetching data sebelum rendering:

```python
# [xihanzu-NR]
# File: src/routes/products/[id]/+page.hsx
from hydra.server import RequestEvent, error

def load(event: RequestEvent):
    product_id = event.params.id
    data = db.query("SELECT * FROM products WHERE id = ?", product_id)
    if not data:
        raise error(404, "Produk tidak ditemukan")
    return {
        "product": data
    }

component Page(data):
    div(className="product-detail"):
        h1: data.product.name
        span(className="price"): f"Rp {data.product.price:,}"
        button(className="btn-buy"): "Beli Sekarang"
```

---

### 5. PIPELINE KOMPILER RUST v0.3 - v1.0

#### 5.1 Transformasi Pipeline dari v0.2 ke v1.0
* **Status v0.2**: Parser mentah AST-to-text replacer. Tidak memiliki symbol table, seluruh assignment diekstrak menjadi `const`, dan global identifier JavaScript (misal `Math`, `Date`) dikira tag JSX.
* **Arsitektur v1.0**: Pipeline multi-stage compiler dengan Semantic Scope Pass, Symbol Resolution, dan Node-API In-Memory binding.

```
+---------------+      +----------------+      +-------------------+
| Source (.hsx) | ---> | Token Stream   | ---> | Untyped AST       |
|               |      | (Indent/Dedent)|      | (Syntax Node)     |
+---------------+      +----------------+      +-------------------+
                                                         |
                                                         v
+---------------+      +----------------+      +-------------------+
| JavaScript /  | <--- | Optimized AST  | <--- | Semantic Analyzer |
| TSX Output    |      | (Target Trees) |      | (Scope, Mutability|
+---------------+      +----------------+      |  Globals, Islands)|
                                               +-------------------+
```

#### 5.2 Rust Structs: AST, Scope Tree, & Symbol Table

```rust
// [xihanzu-NR]
// File: compiler-rs/src/ast.rs
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, PartialEq)]
pub enum Lit {
    Str(String),
    Num(f64),
    Bool(bool),
    None,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Directive {
    ClientLoad,
    ClientIdle,
    ClientVisible,
    ClientOnly,
    ClientMedia(String),
}

#[derive(Debug, Clone)]
pub struct Scope {
    pub parent: Option<usize>,
    pub bindings: HashMap<String, BindingInfo>,
}

#[derive(Debug, Clone)]
pub struct BindingInfo {
    pub is_mutable: bool,
    pub assignment_count: usize,
    pub is_parameter: bool,
}

#[derive(Debug, Clone)]
pub struct SymbolTable {
    pub scopes: Vec<Scope>,
    pub current_scope: usize,
    pub globals_whitelist: HashSet<&'static str>,
}

impl SymbolTable {
    pub fn new() -> Self {
        let mut globals = HashSet::new();
        globals.extend([
            "Math", "Date", "Array", "Object", "Number", "String", "Boolean",
            "RegExp", "JSON", "Promise", "Reflect", "Intl", "Set", "Map",
            "WeakSet", "WeakMap", "Symbol", "Error", "TypeError", "RangeError",
            "ResizeObserver", "IntersectionObserver", "MutationObserver",
            "WebSocket", "Worker", "Audio", "Image", "FormData", "URL", "URLSearchParams"
        ]);

        let root = Scope {
            parent: None,
            bindings: HashMap::new(),
        };

        Self {
            scopes: vec![root],
            current_scope: 0,
            globals_whitelist: globals,
        }
    }

    pub fn enter_scope(&mut self) -> usize {
        let new_idx = self.scopes.len();
        self.scopes.push(Scope {
            parent: Some(self.current_scope),
            bindings: HashMap::new(),
        });
        self.current_scope = new_idx;
        new_idx
    }

    pub fn exit_scope(&mut self) {
        if let Some(parent) = self.scopes[self.current_scope].parent {
            self.current_scope = parent;
        }
    }

    pub fn mark_assigned(&mut self, name: &str) {
        let mut target_scope = Some(self.current_scope);
        while let Some(idx) = target_scope {
            if let Some(b) = self.scopes[idx].bindings.get_mut(name) {
                b.assignment_count += 1;
                b.is_mutable = true;
                return;
            }
            target_scope = self.scopes[idx].parent;
        }

        // Deklarasi baru di scope lokal
        self.scopes[self.current_scope].bindings.insert(
            name.to_string(),
            BindingInfo {
                is_mutable: false,
                assignment_count: 1,
                is_parameter: false,
            },
        );
    }
}
```

#### 5.3 Semantic Scope Analysis & Correct TSX Emitter

```rust
// [xihanzu-NR]
// File: compiler-rs/src/emitter.rs
use crate::ast::{Node, Kind, SymbolTable};

pub struct Emitter<'a> {
    pub symbols: &'a SymbolTable,
    pub output: String,
    pub indent_level: usize,
}

impl<'a> Emitter<'a> {
    pub fn is_jsx_element(&self, name: &str) -> bool {
        if self.symbols.globals_whitelist.contains(name) {
            return false;
        }
        name.chars().next().map_or(false, |c| c.is_uppercase()) || HTML_TAGS.contains(&name)
    }

    pub fn emit_assign(&mut self, target: &str, value_js: &str) {
        let is_mutable = self.symbols.scopes[self.symbols.current_scope]
            .bindings
            .get(target)
            .map_or(false, |b| b.is_mutable);

        let keyword = if is_mutable { "let" } else { "const" };
        self.output.push_str(&format!("{}{} {} = {};\n", " ".repeat(self.indent_level * 4), keyword, target, value_js));
    }
}
```

#### 5.4 Node-API (NAPI-RS) In-Memory Zero-Copy Bridge

```rust
// [xihanzu-NR]
// File: compiler-rs/src/napi.rs
use napi_derive::napi;
use napi::{Result, JsObject, Env};
use crate::compiler::compile_source;

#[napi(object)]
pub struct CompileResult {
    pub code: String,
    pub map: Option<String>,
    pub error: Option<String>,
}

#[napi]
pub fn compile_hydra_sync(source: String, filename: String) -> CompileResult {
    match compile_source(&source, &filename) {
        Ok(transpiled) => CompileResult {
            code: transpiled.code,
            map: transpiled.source_map,
            error: None,
        },
        Err(err) => CompileResult {
            code: String::new(),
            map: None,
            error: Some(err.to_string()),
        },
    }
}
```

---

### 6. TOOLING & DX ECOSYSTEM

#### 6.1 Tree-sitter Grammar (`tree-sitter-hydra`)
High-performance incremental parsing untuk editor real-time highlighting.
Struktur grammar menangani `INDENT` dan `DEDENT` melalui custom external scanner di C/Rust:

```javascript
// [xihanzu-NR]
// grammar.js (Ringkasan Core Rules)
module.exports = grammar({
  name: 'hydra',
  externals: $ => [
    $._indent,
    $._dedent,
    $._newline
  ],
  rules: {
    source_file: $ => repeat($._statement),
    _statement: $ => choice(
      $.component_def,
      $.element_statement,
      $.assignment,
      $.function_def,
      $.import_statement
    ),
    component_def: $ => seq(
      'component',
      field('name', $.identifier),
      field('parameters', $.parameter_list),
      ':',
      $._indent,
      repeat($._statement),
      $._dedent
    ),
    element_statement: $ => seq(
      field('tag', $.identifier),
      optional(field('attributes', $.argument_list)),
      ':',
      choice(
        $._statement,
        seq($._indent, repeat($._statement), $._dedent),
        $.string
      )
    )
  }
});
```

#### 6.2 Hydra Language Server (LSP)
Dibangun menggunakan Rust `tower-lsp` dengan kemampuan:
1. **Diagnostics**: Validasi indentasi, missing arguments, dan scope mutability warning langsung di file `.hsx`.
2. **Go to Definition**: Resolusi symbol antar file `.hs` dan `.hsx`.
3. **Hover Documentation**: Menampilkan inferensi tipe props komponen dan tipe return function.
4. **Auto-complete**: Melengkapi atribut HTML standar, Tailwind CSS classes, dan React hook dependencies.

#### 6.3 Auto-Formatter (`hydra fmt`)
CLI engine berbasis Rust yang memaksakan standardisasi kode:
* Menormalkan indentasi ke 4 spaces konsisten.
* Mengurutkan import: System modules -> Third-party packages -> Internal modules (`@/`).
* Merapikan parameter list yang melebihi batas 80 karakter menjadi multi-line.

---

### 7. ADAPTER DEPLOYMENT PRODUKSI

Hydra memisahkan build output ke format abstrak, kemudian mengikatnya ke target runtime via adapter.

```
       [ hydra build ]
              |
              v
     .hydra/manifest.json
   + Client Assets (.hydra/client)
   + SSR Chunks (.hydra/server)
              |
     +--------+--------+---------------+
     v                 v               v
Adapter-Node      Adapter-Bun    Adapter-Cloudflare
```

#### 7.1 Static Adapter (`@hydra/adapter-static`)
Untuk deployment SSG (GitHub Pages, Vercel Static, S3/CloudFront, Netlify).
* Prerender crawler mengeksekusi semua route statis saat build-time.
* Menghasilkan direktori `dist/` berisi file `.html` statis, zero server dependencies.

#### 7.2 Node Adapter (`@hydra/adapter-node`)
Untuk deployment container enterprise (Docker, Kubernetes, AWS ECS, VPS):
* Server HTTP berbasis Express/Fastify atau raw Node `http.createServer`.
* Built-in support untuk Gzip/Brotli static assets serving dengan HTTP caching headers (`max-age=31536000, immutable`).
* Clustering support native via Node.js cluster API.

```javascript
// [xihanzu-NR]
// Standalone entrypoint yang di-generate oleh @hydra/adapter-node
import { createServer } from "node:http";
import { handler } from "./server/entry.js";

const server = createServer((req, res) => {
  handler(req, res);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Hydra Production Server running on port ${PORT}`);
});
```

#### 7.3 Bun Adapter (`@hydra/adapter-bun`)
Memanfaatkan `Bun.serve` untuk throughput I/O maksimum:
* Direct Web Request/Response standard streaming.
* Zero-copy routing.

```typescript
// [xihanzu-NR]
// Entrypoint @hydra/adapter-bun
import { renderToStream } from "./server/entry.js";

export default {
  port: process.env.PORT || 3000,
  async fetch(req: Request) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/_hydra/")) {
      return new Response(Bun.file(`./client${url.pathname}`));
    }
    return await renderToStream(req);
  }
};
```

#### 7.4 Cloudflare Edge Adapter (`@hydra/adapter-cloudflare`)
Untuk edge rendering global:
* Kompatibel dengan Cloudflare Workers dan Pages Functions.
* Menghubungkan Cloudflare KV, D1 Database, dan Hyperdrive langsung ke dalam event loader context.

---

### 8. ROADMAP EKSEKUSI BERTAHAP MENUJU v1.0 PRODUKSI

#### Fase 1: Hardening Compiler Rust & Zero-Config CLI (Target: Milestone v0.3)
1. **Refactor Emitter & Semantic Scope Pass**:
   - Implementasi `SymbolTable` dan `ScopeTree` di `compiler-rs/src/emitter.rs`.
   - Menambahkan whitelist JS builtins (`Math`, `Date`, `Array`, dsb.) untuk mencegah invalid JSX transformation.
   - Analisis reassignment untuk meng-emit `let` vs `const` secara tepat.
2. **Migrasi ke In-Memory Node-API Native Addon**:
   - Menghapus pemanggilan sinkronous CLI child process (`execFileSync`).
   - Menyediakan pre-built binary NAPI (`hydra.node`) untuk platform Linux x64/arm64, macOS, dan Windows.
3. **Zero-Config CLI**:
   - Pembuatan paket `@hydra/cli` dengan perintah `hydra dev`, `hydra build`, dan `hydra preview`.
   - Integrasi embedded Vite middleware.

#### Fase 2: File-Based Routing & Islands Hydration Runtime (Target: Milestone v0.6)
1. **File-Based Router Engine**:
   - Dynamic scanner untuk konvensi `src/routes/**/+page.hsx`, `+layout.hsx`, dan `+server.hs`.
   - Nested route layout tree resolution dan path normalization.
2. **Islands Runtime & Code Splitting**:
   - Transpilasi directive `client:load`, `client:idle`, `client:visible`.
   - Pembuatan runtime loader package `@hydra/runtime` dengan IntersectionObserver support.
3. **Data Fetching Pipeline**:
   - Eksekusi `load(event)` lifecycle di server sebelum komponen dirender.
   - Serialisasi state server-ke-client yang aman (mencegah XSS injection).

#### Fase 3: Tooling, Production Adapters, & Standarisasi LSP (Target: Milestone v1.0 GA)
1. **Hydra LSP & Editor Integration**:
   - Finalisasi Rust binary `hydra-lsp` berbasis `tower-lsp`.
   - Publikasi extension resmi VS Code dengan semantic highlighting dan diagnostic reporting.
2. **Suite Adapter Deployment**:
   - `@hydra/adapter-static`
   - `@hydra/adapter-node`
   - `@hydra/adapter-bun`
   - `@hydra/adapter-cloudflare`
3. **Benchmarking & Compliance Suite**:
   - Parity test suite memvalidasi 500+ edge-case sintaks `.hsx` terhadap React output.
   - Core Web Vitals audit: Memastikan template starter menghasilkan skor Lighthouse 100/100 pada Performance, Accessibility, dan Best Practices.