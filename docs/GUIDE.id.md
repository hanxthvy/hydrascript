<!-- [xihanzu-NR] -->
# Panduan: meta-framework

Semua yang dilakukan `hydra dev`, `hydra build` dan `hydra preview` di satu
tempat: routing berbasis berkas, prerender, loader dan action, API route,
middleware, variabel lingkungan, target deploy, SSR, test runner, dan language
server.

[README](../README.id.md) memuat versi singkat tiap bagian; berkas ini rujukan
lengkapnya kalau kamu butuh detail dan perilaku persisnya.

---

**`hydra dev`, `build` dan `preview` memakai esbuild, bukan Vite.** PostCSS,
Autoprefixer dan Tailwind digerakkan secara programatik, jadi proyek tidak
membutuhkan `vite.config.ts`, `tailwind.config.ts` maupun `postcss.config.js`.

| Perintah | Fungsi |
|---|---|
| `hydra dev` | Build, sajikan, dan build ulang saat berkas berubah |
| `hydra build` | Build produksi: aset ber-hash, CSS terminifikasi, SSG |
| `hydra preview` | Menyajikan `dist/` (build dulu kalau belum ada) |
| `hydra serve` / `hydra start` | Menyajikan hasil build untuk deploy; menolak start kalau separuh server tidak ada |
| `hydra run <file.hys>` | Menjalankan skrip in-process |

Artefak, header respons, kompresi, dan batas platform ada di
[`docs/DEPLOYING.md`](docs/DEPLOYING.md).

**Soal "HMR":** `hydra dev` memantau `src/`, build ulang, dan **memuat ulang
halaman di browser lewat websocket** — tanpa dependensi, tanpa ekstensi, sekitar
**~190 ms** dari simpan ke reload, median 3 edit (`node benchmarks/dev-reload.mjs`); build pertama ~1,4 detik. Yang *tidak* ia lakukan adalah mempertahankan
state komponen melintasi perubahan: edit yang berhasil memuat ulang halaman, bukan
menukar modul di tempat. Menyebutnya React Fast Refresh akan salah, jadi README
ini menyebutnya live reload.

**Build ulang yang gagal tidak memuat ulang.** Error-nya dikirim ke halaman,
jadi console menampilkan pesan compiler beserta berkas dan barisnya, dan kamu
tetap memegang halaman terakhir yang bekerja sampai kodenya bisa dikompilasi lagi.

## Routing berbasis berkas

`src/pages/` adalah tabel route-nya. Nama berkas menentukan URL-nya, dan
`hydra routes` mencetak hasilnya supaya tidak ada yang tersembunyi.

```
src/pages/index.hyx             -> /
src/pages/about.hyx             -> /about
src/pages/blog/index.hyx        -> /blog
src/pages/blog/[slug].hyx       -> /blog/:slug
src/pages/docs/[...rest].hyx    -> /docs/*      (satu segmen atau lebih)
src/pages/files/[[...rest]].hyx -> /files/*     (boleh juga /files)
src/pages/(marketing)/price.hyx -> /price       (grup: hanya untuk layout)
src/pages/_partials/Hero.hyx    -> tidak routable
```

`_layout.hyx` membungkus semua route di foldernya ke bawah, `_404.hyx` dipakai
saat tidak ada yang cocok, dan `_error.hyx` jadi batas error untuk foldernya.
Ketiganya boleh ada di banyak level; yang terdekat menang.

Dua berkas yang mengklaim URL yang sama adalah **error build** yang menyebut
kedua berkasnya, bukan pertandingan yang diputuskan diam-diam. Itu berlaku untuk
`blog/[slug].hyx` + `blog/[id].hyx` (satu posisi URL, dua nama parameter) dan
untuk `about.hyx` + `about/index.hyx` (satu URL, dua berkas).

Direktori route bisa diubah lewat `"routes"` di `hydraconfig.json`, atau
dimatikan dengan `"routes": false`.

## SSG per route

**SSG menulis satu berkas HTML per route statis**: `dist/about/index.html`, bukan
satu `dist/index.html` untuk seluruh situs. Route dinamis dilewati dan
**disebutkan namanya** di log build, karena URL ber-parameter tidak punya satu
halaman untuk dibangun:

```
[hydra] 4 route(s) from src/pages, 1 dynamic (/blog/:slug)
[hydra] SSG: pre-rendered 3/3 static route(s) into dist/
[hydra] SSG: 1 dynamic route(s) left as the client shell (/blog/:slug) —
        a URL with a parameter has no single page to build
```

Runtime gate sekarang memeriksa **setiap** `index.html` yang dihasilkan, bukan
hanya yang di akar: dengan HTML per-route, memeriksa satu halaman meninggalkan
setiap route lain tanpa pemeriksaan.

**SSG menyala secara default untuk route statis.** Proyek dengan `src/pages` dan
`Router()` pra-render setiap route statis tanpa konfigurasi apa pun. Statis
artinya: tanpa parameter URL, dan tanpa `rendering = "csr"` di halamannya.

Dua cara opt-out, keduanya tanpa sintaks baru:

```python
# src/pages/dashboard.hyx — halaman ini render di klien saja
rendering = "csr"

component Dashboard():
    ...
```

```json
// hydraconfig.json — seluruh proyek, kembali ke perilaku lama
{ "rendering": { "ssg": false } }
```

