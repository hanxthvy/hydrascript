# Roadmap fitur HydraScript

Lanjutan dari `RESEARCH-META-FRAMEWORK.md`. Ini yang akan dibangun, dalam urutan
yang bisa dikerjakan, dengan konvensi yang sudah diputuskan.

Aturan yang dipegang sepanjang dokumen ini, sesuai janji di README:

- **Sintaks tetap beku di 0.3.** Tidak ada konstruksi baru di `.hyx`/`.hys`.
  Semua fitur di sini hidup di runner, runtime, dan konvensi nama berkas.
- **Tidak ada kode tersembunyi.** Tiap hal yang di-generate bisa dilihat lewat
  perintah (`hydra routes`), dan tidak ada satu pun yang berjalan karena
  "framework bilang begitu".
- **Tidak ada auto-import.** Bertabrakan dengan `hydra check` dan dengan satu-
  satunya nilai jual yang susah ditiru: semuanya eksplisit.

Legenda status: `BARU` = belum ada sama sekali. `PERLUAS` = pondasinya ada.
`PERBAIKI` = sudah ada tapi belum layak dipakai.

---

## Fase 1 — Routing berbasis berkas (tanpa server)

Ini fondasinya. Semua fase lain menggantung di sini.

### F1. `hydra routes` — penemuan route + manifest `SELESAI`

Scan `src/pages/**/*.hyx`, hasilkan manifest route: path URL, berkas, daftar
param, dan apakah route itu statis atau dinamis.

- Tulis ke `.hydra/routes.generated.js` (tidak di-commit, masuk `.gitignore`).
- Di-inject sebagai virtual module lewat esbuild plugin yang sudah ada.
- `hydra routes` mencetaknya sebagai tabel supaya tidak ada yang tersembunyi.
- `hydra routes --json` untuk dipakai tooling/CI.

Konvensi nama berkas:

```
src/pages/index.hyx            -> /
src/pages/about.hyx            -> /about
src/pages/blog/index.hyx       -> /blog
src/pages/blog/[slug].hyx      -> /blog/:slug
src/pages/docs/[...rest].hyx   -> /docs/*  (satu segmen atau lebih; `/docs` sendiri TIDAK match)
src/pages/docs/[[...rest]].hyx -> /docs/*  (boleh nol segmen, jadi `/docs` juga match)
src/pages/(marketing)/price.hyx -> /price  (grup, tidak masuk URL)
src/pages/_partials/Hero.hyx   -> tidak routable (awalan `_`)
```

Desain yang diambil dari mana: `[slug]` dan `[...rest]` dari Next/Nuxt,
awalan `_` untuk privat dari Next (`_folder`), `(grup)` untuk layout terpisah
dari Next dan SvelteKit.

Yang disentuh: `packages/cli/runner.mjs`, `packages/cli/esbuild-plugin.mjs`,
`.gitignore`, `schema.json` (kunci `routes`).

Diverifikasi kalau: `hydra routes` mencetak tabel benar untuk scaffold DAN untuk
portfolio `/var/www/hanz`; build tetap hijau; gate headless lulus.

### F2. Navigasi klien + `Link` `SELESAI`

`use_path()` dan `navigate()` sudah ada. Yang ditambah:

- `use_route()` -> `{"path": str, "params": dict, "query": dict}`
- `use_params()` -> `dict` dari `[slug]`/`[...rest]`
- `use_query()` -> `dict` dari `?a=1`
- `Link(to="/about")` -> komponen `hydra` yang merender `<a href>` dan
  meng-intercept klik kiri biasa jadi `navigate()`. `<a>` biasa tetap berfungsi
  tanpa JS, sama seperti SvelteKit.

Sengaja TIDAK dibuat: prefetch otomatis ala `next/link`. Itu optimasi yang
membutuhkan asumsi tentang siapa yang akan mengklik, dan bisa ditambah nanti
tanpa mengubah API.

Yang disentuh: `runtime/hydra.ts` saja. Nol perubahan compiler.

Diverifikasi kalau: navigasi klien mempertahankan state React yang sama
(tidak remount seluruh pohon), tombol back browser mengembalikan halaman benar.

### F3. Layout bersarang `SELESAI`

`_layout.hyx` di sebuah folder membungkus semua route di folder itu, dan
mewarisi layout di atasnya.

```
src/pages/_layout.hyx          -> membungkus semua route
src/pages/dashboard/_layout.hyx -> membungkus /dashboard/*
```

