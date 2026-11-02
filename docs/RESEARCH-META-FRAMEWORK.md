# Riset: fitur meta-framework mana yang layak diambil HydraScript

Dokumen riset, bukan kode. Disusun sebelum satu baris pun ditulis untuk fitur
router. Sumber: doc resmi Next.js (App Router), Nuxt 4, SvelteKit, Remix/React
Router 7, Astro, plus pembacaan langsung repo ini (`runner.mjs`,
`runtime/hydra.ts`, `compiler-rs/src/scaffold.rs`).

Kesimpulan singkat di bagian 5. Bagian 1-4 adalah buktinya.

---

## 1. Kondisi HydraScript hari ini

| Aspek | Keadaan sekarang | Bukti |
|---|---|---|
| Bahasa | Pythonic, sintaks dibekukan di 0.3 | README, SPEC.md |
| Target | `.hyx` → TSX, `.hys` → JS | compiler-rs |
| Bundler | esbuild + PostCSS + Tailwind programatik | `packages/cli/runner.mjs` |
| Plugin esbuild | Ada, 170 baris, bisa virtual module | `packages/cli/esbuild-plugin.mjs` |
| Dev server | Watch + rebuild ~10 detik, TANPA websocket/HMR | README "Soal HMR" |
| SSG | Opt-in, SATU `dist/index.html` saja | README, `runner.mjs` ~1070 |
| Hydration | Sudah ada: `mount()` pilih `hydrateRoot` kalau `#root` berisi | `runtime/hydra.ts:639` |
| Routing | Manual. `use_path()` + `navigate()` + `if/elif` di `App.hyx` | `runtime/hydra.ts:657,684` |
| File-based routing | **Belum ada**, dan README menyebutnya rencana | README.id.md:588 |
| SSL/API routes | Belum ada perintah `hydra` untuk itu | grep: nol hasil |
| Middleware | Belum ada | grep: nol hasil |
| Env var runtime | Hanya `import.meta.env.*` yang di-`define`; tidak ada `.env` | `runner.mjs:384-397` |
| Plugin/extension system | Belum ada (yang ada `plugins:` milik Tailwind) | grep |
| i18n / image opt / auth | Belum ada | grep |
| Scaffold | Sudah pakai `src/pages/`, tapi impor hardcoded + `if/elif` | `scaffold.rs:392-400` |

Penting: `mount()` **sudah** hydrate kalau HTML sudah berisi markup. Jadi
infrastruktur hydration bukan pekerjaan yang harus dimulai dari nol.

---

## 2. Inventaris fitur meta-framework

Kolom "menyeluruh" = dipakai di hampir semua (Next, Nuxt, SvelteKit, Remix,
Astro). Kolom "satu-off" = cuma satu (mis. intercepting routes Next, actions
Remix).

### 2.1 Routing

| Fitur | Next (App) | Nuxt 4 | SvelteKit | Status |
|---|---|---|---|---|
| Folder = segmen URL | `app/blog/page.tsx` | `pages/blog.vue` | `routes/blog/+page.svelte` | menyeluruh |
| Param dinamis | `[slug]` | `[slug]` | `[slug]` | menyeluruh |
| Catch-all | `[...slug]` | `[...slug]` | `[...rest]` | menyeluruh |
| Catch-all opsional | `[[...slug]]` | `[[...slug]]` | `[[...rest]]` | menyeluruh |
| Layout bersarang | `layout.tsx` | `layouts/` | `+layout.svelte` | menyeluruh |
| Route group (tak ubah URL) | `(marketing)` | `(group)` | `(group)` | Nuxt/SvelteKit/Next |
| Folder privat (tak routable) | `_folder` | `_folder`/`-folder` | file non-`+` | menyeluruh |
| Halaman 404 kustom | `not-found.tsx` | `error.vue` | `+error.svelte` | menyeluruh |
| Error boundary per-route | `error.tsx` | `NuxtErrorBoundary` | `+error.svelte` | menyeluruh |
| Loading / skeleton | `loading.tsx` | `Suspense` | `$navigating` | Next/Nuxt |
| Metadata/head per-route | `metadata` export | `useHead` | `svelte:head` | menyeluruh |
| Akses param di komponen | prop `params` | `useRoute().params` | prop `params` | menyeluruh |
| Link prefetch | `next/link` | `NuxtLink` | `<a>` + prefetch | Next/Nuxt |
| Route paralel (`@slot`) | ya | — | — | satu-off |
| Intercepting route | `(.)folder` | — | — | satu-off |
| Adapter deploy | 3-4 | 20+ (Nitro) | 10+ | Nuxt/SvelteKit |

### 2.2 Data

