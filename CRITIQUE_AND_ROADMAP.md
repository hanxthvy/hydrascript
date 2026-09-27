<!-- [xihanzu-NR] -->
# Serpent / HydraScript: In-Depth Engineering Critique & Architectural Roadmap

> **Author**: Senior Systems & Compiler Engineer Review  
> **Target Project**: `/root/projects/serpent` (Rust Compiler + Vite Plugin + Runtime)  
> **Status**: Production Audit & Compiler Edge-Case Analysis  

---

## 1. Executive Summary

HydraScript/Serpent adalah eksperimen yang sangat berani dan impresif, terutama dibangun di atas Rust oleh developer muda (17 tahun). Pendekatannya mengambil inspirasi dari sintaks Python yang bersih dan mentranspilasikannya langsung ke React TSX / ES Modules modern tanpa overhead runtime virtual machine (zero-runtime overhead). Cold compile di angka **~1-3ms** membuktikan fondasi performa Rust bekerja sangat baik.

Namun, pengujian intensif dalam membangun aplikasi web modern yang kompleks mengungkap bahwa **compiler saat ini masih bekerja sebagai AST-to-text syntax replacer murni, bukan compiler dengan semantic analysis.** 

Ketiadaan **Symbol Table** dan **Scope/Mutability Analysis** menyebabkan compiler menghasilkan kode JavaScript yang valid secara sintaksis tetapi melempar fatal runtime exceptions di browser (`TypeError: Assignment to constant variable`, `TypeError: Class constructor cannot be invoked without 'new'`, event parameter shadowing, dsb.).

Dokumen ini membedah akar masalah teknis di dalam codebase Rust (`compiler-rs/src/`), memberikan bukti kode, dan menyusun roadmap perbaikan konkret.

---

## 2. Bedah Akar Masalah Kritis (Critical Flaws & Edge Cases)

### 2.1 Flaw 1: Identifiers Kapital Dianggap Tag JSX (Capitalization Heuristic Collapse)
* **File Terkait**: `compiler-rs/src/emitter.rs:134-151` (`is_element`)
* **Kode Sumber Masalah**:
  ```rust
  pub fn is_element(n: &Node) -> bool {
      match &n.kind {
          Kind::Name(id) => {
              HTML_TAGS.contains(&id.as_str()) || id.chars().next().map_or(false, |c| c.is_uppercase())
          }
          Kind::Attr { obj, name } => {
              match &obj.kind {
                  Kind::Name(id) => {
                      id.chars().next().map_or(false, |c| c.is_uppercase())
                          || name.chars().next().map_or(false, |c| c.is_uppercase())
                          || id == "motion"
                  }
                  _ => name.chars().next().map_or(false, |c| c.is_uppercase()),
              }
          }
          _ => false,
      }
  }
  ```
* **Dampak Runtime**:
  - `Math.cos(angle)` dikompilasi menjadi `<Math.cos>{angle}</Math.cos>`.
  - `Date.now()` dikompilasi menjadi `<Date.now />`.
  - `Array.isArray(x)` dikompilasi menjadi `<Array.isArray>{x}</Array.isArray>`.
  - `ResizeObserver(cb)` dikompilasi menjadi `<ResizeObserver>{cb}</ResizeObserver>`.
  React langsung crash saat runtime karena menganggap object Math/Date bawaan browser sebagai komponen React. Developer terpaksa membuang seluruh kalkulasi matematika ke file `.hs` terpisah.
* **Solusi Arsitektural**:
  Buat built-in JS globals whitelist yang **tidak boleh** dianggap sebagai element meskipun berawalan huruf kapital:
  ```rust
  const JS_BUILTIN_GLOBALS: &[&str] = &[
      "Math", "Date", "Array", "Object", "Number", "String", "Boolean",
      "RegExp", "JSON", "Promise", "Reflect", "Intl", "Set", "Map",
      "WeakSet", "WeakMap", "Symbol", "Error", "TypeError", "RangeError",
      "ResizeObserver", "IntersectionObserver", "MutationObserver",
      "WebSocket", "Worker", "Audio", "Image", "FormData", "URL", "URLSearchParams"
  ];
  ```
  Di `is_element`, jika `id` berada di `JS_BUILTIN_GLOBALS`, return `false`.

---

### 2.2 Flaw 2: Seluruh Assignment Di-Emit sebagai `const` (Zero Mutability Awareness)
* **File Terkait**: `compiler-rs/src/emitter.rs:611`
* **Kode Sumber Masalah**:
  ```rust
  Kind::Assign { target, value } => {
      let lhs = self.target_js(target)?;
      let rhs = self.js(value)?;
      self.w(&format!("const {} = {};", lhs, rhs));
  }
  ```