Route **dinamis** (`[slug]`) tidak punya satu halaman untuk dibangun, jadi ia
dilewati dan disebut namanya di log build. Itu sengaja, bukan celah: SSR untuk
route dinamis butuh server saat request, dan build statis tidak punya itu. Empat
proyek contoh masih memakai `"ssg": false` — masing-masing adalah satu-halaman
yang menguji runtime, bukan situs dengan URL yang diinginkan crawler.

Kalau proyek punya `src/pages` tapi `App`-nya tidak pernah memanggil `Router()`,
tidak ada yang dipra-render: tanpa router tidak ada route untuk dipra-render, dan
build mengatakannya, bukan menulis halaman kosong.

## Metadata: `meta`

Sebuah halaman boleh mendeklarasikan `<title>` dan deskripsinya sendiri sebagai
dict di level modul:

```python
# src/pages/about.hyx
meta = {"title": "About — Hanz", "description": "Siapa yang menulis ini."}

component About():
    ...
```

Nilai itu dipakai di dua tempat, dari satu sumber:

- **Saat build**, ke HTML statis route itu: `dist/about/index.html` memuat
  `<title>` dan `<meta name="description">` tersebut, menggantikan punya cangkang.
  Halaman tanpa `meta` tetap memakai judul cangkang, begitu juga setiap route yang
  tidak pernah diberi `meta`.
- **Saat navigasi klien**, oleh `Router()` — yang sudah dirender setiap proyek
  ber-route. Pindah dari `/` ke `/about` memasang judul baru; kembali lagi
  memulihkan judul cangkang, karena halaman yang tidak mengklaim apa pun tidak
  boleh mewarisi judul halaman sebelumnya.

Dua kunci, `title` dan `description`. Kunci ketiga adalah **error build yang
menyebut namanya**, bukan nilai yang tidak pernah sampai ke halaman: ini bukan
head manager, dan tidak akan tumbuh jadi satu. Ini juga bukan hook — tidak ada
`use_head`, dan menambahkannya berarti dua cara mengatakan hal yang sama.

`meta` dibaca dari SUMBER halaman, di tempat yang sama `rendering = "csr"` dibaca,
bukan dengan mengimpor halaman. Compiler meng-emit `meta` level modul sebagai
`const` lokal, bukan ekspor, jadi impor tidak akan membawanya — dan halaman adalah
modul klien, jadi mengimpornya saat build berarti menjalankan impor-impornya di
node, melewati batas yang justru dijaga `.server.hys`.

**Yang sengaja belum:** metadata yang bergantung pada URL (`/blog/hello` ingin
"hello" di judulnya) bukan metadata statis, dan ini tidak berpura-pura sebaliknya
— cangkang route dinamis memakai judul aplikasi, dan klien memasang judul
halamannya setelah hidrasi. Tidak ada open-graph, twitter card, canonical, atau
structured data; masing-masing adalah klaim terpisah tentang sebuah halaman dan
butuh pernyataannya sendiri tentang apa yang membuatnya benar.

## Data: `loader` dan `action`

Sebuah halaman bisa punya **belahan server** di berkas di sampingnya — nama sama,
`.server.hys` bukan `.hyx`:

```
src/pages/blog/index.hyx           -> halamannya (modul klien: render di browser)
src/pages/blog/index.server.hys    -> loader dan action-nya (modul server: tak pernah masuk bundel)
```

```python
# src/pages/blog/index.server.hys
from "hydra/server" import env

export async def loader(event):
    return {"posts": await db.fetch_all(), "region": env("REGION", "local")}

export async def action(event):
    text = event.request.body.get("text")
    if not text:
        return {"ok": False, "reason": "empty"}
    await db.insert(text)
    return redirect("/blog?added=1")
```

```python
# src/pages/blog/index.hyx — props-nya ADALAH nilai balikan loader
component BlogIndex(posts: list = [], region: str = "?"):
    ...
```

`loader` jalan **sekali per route saat build** (SSG), hasilnya dirender ke HTML
*dan* di-inline sebagai JSON, jadi klien hydrate dengan nilai yang sama alih-alih
fetch ulang. `action` jalan saat URL yang sama di-`POST`.

**Kenapa berkas terpisah, bukan `export def loader` di dalam halaman.** Modul
halaman adalah modul klien: ia render di browser dan import-nya masuk bundel
klien. Loader yang dideklarasikan di sana hanya bisa server-only *berdasarkan
konvensi* — satu `import fs` nyasar dan build rusak dengan cara yang sulit dibaca.
`.server.hys` sama sekali tidak terjangkau dari klien, jadi pemisahannya fakta
tentang build, bukan aturan yang harus diingat.

`event` adalah satu objek, jadi tanda tangannya tidak berubah saat framework
menambah field: `event.params`, `event.url`, `event.query` (punya `.get()`), dan
`event.request` (`method`, `headers`, `body`, hanya untuk action).

`.server.hys` tanpa halaman di sampingnya adalah **error build yang menyebut
kedua berkasnya**, karena loader yang tak pernah dipanggil hampir selalu salah
nama berkas.

**Belum selesai:** loader tidak jalan ulang saat navigasi *sisi klien* — JSON
yang di-inline itulah yang klien punya sampai halaman dimuat ulang. Itu, dan SSR
untuk route dinamis, adalah bagian berikutnya; lihat roadmap.

Keluaran build: `dist/index.html`, `dist/assets/index-<hash>.js`,
`dist/assets/index.css`, plus chunk untuk `import()` dinamis.

---