| Fitur | Hampir semua framework menyebutnya | HydraScript |
|---|---|---|
| Loader sebelum render | `getServerSideProps` / `loader` / `load` / `useAsyncData` | tidak ada |
| File loader per-route | `+page.server.js` (SvelteKit) | tidak ada |
| Mutasi dari form | Server Actions / form actions / actions | tidak ada |
| Dedupe request server↔client | `useFetch` Nuxt, devalue SvelteKit | tidak ada |
| Cache / revalidate | `revalidate`, `routeRules`, ISR | tidak ada |
| Streaming + Suspense | RSC, Nitro, SvelteKit | tidak ada |
| Server Components | Next default | di luar jangkauan (compiler emit React client) |
| Islands / partial hydration | Astro | di luar jangkauan |

### 2.3 Sisi server

| Fitur | Next | Nuxt | SvelteKit |
|---|---|---|---|
| API route dalam proyek | `app/api/route.ts` | `server/api/*.ts` | `+server.ts` |
| Middleware request | `middleware.ts` / `proxy.ts` | `server/middleware/` | `hooks.server.ts` `handle` |
| Env var server vs client | `.env`, `NEXT_PUBLIC_` | `runtimeConfig`, `NUXT_` | `$env/static/private` |
| Preset deploy | Vercel dulu | Nitro (20+) | adapter (10+) |

### 2.4 DX & tooling

| Fitur | Catatan adopsi |
|---|---|
| Type generation lintas batas | SvelteKit `$types`, Next `next-env.d.ts`. **HydraScript sudah punya**: `hydra types` → `.hyx.d.ts` |
| Auto-import komponen/composable | Nuxt. Kontroversial, dan bertabrakan dengan `hydra check` yang justru mendeteksi nama tak terikat |
| HMR websocket sungguhan | Universal, dan ini yang paling dirasakan sehari-hari |
| Folder `.next/`, `.nuxt/`, `.svelte-kit/generated/` | Virtual module + manifest hasil codegen. Universal |
| CLI seragam (`dev/build/preview`) | Universal. HydraScript sudah punya |
| i18n / image / font / auth | Semua lewat modul pihak ketiga atau built-in; tidak ada yang wajib |

---

## 3. Yang khas per framework (dan kenapa)

- **Next**: dua router dalam satu produk (Pages + App) adalah warisan sejarah,
  dan App Router membawa RSC + streaming + PPR. Kompleksitasnya nyata; State of
  JS 2025 mencatat retensi Next menurun meski adopsinya memuncak.
- **Nuxt**: kekuatannya bukan sintaks, tapi Nitro (deploy universal) dan ekosistem
  modul. Auto-import menempel pada itu.
- **SvelteKit**: routing paling "kecil": tiap route = folder, file di-`+`-prefix,
  sisanya boleh di-colocate. `+server.js` menyeragamkan API dan form action.
- **Remix / React Router 7**: menolak abstraksi baru, memakai form + HTTP cache
  sebagai primitif. Sudah merge jadi React Router 7, jadi ini rute React paling
  matang setelah Next.
- **Astro**: islands + zero-JS default. Bertentangan langsung dengan model
  HydraScript (compiler sudah memutuskan React client).

---

## 4. Pemetaan ke HydraScript: murah, sedang, mahal

Biaya di bawah ini hanya menyangkut **plumbing**, bukan bahasa. Sesuai janji
README ("what changes between now and 1.0 is plumbing, not syntax"), tidak ada
satu pun usulan di sini yang menambah sintaks.

### MURAH — plumbing murni, tidak menyentuh parser/emitter

1. **Route discovery + generated manifest.**
   Scan `src/pages/**/*.hyx`, hasilkan manifest route (path, file, param).
   Ditulis ke folder build (`.hydra/routes.generated.ts`), TIDAK di-commit,
   di-inject sebagai virtual module lewat esbuild plugin yang sudah ada.
   Ini pola yang sama dengan `.svelte-kit/generated` dan `.nuxt/`.
   Sentuh: `runner.mjs` (scan + inject), `esbuild-plugin.mjs`, `scaffold.rs`
   (template jalan baru), `.gitignore`.
   Ini **prasyarat** untuk hampir semua fitur lain, jadi dikerjakan duluan.

2. **Hook runtime router.**
   `use_path()` dan `navigate()` sudah ada. Tambah `use_params()`,
   `use_search()`, `use_route()` yang membaca pola route yang di-generate.
   Sentuh: `runtime/hydra.ts` saja. Tanpa perubahan compiler.

3. **404 kustom + error boundary per-route.**
   Konvensi file `NotFound.hyx` / `Error.hyx`. Error boundary = komponen React
   biasa; `hydra` sudah punya React. Sentuh: runner + runtime.

4. **Metadata / head per-route.**
   Ekspor `meta` dari file halaman, disuntik ke `<head>` saat SSG dan diubah
   di klien saat navigasi. Ini yang bikin SSG berguna untuk SEO.
   Sentuh: runner (SSG) + runtime.