* **Dampak Runtime**:
  Setiap assignment Python selalu menjadi `const`. Jika developer menulis kode natural:
  ```python
  i = 0
  for x in items:
      i += 1
  ```
  Atau re-assign timer:
  ```python
  timeout = None
  if cond:
      timeout = setTimeout(...)
  ```
  Kode JavaScript yang dihasilkan adalah:
  ```js
  const i = 0;
  for (const x of items) {
      i += 1; // CRASH! TypeError: Assignment to constant variable.
  }
  ```
  Hal ini merusak logika dasar imperatif loop dan state lokal di dalam komponen. Developer terpaksa membungkus variabel ke dalam object mutasi `{ id: null }` atau `Object.assign()`.
* **Solusi Arsitektural**:
  Implementasikan **pass analisis scope** sebelum emit. Jika sebuah identifier di-assign lebih dari sekali atau menjadi target operator augmentasi (`+=`, `-=`, dsb.), tandai sebagai mutable dan emit `let`, bukan `const`.

---

### 2.3 Flaw 3: Event Handler Parameter Shadowing pada Lambda Default Arguments
* **File Terkait**: `compiler-rs/src/emitter.rs:231-245`
* **Kode Sumber Masalah**:
  ```rust
  // `lambda m=mode: ...` -> `((m = mode) => ...)`. JS default
  // parameters have exactly Python's early-binding semantics...
  ```
* **Dampak Runtime**:
  Asumsi bahwa default parameter JavaScript memiliki semantik yang sama dengan Python adalah keliru jika diterapkan pada event handler React:
  - Di Python: `lambda it=item: select(it)` membekukan nilai `item` ke default argumen.
  - Di React / JS: `onClick=((it = item) => select(it))` dijalankan oleh React dengan memanggil `fn(syntheticEvent)`.
  - Di JS, argumen default **hanya dievaluasi jika argumen yang dioper bernilai `undefined`**. Karena React selalu mengoper object event, nilai default `item` **dibuang** dan variabel `it` diisi oleh `SyntheticBaseEvent`.
  - Akibatnya: `select(it)` menerima object event, bukan data item! Mengakses `it['title']` menghasilkan `undefined`.
* **Solusi Arsitektural**:
  Untuk lambda yang menggunakan default capture argumen yang dipasang pada event handler, compiler harus menghasilkan IIFE closure atau explicit argument ignoring:
  ```js
  // Daripada:
  ((it = item) => set_selected(it))
  // Hasilkan closure aman:
  ((..._args) => set_selected(item))
  // Atau jika nama parameter diabaikan:
  ((_e) => set_selected(item))
  ```

---

### 2.4 Flaw 4: Ketiadaan Keyword `new` untuk Class Constructor JavaScript
* **File Terkait**: `compiler-rs/src/lexer.rs` & `parser.rs`
* **Masalah**:
  Python menginstansiasi class seperti memanggil fungsi biasa: `car = Car()`. Sedangkan JavaScript ES6+ mewajibkan pemanggilan class constructor menggunakan operator `new`.
  Jika developer menulis:
  ```python
  ro = ResizeObserver(callback)
  ```
  JavaScript modern akan langsung melempar:
  `TypeError: Class constructor ResizeObserver cannot be invoked without 'new'`.
* **Solusi Arsitektural**:
  Dukung pemanggilan instansiasi:
  1. Entah dengan menambahkan keyword `new` di lexer/parser: `new ResizeObserver(callback)`.
  2. Atau fungsi bawaan compiler: `new(ResizeObserver, callback)` yang mentranspilasi ke `new ResizeObserver(callback)`.

---

### 2.5 Flaw 5: Sintaks `return` Wajib Membawa Ekspresi (Disallowing Bare `return`)
* **File Terkait**: `compiler-rs/src/parser.rs:157-160`
* **Kode Sumber Masalah**:
  ```rust
  TokType::Kw("return") => {
      self.i += 1;
      return Ok(Node::new(Kind::Return(Box::new(self.expr()?)), t.line, t.col));
  }
  ```
* **Dampak**:
  Di Python dan JavaScript, menulis `return` saja (early exit tanpa mengembalikan nilai) adalah hal yang sangat lumrah. Di Serpent, menulis `return` saja memicu parser error:
  `unexpected Newline ("\n") — expected an expression`. Developer terpaksa menulis `return None` di setiap early exit `useEffect` atau callback.
* **Solusi**:
  Jadikan ekspresi setelah `return` bersifat opsional:
  ```rust
  TokType::Kw("return") => {
      self.i += 1;
      let expr = if self.check(TokType::Newline) || self.check(TokType::Dedent) {
          Node::new(Kind::None, t.line, t.col)
      } else {
          self.expr()?
      };
      return Ok(Node::new(Kind::Return(Box::new(expr)), t.line, t.col));
  }
  ```

