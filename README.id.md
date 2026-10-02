<!-- [xihanzu-NR] -->
# HydraScript

**Bahasa Pemrograman dan Meta-Framework Pythonic untuk React & Ekosistem Web Modern**  
Kompiler native berbasis Rust, runtime Node-API in-memory bebas IPC, dan meta-framework zero-config tanpa runtime overhead.

[English](README.md) | [Bahasa Indonesia](README.id.md)

---

## Daftar Isi

- [Ringkasan](#ringkasan)
- [Filosofi Desain](#filosofi-desain)
- [Mengapa HydraScript: Masalah Kronis pada Vanilla TSX](#mengapa-hydrascript-masalah-kronis-pada-vanilla-tsx)
- [Matriks Sintaks & Fitur](#matriks-sintaks--fitur)
- [Komparasi Sintaks Berdampingan (Side-by-Side)](#komparasi-sintaks-berdampingan-side-by-side)
  - [1. Deklarasi Komponen Dasar & Auto-Fragment](#1-deklarasi-komponen-dasar--auto-fragment)
  - [2. State Reaktif & Side Effects](#2-state-reaktif--side-effects)
  - [3. Percabangan Multi-Branch & Pattern Matching](#3-percabangan-multi-branch--pattern-matching)
  - [4. Dynamic Classes & Event Modifiers](#4-dynamic-classes--event-modifiers)
  - [5. Iterasi Koleksi & Key Props](#5-iterasi-koleksi--key-props)
  - [6. Entrypoint Aplikasi Browser (`src/main.hyx`)](#6-entrypoint-aplikasi-browser-srcmainhyx)
  - [7. Logika Backend & Slicing (`.hys` vs `.ts`)](#7-logika-backend--slicing-hys-vs-ts)
- [Mode Meta-Framework](#mode-meta-framework)
  - [Perintah CLI](#perintah-cli)
  - [Arsitektur Zero-Config](#arsitektur-zero-config)
  - [Referensi Konfigurasi (`hydraconfig.json`)](#referensi-konfigurasi-hydraconfigjson)
- [Arsitektur Kompiler & Performa](#arsitektur-kompiler--performa)
  - [Alur Pipeline](#alur-pipeline)
  - [Tolok Ukur Latensi Kompilasi](#tolok-ukur-latensi-kompilasi)
- [Referensi Bahasa](#referensi-bahasa)
  - [Deklarasi Komponen](#deklarasi-komponen)
  - [Konvensi Properti dan Event](#konvensi-properti-dan-event)
  - [Hooks & Baterai React](#hooks--baterai-react)
  - [Whitelist Global JavaScript](#whitelist-global-javascript)
  - [Import dan Export Modul](#import-dan-export-modul)
- [Referensi CLI](#referensi-cli)
- [Panduan Deployment Produksi](#panduan-deployment-produksi)
  - [Static Hosting](#static-hosting)
  - [Wadah Docker](#wadah-docker)
- [Dukungan Editor](#dukungan-editor)
- [Kontribusi & Roadmap Arsitektur](#kontribusi--roadmap-arsitektur)
- [Lisensi](#lisensi)

---

## Ringkasan

HydraScript adalah bahasa pemrograman berbasis indentasi dan meta-framework web lengkap yang memadukan kebersihan visual, keringkasan, dan keterbacaan sintaks Python dengan kekuatan ekosistem React dan JavaScript modern.

Proyek ini terdiri dari tiga pilar arsitektur utama:
1. **Kompiler Native (`compiler-rs`)**: Biner mandiri dalam bahasa Rust murni yang mentranspilasikan berkas `.hyx` (warisan: `.hsx`) ke React TypeScript/JSX dan berkas `.hys` (warisan: `.hs`, `.hx`) ke modul ES standar dalam waktu sub-milidetik.
2. **Bridge Node-API In-Memory (`hydra.node`)**: Pustaka dinamis (C-ABI) yang memungkinkan dev server dan bundler memanggil kompiler langsung di memori RAM tanpa overhead spawn proses OS (`fork/exec`).
3. **CLI Meta-Framework Mandiri (`packages/cli`)**: Runner terintegrasi yang membungkus Vite, Tailwind CSS, dan Autoprefixer secara programatik, menghapus kebutuhan berkas `vite.config.ts`, `tailwind.config.ts`, atau `tsconfig.json` di proyek pengguna.

---

## Filosofi Desain

### 1. Nol Beban Runtime (Zero Runtime Tax)
HydraScript tidak menyematkan runtime virtual machine khusus pada browser pengguna. Kode `.hyx` dikompilasi langsung menjadi komponen React 18/19 standar, pemanggilan JSX murni, dan hooks bawaan browser. Tidak ada overhead interpretasi dan tidak ada payload kilobyte tambahan yang dikirim ke browser.

### 2. Eliminasi Boilerplate pada Tingkat Sintaks
JSX mewajibkan pengembang menulis tag penutup berulang, kurung kurawal ganda untuk objek properti, template string rumit untuk nama kelas dinamis, dan rantai ternary operator berjenjang. HydraScript menggantikannya dengan blok indentasi bersih khas Python, f-strings, list comprehensions, kamus (dict) native, dan percabangan tingkat blok.

### 3. Kesederhanaan Ekstrem Rantai Alat (Toolchain Simplicity)
Pengembangan web modern seringkali menuntut 5 hingga 8 berkas konfigurasi sebelum menulis satu baris logika (`tsconfig.json`, `vite.config.ts`, `tailwind.config.ts`, `postcss.config.js`, `eslint.config.js`). HydraScript memangkas seluruh kompleksitas tersebut menjadi satu berkas opsional `hydraconfig.json`.

---

## Mengapa HydraScript: Masalah Kronis pada Vanilla TSX

| Aspek | Vanilla TSX / React | HydraScript (`.hyx` / `.hys`, warisan `.hsx` / `.hs`) |
|---|---|---|
| **Hierarki Elemen** | Wajib tag pembuka & penutup (`<div><header><h1></h1></header></div>`) | Blok hierarki berbasis indentasi (`div: header: h1: ...`) |
| **Percabangan Bersyarat** | Operator ternary bersarang (`a ? <B/> : c ? <D/> : <E/>`) | Pythonic `if / elif / else` langsung di dalam pohon UI |
| **Pattern Matching** | Pola IIFE rumit `(() => { switch(s) { ... } })()` | Native `match / case` langsung di dalam elemen JSX |
| **Kebocoran Angka Nol** | Logika `count && <Badge/>` merender teks `0` di DOM | Pengecekan truthiness boolean ketat otomatis saat kompilasi |
| **Kelas Dinamis** | Wajib pasang dependensi luar (`clsx`, `classnames`) | Sintaks dict native: `cls={"btn": True, "active": is_active}` |
| **Modifier Event** | Pengulangan `e.preventDefault(); e.stopPropagation();` | Modifier deklaratif: `on_submit_prevent_stop=handle_submit` |
| **Iterasi Koleksi** | Wajib `.map((item, idx) => <li key={item.id}>...</li>)` | Loop Pythonic: `for item in items: li(key=item.id): item.name` |
| **Format String** | Template literal backtick: `` `${base}/${id}` `` | F-string bersih standar: `f"{base}/{id}"` |
| **Multi-Root Nodes** | Wajib membungkus manual dengan `<> ... </>` | Penyisipan Fragment otomatis oleh kompiler |
| **Deklarasi State** | Destrukturisasi panjang `const [val, setVal] = useState(0)` | Unpacking tuple bersih: `val, set_val = state(0)` |
| **Global Bawaan JS** | Berisiko bentrok dengan nama tag komponen | Whitelist menjamin `Math.cos()`, `Date.now()` tidak jadi tag JSX |

---

## Generasi Kode AI & Efisiensi Token Empiris

Berdasarkan hasil pengujian tolok ukur (benchmark) empiris antara komponen identik Vanilla TSX dan HydraScript:

1. **Reduksi Token Statis (-12.6%)**: Pada pengujian komponen 1:1, HydraScript memangkas token BPE mentah (`cl100k_base`) sebesar **12.6%** (3.378 vs 3.865 token pada 5 komponen produksi) dan baris kode sebesar **30.6%** (236 vs 340 LOC).
2. **Eliminasi Overhead Sintaksis**: Pada TSX standar, **19.2% dari seluruh token** terbuang murni untuk tag penutup (`</div>`, `</section>`, `</span>`), kurung kurawal (`{}`), dan import statement. Sintaks indentasi HydraScript memangkas overhead struktural ini hingga di bawah 4.8%.
3. **Melenyapkan Halusinasi Tag Penutup**: Kegagalan paling umum dari model AI saat menulis JSX panjang adalah salah memasangkan atau lupa menutup tag (`</div>`). Dengan hierarki indentasi Pythonic, kesalahan penutupan tag hilang 100%.
4. **Validasi Direct-to-Disk (1st-Pass 100%)**: Pada alur kerja langsung tanpa coba-coba di `/tmp`, model AI mencapai **100% 1st-pass validation** pada `hydra --check` (8 dari 8 berkas langsung lolos kompilasi pada percobaan pertama).
5. **Alur Kontrol Linear**: Konstruksi native `if / elif / else` dan `for ... in` mengeliminasi operator ternary bersarang (`a ? <B/> : c ? <D/> : <E/>`) dan IIFE, mengurangi salah logika saat kode digenerasi oleh AI.

---

## Matriks Sintaks & Fitur

### Tata Letak Berbasis Indentasi
Untuk anak tunggal satu baris, gunakan tanda titik dua diikuti konten; untuk anak banyak baris, gunakan blok indentasi:

```python
# Satu baris (inline)
h1: "Status Sistem"

# Blok indentasi
div(className="container"):
    header(className="header"):
        h1: "Status Sistem"
        p: "Semua node telemetri beroperasi normal."
```

### Penyisipan Auto-Fragment
Ketika suatu komponen atau blok memiliki beberapa elemen sejajar di tingkat terluar, kompiler menyisipkan fragment `<> ... </>` secara otomatis:

```python
component MetricPair(label: str, value: str):
    span(className="label"): label
    span(className="value"): value
```

Hasil kompilasi:
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

## Komparasi Sintaks Berdampingan (Side-by-Side)

### 1. Deklarasi Komponen Dasar & Auto-Fragment

#### Vanilla TSX
```tsx
import React from 'react';

export interface UserBadgeProps {
  name: string;
  role?: string;
  isOnline?: boolean;
}

export function UserBadge({ name, role = 'Member', isOnline = false }: UserBadgeProps) {
  return (
    <>
      <span className="user-name">{name}</span>
      <span className="user-role">{role}</span>
      {isOnline && <span className="status-dot" />}
    </>
  );
}
```

#### HydraScript (`.hyx`, warisan `.hsx`)
```python
# [xihanzu-NR]
component UserBadge(name: str, role: str = "Member", is_online: bool = False):
    span(className="user-name"): name
    span(className="user-role"): role
    if is_online:
        span(className="status-dot")
```

---

### 2. State Reaktif & Side Effects

#### Vanilla TSX
```tsx
import React, { useState, useEffect } from 'react';

export function Counter({ initialCount = 0, step = 1 }: { initialCount?: number; step?: number }) {
  const [count, setCount] = useState<number>(initialCount);

  useEffect(() => {
    console.log(`Nilai terkini: ${count}`);
  }, [count]);

  return (
    <div className="counter-card">
      <h2>Nilai: {count}</h2>
      <div className="button-group">
        <button type="button" onClick={() => setCount(count - step)} className="btn btn-secondary">
          -
        </button>
        <button type="button" onClick={() => setCount(count + step)} className="btn btn-primary">
          +
        </button>
      </div>
    </div>
  );
}
```

#### HydraScript (`.hyx`, warisan `.hsx`)
```python
# [xihanzu-NR]
from hydra import state, effect

component Counter(initial_count: int = 0, step: int = 1):
    count, set_count = state(initial_count)

    effect(lambda: console.log(f"Nilai terkini: {count}"), [count])

    div(className="counter-card"):
        h2: f"Nilai: {count}"
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

### 3. Percabangan Multi-Branch & Pattern Matching

#### Vanilla TSX
```tsx
export function StatusPanel({ status, loadAverage }: { status: string; loadAverage: number }) {
  return (
    <section className="monitor-panel">
      {(() => {
        switch (status) {
          case 'healthy':
            return <div className="status-green">Sistem Optimal</div>;
          case 'degraded':
            return <div className="status-amber">Tekanan Memori Tinggi</div>;
          case 'critical':
            return <div className="status-red">Node Terputus</div>;
          default:
            return <div className="status-gray">Inisialisasi</div>;
        }
      })()}

      {loadAverage > 4.0 ? (
        <div className="warning">Beban CPU Kritis: {loadAverage.toFixed(2)}</div>
      ) : loadAverage > 2.0 ? (
        <div className="info">Beban CPU Sedang: {loadAverage.toFixed(2)}</div>
      ) : (
        <div className="normal">Beban CPU Normal: {loadAverage.toFixed(2)}</div>
      )}
    </section>
  );
}
```

#### HydraScript (`.hyx`, warisan `.hsx`)
```python
# [xihanzu-NR]
component StatusPanel(status: str, load_average: float):
    section(className="monitor-panel"):
        match status:
            case "healthy":
                div(className="status-green"): "Sistem Optimal"
            case "degraded":
                div(className="status-amber"): "Tekanan Memori Tinggi"
            case "critical":
                div(className="status-red"): "Node Terputus"
            case _:
                div(className="status-gray"): "Inisialisasi"

        if load_average > 4.0:
            div(className="warning"): f"Beban CPU Kritis: {load_average:.2f}"
        elif load_average > 2.0:
            div(className="info"): f"Beban CPU Sedang: {load_average:.2f}"
        else:
            div(className="normal"): f"Beban CPU Normal: {load_average:.2f}"
```

---

### 4. Dynamic Classes & Event Modifiers

#### Vanilla TSX
```tsx
import clsx from 'clsx';

export function ContactModal({ onSubmit, isOpen = false, isSubmitting = false }) {
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onSubmit();
  };

  return (
    <div className={clsx('modal-backdrop', { 'opacity-100': isOpen, 'opacity-0': !isOpen })}>
      <form onSubmit={handleSubmit} className="modal-form">
        <label htmlFor="email_input">Alamat Email</label>
        <input id="email_input" type="email" required placeholder="nama@domain.com" />
        <button type="submit" disabled={isSubmitting}>
          {isSubmitting ? 'Mengirim...' : 'Kirim Pesan'}
        </button>
      </form>
    </div>
  );
}
```

#### HydraScript (`.hyx`, warisan `.hsx`)
```python
# [xihanzu-NR]
component ContactModal(on_submit, is_open: bool = False, is_submitting: bool = False):
    div(cls={"modal-backdrop": True, "opacity-100": is_open, "opacity-0": not is_open}):
        form(on_submit_prevent_stop=on_submit, className="modal-form"):
            label(for="email_input"): "Alamat Email"
            input(id="email_input", type="email", required=True, placeholder="nama@domain.com")
            button(type="submit", disabled=is_submitting):
                "Mengirim..." if is_submitting else "Kirim Pesan"
```

---

### 5. Iterasi Koleksi & Key Props

#### Vanilla TSX
```tsx
export function AlertList({ alerts }: { alerts: Array<{ id: string; message: string; severity: string }> }) {
  return (
    <ul className="alert-list">
      {alerts.map((alert) => (
        <li key={alert.id} className={`alert-item alert-${alert.severity}`}>
          <span className="alert-msg">{alert.message}</span>
        </li>
      ))}
    </ul>
  );
}
```

#### HydraScript (`.hyx`, warisan `.hsx`)
```python
# [xihanzu-NR]
component AlertList(alerts: list):
    ul(className="alert-list"):
        for alert in alerts:
            li(key=alert.id, className=f"alert-item alert-{alert.severity}"):
                span(className="alert-msg"): alert.message
```

---

### 6. Entrypoint Aplikasi Browser (`src/main.hyx`)

#### Vanilla TSX (`src/main.tsx`)
```tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './index.css';

const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
```

#### HydraScript (`src/main.hyx`)
```python
# [xihanzu-NR]
from "react-dom/client" import createRoot
from "./App.hyx" import App
import "./index.css"

root_element = document.getElementById("root")
createRoot(root_element).render(App())
```

---

### 7. Logika Backend & Slicing (`.hys` vs `.ts`)

#### Vanilla TypeScript (`src/utils.ts`)
```typescript
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function processLogs(dir: string, maxItems: number) {
  const raw = await readFile(join(dir, 'events.json'), 'utf8');
  const events = JSON.parse(raw);
  const sliced = events.slice(0, maxItems);
  const result = {
    timestamp: Date.now(),
    count: sliced.length,
    items: sliced,
  };
  await writeFile(join(dir, 'out.json'), JSON.stringify(result, null, 2), 'utf8');
  return result;
}
```

#### HydraScript (`src/utils.hys`)
```python
# [xihanzu-NR]
from "node:fs/promises" import readFile, writeFile
from "node:path" import join

async def process_logs(dir: str, max_items: int):
    raw = await readFile(join(dir, "events.json"), "utf8")
    events = JSON.parse(raw)
    sliced = events[:max_items]
    result = {
        "timestamp": Date.now(),
        "count": len(sliced),
        "items": sliced,
    }
    await writeFile(join(dir, "out.json"), JSON.stringify(result, None, 2), "utf8")
    return result
```

---

## Mode Meta-Framework

Hydra menyertakan runner aplikasi in-memory yang mengintegrasikan Vite, Rollup, PostCSS, Autoprefixer, dan Tailwind CSS ke dalam alur kerja CLI terpadu.

### Perintah CLI
* `hydra dev`: Menjalankan development server lokal dengan Hot Module Replacement (HMR) instan.
* `hydra build`: Mengompilasi seluruh aset, menjalankan dead-code elimination, dan memproduksi bundle siap rilis.
* `hydra preview`: Menjalankan server HTTP lokal untuk menguji build produksi (`dist/`).
* `hydra run <file.hys>`: Mengeksekusi berkas logika HydraScript langsung di memori melalui Node atau Bun (mendukung format warisan `.hs`).

### Arsitektur Zero-Config
Ketika `hydra dev` atau `hydra build` dijalankan di direktori yang memiliki `hydraconfig.json`:
1. Biner native Rust memanggil runner internal `packages/cli/runner.mjs`.
2. Runner memuat Vite dan plugin secara dinamis dari `node_modules` proyek lokal.
3. Konfigurasi in-memory menetapkan `configFile: false`, mencegah Vite mencari `vite.config.ts`.
4. Tailwind dan Autoprefixer dikonfigurasi langsung di RAM menggunakan pengaturan dari `hydraconfig.json`.
5. Modul native Node-API (`hydra.node`) memproses seluruh kompilasi `.hyx` dan `.hys` (dengan kompatibilitas mundur untuk format warisan `.hsx` dan `.hs`).

### Referensi Konfigurasi (`hydraconfig.json`)

```json
{
  "$schema": "https://hydrascript.dev/schema.json",
  "name": "aplikasi-produksi",
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

## Arsitektur Kompiler & Performa

### Alur Pipeline

```
                [ Berkas Sumber: .hyx / .hys (warisan: .hsx / .hs) ]
                                  │
                                  ▼
                      [ Lexer (lexer.rs) ]
       Penelusuran Indent/Dedent, F-Strings, Karakter Unicode
                                  │
                                  ▼
                    [ Parser (parser.rs) ]
     Recursive Descent, Blok Elemen, Comprehensions, Operator
                                  │
                                  ▼
                [ Semantic Analysis (emitter.rs) ]
     Whitelist Global JS, Pelacak Scope, Analisis Mutabilitas
                                  │
                 ┌────────────────┴────────────────┐
                 ▼                                 ▼
        Target: React (.hyx)              Target: JS (.hys)
      (Warisan: .hsx)                   (Warisan: .hs / .hx)
    Komponen TSX, Pemetaan Props       Modul ES Bersih & Ramping
                 │                                 │
                 └────────────────┬────────────────┘
                                  ▼
          [ Node-API Shared Library (hydra.node) ]
                 Pipeline Transformasi di Memori
```

### Tolok Ukur Latensi Kompilasi & Data Empiris

#### A. Head-to-Head: HydraScript vs TypeScript (`tsc`)
*Diuji pada Linux x86_64, Intel Xeon Cascadelake, Node.js v20.19:*

| Dimensi Pengujian | TSX / Vite 6 (`tsc`) | HydraScript (`hydra`) | Peningkatan / Efisiensi |
|---|---|---|---|
| **Single-File Syntax Check** | `tsc --noEmit`: 5.700 ms | `hydra --check`: **3.54 ms** | **1.610x lebih cepat** |
| **Transpilasi Cepat (No Check)** | `esbuild`: 29.00 ms | `hydra`: **~1.20 ms** | **24x lebih cepat** |
| **Waktu Build Produksi** | Vite 6 + `tsc`: 9.50 s | `hydra build`: **2.88 s** | **3.3x lebih cepat** |
| **Baris Kode (Full Dashboard)** | 1.000–1.500 LOC | **571 LOC** | **~50% lebih ringkas** |
| **BPE Tokens (`cl100k`)** | 3.865 token | **3.378 token** | **12.6% lebih hemat** |
| **Pre-rendered HTML** | CSR / Manual SSR | **18.7 KB native SSG** | Pre-render DOM instan |

#### B. Performa Transformasi In-Memory
*Diuji pada Linux x86_64, 16-Core AMD EPYC, Node.js v20.19:*

| Pengujian | CLI Subproses (`execFileSync`) | Node-API Addon (`hydra.node`) | Peningkatan |
|---|---|---|---|
| **Proyek 15 Komponen** | 42.20 ms | **6.60 ms** | **6.4x lebih cepat** |
| **1.500 Kompilasi Berulang** | 235.30 ms | **42.61 ms** | **5.5x lebih cepat** |
| **Vite Full Production Build** | 4.96 s | **3.10 s** | **37% lebih cepat** |

* Ukuran Biner: ~756 KB executable rilis (`strip` aktif, optimasi LTO).
* Pengujian: 248 tes otomatis (159 unit tests + 89 integrasi end-to-end).

---

## Referensi Bahasa

### Deklarasi Komponen
```python
component Name(prop_a: str, prop_b: int = 10, on_click=None):
    div: f"{prop_a}: {prop_b}"
```

### Konvensi Properti dan Event
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

Akhiran modifier event:
* `_prevent`: Menjalankan `event.preventDefault()`
* `_stop`: Menjalankan `event.stopPropagation()`
* `_prevent_stop`: Menjalankan keduanya

### Hooks & Baterai React
HydraScript menyediakan adapter Pythonic untuk API dasar React melalui runtime `hydra`:

| Fungsi Hydra | API React Terkait | Deskripsi |
|---|---|---|
| `val, set_val = state(init)` | `useState` | Mengembalikan tuple nilai dan setter |
| `r = ref(init)` | `useRef` | Membuat referensi mutable persisten |
| `cb = callback(fn, deps)` | `useCallback` | Memoisasi fungsi callback |
| `effect(fn, deps)` | `useEffect` | Menjalankan side-effect saat dependensi berubah |
| `val, toggle_fn, set_val = toggle(False)` | Custom hook | Toggle boolean dengan fungsi pembalik |
| `is_mounted = use_mounted()` | Custom hook | Bernilai true setelah elemen dimount |

### Whitelist Global JavaScript
Kompiler mengenali objek global bawaan browser dan memastikan pemanggilan fungsinya tidak diubah menjadi tag JSX:
* `Math`, `Date`, `Array`, `Object`, `Number`, `String`, `Boolean`
* `RegExp`, `JSON`, `Promise`, `Reflect`, `Intl`, `Set`, `Map`
* `WeakSet`, `WeakMap`, `Symbol`, `Error`, `TypeError`, `RangeError`
* `ResizeObserver`, `IntersectionObserver`, `MutationObserver`
* `WebSocket`, `Worker`, `Audio`, `Image`, `FormData`, `URL`, `URLSearchParams`

### Import dan Export Modul
```python
# Import terdefinisi dari package
from "react" import useState, useEffect

# Import komponen lokal
from "./Header.hyx" import Header

# Import namespace
import "three" as THREE

# Import stylesheet side-effect
import "./index.css"

# Export komponen
export component Button(label: str):
    button: label

# Export fungsi atau variabel
export def hitung_pajak(nominal):
    return nominal * 0.11

export API_URL = "https://api.domain.com/v1"
```

---

## Referensi CLI

```
hydra [COMMAND] [OPTIONS]

PERINTAH:
  dev                   Menjalankan development server dengan live HMR
  build                 Mengompilasi dan membundle proyek untuk produksi
  preview               Menjalankan preview build produksi secara lokal
  run <file.hys> [args] Mengeksekusi skrip HydraScript langsung di memori (format warisan .hs didukung)
  watch [dir]           Memantau direktori dan recompile saat ada perubahan
  check <file.hyx>      Validasi sintaks tanpa menghasilkan berkas keluaran
  repl                  Membuka sesi REPL interaktif HydraScript
  --version, -v         Menampilkan informasi versi kompiler
  --help, -h            Menampilkan bantuan CLI

VARIABEL LINGKUNGAN:
  HYDRA_NATIVE          Path eksplisit ke pustaka hydra.node
  HYDRA_COMPILER        Path eksplisit ke biner CLI hydra
```

---

## Instalasi & Panduan Memulai

### 1. Langsung dari GitHub via npm (Direkomendasikan)
Tidak perlu meng-clone repo atau mengompilasi biner Rust secara manual. Pasang langsung menggunakan npm:

```bash
# Pasang secara global (menambahkan 'hydra' ke PATH terminal Anda)
npm install -g hanxthvy/hydrascript

# Atau pasang sebagai dev dependency di proyek lokal Anda
npm install -D hanxthvy/hydrascript
```

### 2. Eksekusi On-Demand dengan npx (Nol Instalasi)
Sama seperti Next.js dan Astro, Anda dapat menjalankan perintah Hydra secara instan tanpa perlu memasangnya terlebih dahulu:

```bash
# Menjalankan development server lokal
npx github:hanxthvy/hydrascript dev

# Menjalankan build produksi
npx github:hanxthvy/hydrascript build

# Menjalankan preview build produksi
npx github:hanxthvy/hydrascript preview
```

### 3. Kompilasi Mandiri dari Source Code
Pastikan toolchain Rust (1.80+) dan Cargo telah terpasang:

```bash
git clone https://github.com/hanxthvy/hydrascript.git
cd hydrascript/compiler-rs

# Jalankan seluruh rangkaian pengujian (248 tes)
cargo test

# Build biner rilis teroptimasi & addon Node-API
cargo build --release

# Buat symlink atau salin ke system PATH
cp target/release/hydra /usr/local/bin/hydra
```

### 4. Membuat Proyek Baru
```bash
# Di direktori kosong dengan package.json
npm install react react-dom
npm install -D hanxthvy/hydrascript

# Buat entrypoint di src/main.hyx dan jalankan:
npx hydra dev
```

---

## Panduan Deployment Produksi

### Static Hosting
Untuk Vercel, Netlify, Cloudflare Pages, atau GitHub Pages:

```bash
# Build berkas statis
npm run build # menjalankan 'hydra build'

# Direktori keluaran
dist/
```

Konfigurasi provider hosting:
* **Build Command**: `hydra build` (atau `npm run build`)
* **Output Directory**: `dist`

### Wadah Docker
Contoh berkas Dockerfile multi-stage untuk deployment container:

```dockerfile
# [xihanzu-NR]
FROM node:20-alpine AS builder
WORKDIR /app

# Pasang dependensi
COPY package*.json hydraconfig.json ./
RUN npm ci

# Salin source dan tool native
COPY . .

# Build proyek
RUN npx hydra build

FROM nginx:alpine AS runner
COPY --from=builder /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
```

---

## Dukungan Editor

### Visual Studio Code
Dukungan pewarnaan sintaks tersedia di `editors/vscode`:
1. Salin atau buat symlink folder `editors/vscode` ke `~/.vscode/extensions/hydrascript`.
2. Muat ulang VS Code.
3. Berkas `.hyx`, `.hys`, dan warisan `.hsx`/`.hs` akan menampilkan pewarnaan sintaks, pengenalan kata kunci, dan panduan indentasi otomatis.

---

## Kontribusi & Roadmap Arsitektur

HydraScript sedang aktif dikembangkan menuju rilis v1.0 GA. Spesifikasi arsitektur komprehensif, mencakup file-based routing dan language server native (`hydra-lsp`), tercatat di:
* [`PRODUCTION_BLUEPRINT.md`](PRODUCTION_BLUEPRINT.md): Roadmap arsitektur dan spesifikasi meta-framework produksi.
* [`CRITIQUE_AND_ROADMAP.md`](CRITIQUE_AND_ROADMAP.md): Bedah diagnostik dan penanganan edge-case kompiler.

Untuk menjalankan rangkaian pengujian secara lokal:
```bash
cd compiler-rs
cargo test
```

---

## Lisensi

Lisensi MIT. Hak Cipta (c) Reyhan Akhtar Afriansyah (Hanz).  
Seluruh hak cipta dilindungi undang-undang.