Isi layout memakai `slot` yang sudah ada di bahasa ini, jadi tidak ada sintaks
baru sama sekali — ini murni penyusunan pohon di manifest.

Diverifikasi kalau: navigasi antar dua route bersaudara tidak me-remount layout.

### F4. Halaman `_404.hyx` dan `_error.hyx` `SELESAI`

`_404.hyx` untuk URL yang tidak ketemu, `_error.hyx` sebagai error boundary
React per folder (boleh di beberapa level, yang terdekat menang).

Diverifikasi kalau: route yang salah menampilkan `_404` bukan halaman putih;
komponen yang sengaja `raise` tertangkap boundary dan halaman lain tetap hidup.

### F5. Metadata per halaman `SELESAI`

Ekspor `meta` dari berkas halaman, atau panggil `use_head({...})` dari runtime.

```
# src/pages/about.hyx
meta = {"title": "About — Hanz", "description": "..."}

component About():
    ...
```

Diterapkan ke `<head>` saat SSG, dan diubah di klien saat navigasi. Ini yang
membuat SSG punya alasan untuk dipakai.

Diverifikasi kalau: `dist/about/index.html` memuat `<title>` yang benar, dan
`view-source` halaman itu bukan cangkang kosong.

**Sudah dikirim** (lihat `CHANGELOG.md`, bagian Unreleased). Yang berubah dari
rencana di atas: `use_head({...})` TIDAK dibuat. Satu sumber saja — ekspor
`meta` di berkas halaman — dan hanya dua kunci, `title` dan `description`; kunci
ketiga adalah error build yang menyebut namanya, bukan nilai yang tidak pernah
sampai ke halaman. `meta` dibaca dari sumber halaman saat scan, bukan dengan
mengimpor halaman: compiler meng-emit `meta` sebagai `const` lokal, bukan
ekspor.

Yang TIDAK dikerjakan, dan disebut di README: metadata yang bergantung pada URL
(`/blog/hello` ingin "hello" di judulnya) bukan metadata statis — cangkang route
dinamis tetap memakai judul aplikasi. Tidak ada open-graph, twitter card,
canonical, atau structured data.

### F6. SSG per-route `SELESAI`

Sekarang hanya `dist/index.html`. Setelah F1 ada, loop `renderToString` untuk
tiap route statis -> `dist/about/index.html`. Route dinamis (ber-param) dilewati
kecuali diminta eksplisit, dan itu dilaporkan saat build, bukan didiamkan.

Kode `renderToString` + penyuntikan HTML-nya sudah ada di `runner.mjs`; ini
mengubah "satu keluaran" jadi "satu keluaran per route".

Diverifikasi kalau: build portfolio menghasilkan >1 berkas HTML, tiap berkas
memuat markup asli, dan gate headless lulus di semuanya.

---

## Fase 2 — DX

### F7. HMR websocket sungguhan `SELESAI`

Ganti "rebuild 10 detik lalu refresh manual" jadi push lewat websocket +
`import.meta.hot`. Dev server sudah punya HTTP server sendiri, jadi ini
menambah protokol, bukan mengganti bundler.

Hati-hati: ini protokol yang harus dijaga selamanya. Harus ada penurunan yang
bersih ke full reload kalau modulnya tidak bisa di-hot-swap.

Diverifikasi kalau: edit satu komponen mengubah halaman tanpa kehilangan state,
dan edit yang tidak bisa di-hot-swap jatuh ke reload penuh, bukan halaman mati.

### F8. `hydra doctor` dan `hydra stats` tahu soal route `SELESAI`

Melaporkan jumlah route, route duplikat, param yang bertabrakan (`[slug].hyx`
dan `[id].hyx` di folder yang sama harus jadi error, bukan salah satu menang
diam-diam), dan route yang menunjuk berkas hilang.

Diverifikasi kalau: dua berkas param bertabrakan menghasilkan pesan error yang
menyebut kedua berkasnya.

---

## Fase 3 — Sisi server (satu paket, jangan setengah)

Tiga fitur di bawah ini hanya boleh dikirim bersama. API route tanpa pemisahan
rahasia adalah jebakan, bukan fitur.

### F9. `.env` dengan pemisahan rahasia `SELESAI`

- `PUBLIC_*` boleh masuk bundel klien.
- Selain itu hanya ada di server, dan dipakai lewat `import.meta.env` (yang
  sudah di-`define` esbuild) atau `env("KEY")` dari runtime di sisi server.
- Memakai variabel non-`PUBLIC_` di berkas klien jadi **error build**, bukan
  `undefined` diam-diam.