---

### 2.6 Flaw 6: Keyword Tabrakan pada HTML Props (`type`, `as`, `for`)
* **File Terkait**: `compiler-rs/src/parser.rs:100-140`
* **Masalah**:
  Elemen HTML sering memerlukan atribut standar seperti `<button type="button">`, `<input type="text">`, atau `<label for="id">`.
  Di Serpent, `button(type="button")` langsung ditolak compiler karena `type` dianggap token keyword reserved.
* **Solusi**:
  Dalam konteks pemanggilan argumen / call props: token nama atribut harus menerima `Ident` **maupun** `Kw(...)` sebagai key string.

---

### 2.7 Flaw 7: Virtual Module Runtime Resolution di Vite Plugin
* **File Terkait**: `vite-plugin/index.js` & `runtime-js/`
* **Masalah**:
  Ketika compiler menghasilkan `import { range } from 'serpent-js';`, Vite gagal melakukan bundling karena package `serpent-js` tidak terpasang di `node_modules`.
* **Solusi**:
  Vite plugin (`vite-plugin-hydrascript`) harus menginjeksi virtual module:
  ```js
  resolveId(id) {
    if (id === 'serpent-js') return '\0virtual:serpent-js';
  },
  load(id) {
    if (id === '\0virtual:serpent-js') {
      return readFileSync(path.resolve(HERE, '../runtime-js/serpent-js.js'), 'utf-8');
    }
  }
  ```

---

## 3. Desain Komponen & Integrasi Design System (`/ecc:design-system`)

Untuk membuat Serpent / HydraScript siap dipakai di proyek skala besar dan design system:

### 3.1 Ergonomi Slot & Children
Saat ini passing children dilakukan via blok indentasi:
```serpent
TiltCard():
    div(): "Content"
```
Ini bekerja baik untuk single children. Namun design system sering membutuhkan **Multiple Named Slots** (misal: `Card(header=..., body=..., footer=...)`).
Saat ini developer harus mengoper fungsi atau JSX inline dalam atribut dictionary yang rentan error parser.
* **Usulan**: Tambahkan sintaks slot block berbasis decorator atau named blocks:
```serpent
Modal():
    @slot(header):
        h3(): "Title"
    @slot(body):
        p(): "Body text"
```

### 3.2 Dynamic Class Merging (Tailwind Integration)
Komponen UI sering butuh conditional classes:
```serpent
div(className=f"p-4 {className} {'active' if is_active else ''}")
```
String interpolation f-string bekerja, tetapi jika ada conflict class Tailwind (`p-4` ditimpa `p-6`), tidak ada auto-merge. Menyediakan utility `cn()` atau `clsx()` bawaan di runtime akan sangat membantu.

---

## 4. Roadmap Pengembangan Strategis

```
[Phase 1: Stabilization & Bug Fixes] (Target: v0.2.0)
 ├── Fix is_element: Tambahkan JS_BUILTIN_GLOBALS whitelist.
 ├── Bare return: Izinkan `return` tanpa ekspresi.
 ├── Keyword kwargs: Izinkan `type`, `for`, `as` sebagai keyword arguments.
 └── Vite Plugin: Auto-resolve virtual module untuk `serpent-js`.

[Phase 2: Semantic & Mutability Analysis] (Target: v0.3.0)
 ├── Scope analysis pass di Rust AST.
 ├── Deteksi re-assignment -> emit `let` vs `const`.
 ├── Operator `new` support: `new Cls(...)` atau `new(Cls, ...)`.
 └── Event handler lambda capture fix (mencegah SyntheticEvent overwrite).

[Phase 3: DX & Tooling] (Target: v0.4.0)
 ├── LSP (Language Server Protocol) server berbasis tower-lsp.
 ├── VSCode extension (Tree-sitter grammar untuk syntax highlighting).
 └── CLI watch mode dengan incremental compilation berbasis inotify.
```

---

## 5. Kesimpulan Penilai

Serpent / HydraScript memiliki nilai artistik dan teknis yang tinggi. Keberanian menciptakan sintaks Pythonic untuk ekosistem React adalah ide yang menyegarkan di tengah kejenuhan JSX/TSX. Dengan memperbaiki 5 bug parser kritis di atas (terutama whitelist built-in globals dan analisis mutabilitas `const`/`let`), framework ini akan bertransformasi dari sekadar "proyek eksperimen seru" menjadi **production-ready toolchain yang stabil dan menyenangkan untuk dipakai sehari-hari.**