5. **SSG per-route.**
   Sekarang cuma satu `index.html`. Setelah ada manifest route, loop
   `renderToString` untuk tiap route statis → `dist/about/index.html`, dst.
   `renderToString` dan penyuntikan HTML-nya sudah ada kodenya
   (`runner.mjs` ~1090). Sentuh: runner saja.

### SEDANG — butuh server, bukan cuma bundler

6. **API routes** (`src/routes/api/hello.hys` → endpoint JSON).
   Butuh router HTTP di dev server dan target deploy non-statis. `hydra dev`
   sekarang cuma static file server + proxy. Sentuh: runner (server), plus
   keputusan format ekspor (`def get(...)`, `def post(...)`).

7. **Middleware request.**
   Bergantung pada (6). Satu file `src/middleware.hys` yang bisa membalas,
   mengubah request, atau meneruskan. Untuk versi statis, middleware bisa
   dibatasi ke rewrite/redirect yang di-bake saat build.

8. **`.env` + pemisahan rahasia.**
   Sekarang variabel cuma lewat `define` esbuild. Perlu `PUBLIC_` (di-bundle) vs
   rahasia (hanya server) — pengaman yang wajib ada sebelum API routes dipakai
   untuk apa pun yang nyata.

9. **Loader per-route.** Pilih satu model saja, jangan tiga. Rekomendasi: fungsi
   `load(params)` di file terpisah sebelah halaman, jalan di server saat SSG dan
   di klien saat navigasi. Ini yang memberi "data sebelum render" tanpa RSC.

10. **HMR websocket sungguhan.** Mengganti "rebuild 10 detik lalu refresh manual"
    dengan push + `import.meta.hot`. Nilainya besar, biayanya juga: ini menambah
    protokol yang harus dijaga selamanya.

### MAHAL / kemungkinan besar tidak layak

- **RSC, streaming SSR, islands.** Model emit HydraScript adalah React client
  biasa; ini bukan tambahan, ini ganti arsitektur. Tolak dengan sadar.
- **Route paralel & intercepting route** (Next). Fitur niche, biaya konseptual
  tinggi, dan di Next pun jarang dipakai.
- **Adapter/deploy preset ala Nitro.** Baru masuk akal kalau ada pengguna selain
  penulisnya. Sebelum itu, satu preset Node sudah cukup.
- **Auto-import ala Nuxt.** Bertabrakan langsung dengan `hydra check` yang
  mendeteksi nama tak terikat, dan dengan nilai jual "eksplisit".

---

## 5. Rekomendasi

Urutan yang aku sarankan, dengan alasan urutannya:

1. **Route discovery + manifest** (MURAH #1). Tanpa ini semua yang lain
   menggantung di konvensi yang tidak ada.
2. **Hook runtime router + layout bersarang** (MURAH #2, layout dari 2.1).
   Baru setelah ini `src/pages/` di scaffold berhenti jadi `if/elif` buatan.
3. **SSG per-route + metadata per-route** (MURAH #4, #5). Dua ini yang mengubah
   SSG dari "hampir tidak berguna" jadi alasan orang memilih Hydra.
4. **HMR websocket** (SEDANG #10) — kalau prioritasnya DX harian.
5. **API routes + `.env` + middleware** (SEDANG #6, #7, #8) sebagai satu paket.
   Jangan setengah-setengah: API route tanpa pemisahan rahasia itu jebakan.
6. Loader per-route (SEDANG #9) terakhir, setelah server-side ada.

Yang **tidak** dikerjakan, dan sebaiknya ditulis tegas di README: RSC, islands,
streaming, route paralel, adapter multi-platform.

Dua catatan bahaya yang kutemukan saat riset:

- `runtime/hydra.ts` adalah satu specifier kontrak, dan README sudah memperingatkan
  jangan menamai berkas proyek `src/hydra.hys`. Portfolio di `/var/www/hanz`
  **justru punya** `src/hydra.hys`. Begitu route discovery mulai memindai `src/`,
  bentrokan ini harus ditangani eksplisit, bukan diasumsikan tidak ada.
- `hydraconfig.json` tidak punya kunci untuk direktori route. Sebelum konvensi
  dipublikasikan, tambahkan `"routes": "./src/pages"` ke schema.json supaya tidak
  jadi konvensi yang diam-diam tersembunyi di kode.

---

## 6. Yang belum diverifikasi

- Berapa lama build + gate untuk 50+ route hasil SSG (jumlah route tidak pernah
  diuji; portfolio punya 1 halaman).
- Apakah `router-gate` (headless Chrome) masih lolos kalau HTML sudah ter-hydrate
  penuh alih-alih cangkang kosong. Gate-nya cek "empty shell", jadi
  kemungkinan aman, tapi belum dijalankan.
- Semua estimasi "sentuh file X" adalah pembacaan kode, bukan patch yang sudah
  dicoba. Tidak ada klaim "sudah jalan" di dokumen ini.