Diverifikasi kalau: sengaja memakai kunci rahasia di komponen klien
menggagalkan build dengan pesan yang menyebut nama variabelnya.

**Bukti (0.10.0):** `packages/cli/env.mjs`; cek berjalan pada output
TERKOMPILASI tiap modul di graf klien, jadi `.hys` yang diimpor komponen ikut
terperiksa. `src/lib/leaky.hys` berisi `process.env.SECRET_KEY`:

```
✘ [ERROR] src/lib/leaky.hys:5:32: SECRET_KEY is not available in the browser.
  Only names starting with PUBLIC_ are inlined into the client bundle;
  SECRET_KEY stays on the server. ...
```

Uji: `api-routes.test.mjs` — "a non-PUBLIC_ variable in a client file FAILS the
build, naming it", dan pasangannya yang membuktikan `PUBLIC_*` benar-benar
di-inline sementara rahasianya tidak ada di `dist/`.

### F10. API routes `SELESAI`

`src/api/*.hys` yang mengekspor fungsi per metode.

```
# src/api/hello.hys
def get(req):
    return {"ok": True, "at": now_iso()}

def post(req, body):
    return {"created": body["name"]}, 201
```

Jalan di `hydra dev` dan `hydra preview`, dan jadi handler saat build target
Node. Di build target statis, folder `api/` dilaporkan sebagai diabaikan —
dengan sengaja berisik, bukan hilang tanpa kabar.

Diverifikasi kalau: `curl` ke endpoint dev mengembalikan JSON benar untuk GET dan
POST; build statis memberi peringatan yang menyebut route yang dibuang.

**Bukti (0.10.0):** `packages/cli/api-routes.mjs`. GET/POST atas `hydra dev`:

```
GET  /api/hello  -> 200 {"ok":true,"service":"probe-api","secret_len":19}
POST /api/hello  -> 201 {"created":"xihanzu","echo":{"name":"xihanzu"}}
```

Build statis:

```
  --target static: the server half is NOT in this build
  dropped  /api/hello               src/api/hello.hys
  dropped  (middleware)             src/middleware.hys
```

Satu penyimpangan dari sketsa di atas, dan alasannya: berkas contoh menulis
`def get(req)`, padahal teks fiturnya menuntut "mengekspor". Tanpa `export`
fungsinya lokal, build tetap hijau, dan tiap request dapat 405 — jadi itu
sekarang error build yang menyebut berkasnya, bukan kegagalan diam.

### F11. Middleware `SELESAI`

Satu `src/middleware.hys` yang mengekspor `handle(req)` dan bisa membalas,
mengubah, atau meneruskan. Bergantung pada F10.

Diverifikasi kalau: middleware bisa memblokir satu path dan meneruskan sisanya.

**Bukti (0.10.0):** `handleApiRequest` di `packages/cli/api-routes.mjs`, satu
objek `req` yang dipakai middleware lalu handler (menyalin akan membuat mutasi
tidak terlihat handler). Satu berkas, satu path diblokir, sisanya lewat:

```
GET  /api/admin/users -> 403 {"error":"blocked by middleware","path":"/api/admin/users"}
POST /api/hello       -> 201 {"created":"again"}
```

Cakupan ditulis terang: `/api` dan ke bawah. Middleware TIDAK jalan untuk berkas
statis, karena host statis tidak punya middleware — menjalankannya di dev akan
membuat dev dan produksi berbeda pendapat soal `/about`.

### F12. Loader per-route `SELESAI`

Satu model saja, bukan tiga. Ekspor `load(params, req)` di berkas halaman
(mirip `+page.server.js` SvelteKit, tapi tetap satu berkas).

- Saat SSG: jalan di server, hasilnya disuntik ke HTML dan diteruskan lewat
  payload supaya klien tidak fetch dua kali.
- Saat navigasi klien: framework yang memanggil, komponen tidak.

Diverifikasi kalau: satu halaman menampilkan data yang sama saat SSG dan saat
navigasi klien, dan tidak ada request ganda di Network tab.

---

## Fase 4 — Pilihan, setelah semua di atas terbukti

### F13. `hydra build --target node|static` `SELESAI`

Dua target saja. Adapter multi-platform ala Nitro baru masuk akal kalau ada
pengguna lain; sebelum itu jumlah target adalah biaya tanpa pembaca.

**Bukti (0.10.0):** `--target` divalidasi di `packages/cli/runner.mjs`, build
mencatat `.hydra/build.json` (`{target, mode, api}`), dan `preview` membaca
catatan itu untuk memutuskan apakah API dipasang — bukan menebak dari ada/
tidaknya `src/api`. Nilai ketiga ditolak sebelum apa pun di-bundle:

```
[hydra] --target must be "node" or "static", got "edge". There are deliberately only two.
```

Default tetap `static`, karena itulah yang dihasilkan semua rilis sebelumnya;
mengubahnya akan mengubah API yang sudah ter-deploy jadi 404 untuk siapa pun
yang upgrade tanpa membaca changelog.

---

## Yang sengaja tidak dibangun

Ditulis di README sebagai keputusan, bukan sebagai kekurangan:

- **React Server Components.** Ini ganti arsitektur, bukan tambahan. Emit
  HydraScript adalah React client biasa, dan itu disebut sebagai kelebihan,
  bukan utang.
- **Streaming SSR dan islands (Astro).** Sama: modelnya berbeda, bukan kurang.
- **Route paralel dan intercepting route (Next).** Fitur niche, biaya konseptual
  tinggi, dan di Next pun jarang dipakai.
- **Auto-import komponen ala Nuxt.** Bertabrakan dengan `hydra check` dan dengan
  janji "eksplisit". Ditolak sadar, bukan karena sulit.
- **Prefetch otomatis.** Bisa ditambah nanti tanpa mengubah API, jadi tidak perlu
  sekarang.

---

## Urutan kerja yang disarankan

| # | Fitur | Kenapa di sini |
|---|---|---|
| 1 | F1 (route + manifest) | Prasyarat. Tanpa ini semua menggantung. |
| 2 | F2 (navigasi + Link) | Murah, dan langsung terasa di scaffold. |
| 3 | F3 (layout) | Bahasa sudah punya `slot`; ini cuma penyusunan pohon. |
| 4 | F4, F5, F6 (404, meta, SSG per-route) | Paket yang mengubah SSG jadi berguna. |
| 5 | F7, F8 (HMR, doctor) | DX. Bisa ditukar dengan #4 kalau DX lebih mendesak. |
| 6 | F9, F10, F11, F12 (server) | Satu paket. Jangan dicicil. |
| 7 | F13 (target) | Paling akhir, dan paling bisa ditunda. |

## Jebakan yang sudah ketemu (harus ditangani, bukan diasumsikan tidak ada)

- `/var/www/hanz` punya `src/hydra.hys`, sedangkan `hydra` adalah specifier
  kontrak compiler dan README melarangnya. Begitu F1 memindai `src/`, ini harus
  dilaporkan sebagai error yang jelas. Sudah ada satu pengguna nyata di disk.
- `hydraconfig.json` belum punya kunci direktori route. F1 harus menambahkan
  `"routes": "./src/pages"` ke `schema.json` supaya tidak jadi konvensi yang
  hanya hidup di dalam kode.
- Manifest route akan jadi sumber kebenaran kedua di samping kode. Pola di repo
  ini sudah punya jawabannya (`build.rs` menurunkan daftar helper runtime dari
  `runtime/hydra.ts` dan gagal kalau file itu hilang): manifest harus dihasilkan
  dari berkas sumber, tidak pernah ditulis tangan.

## Yang belum diverifikasi

Semua di dokumen ini adalah rencana, bukan klaim sudah jalan. Yang belum diukur:
waktu build + gate untuk 50+ route hasil SSG, dan apakah runtime gate masih
lulus kalau HTML sudah ter-hydrate penuh alih-alih cangkang kosong.

## Status akhir

Tiga belas dari tiga belas item di dokumen ini selesai, masing-masing diverifikasi
dengan menjalankannya: `hydra routes` mencetak tabel, layout membungkus route,
`_404` masuk tabel, `meta` muncul di `<title>` tiap halaman, `hydra doctor`
menggagalkan tabrakan param dengan menyebut kedua berkasnya, `.env` dengan
`PUBLIC_` menolak build yang membocorkan rahasia, API route menjawab GET 200 dan
POST 201, middleware memblokir satu path dan meneruskan sisanya, dan
`--target node|static` melaporkan apa yang dibuang alih-alih membuangnya diam-diam.

Yang tersisa di luar daftar ini adalah paruh kedua Fast Refresh: state komponen
bertahan saat diedit, tetapi markup hasil editnya belum masuk ke pohon yang sudah
ter-mount. Itu dicatat di README sebagai `open`, bukan sebagai selesai.
