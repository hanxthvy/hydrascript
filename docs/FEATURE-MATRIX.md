<!-- [xihanzu-NR] -->
# Matriks fitur: basic → exclusive, dan mana yang menambah nilai

Bukan perbandingan popularitas. Ini inventaris fitur, dari yang wajib supaya tidak
dianggap mainan, sampai yang cuma satu-dua framework punya, plus yang **belum ada di
framework mana pun** dan hanya bisa dibuat di sini karena compiler-nya milik sendiri.

Kolom status Hydra diverifikasi dari kode di 0.15.1 (grep + baca runner/runtime), bukan
dari README. Kalau tulisannya "belum kuuji", artinya kodenya ada tapi perilakunya tidak
kusentuh di sesi ini.

Legenda verdict: **AMBIL** = menambah nilai nyata · **TUNDA** = bagus, setelah ada
pengguna kedua · **TOLAK** = biaya permanen > nilai · **SUDAH** = tidak perlu apa-apa.

---

## Tier 0 — higiene dasar (tanpa ini bukan framework)

| Fitur | Punya siapa | Hydra | Verdict |
|---|---|---|---|
| Routing file-based, param, catch-all | semua | ada | SUDAH |
| Nested layout, route group | semua | ada | SUDAH |
| 404 dan error boundary | semua | `_404.hyx`, `_error.hyx` | SUDAH (batas error 500 sisi server masih lemah) |
| Metadata/head per route | semua | `meta`, `metadata(event)` | SUDAH |
| SSG per route | semua | ada | SUDAH |
| SSR route dinamis | semua | ada | SUDAH |
| Per-route code splitting | semua | `lazyPages` | SUDAH |
| Env: publik vs rahasia | semua | `PUBLIC_`, ditegakkan saat build | SUDAH — ini di atas rata-rata |
| Header keamanan | semua | ada, tapi di 0.15.0 hanya untuk file statis | **perlu dicek di 0.15.1** |
| Rate limit | jarang built-in | per-IP, trusted proxy | SUDAH (justru eksklusif) |
| Origin check pada mutasi | sebagian | action + API | SUDAH |
| Dev/build/preview | semua | ada | SUDAH |
| Config tervalidasi | sebagian besar tidak | `config.mjs` ada | SUDAH (belum kuuji perilaku) |
| Static serving aman (dotfile, symlink) | sebagian | ada | SUDAH |
| gzip/brotli | semua | gzip | SUDAH |
| Subpath deploy (`base`) | sebagian | ada | SUDAH |

Tier 0 Hydra sudah lengkap. Ini penting: tidak ada pekerjaan dasar yang menahan.

---

## Tier 1 — standar meta-framework 2020-an

| Fitur | Punya siapa | Hydra | Verdict | Nilai |
|---|---|---|---|---|
| API route dalam proyek | Next, Nuxt, SvelteKit | `src/api/*.hys` | SUDAH | — |
| Form action + redirect | Remix, SvelteKit, Next | `action`, `redirect` | SUDAH | — |
| Revalidasi loader setelah action | Remix, SvelteKit (wajib di sana) | **tidak** | **AMBIL** | tinggi: tanpa ini setiap CRUD menulis state sendiri |
| Middleware untuk halaman | semua | **hanya `/api`** | **AMBIL** | tinggi: `/dashboard` tidak bisa dijaga |
| Cookie / session / auth | semua | **tidak ada** | **AMBIL** | tertinggi: gerbang "layak dipakai" |
| Test rute + loader in-process | SvelteKit, Remix, Nuxt | komponen + snapshot saja | **AMBIL** | tinggi |
| DOM di test | semua | tidak | AMBIL (bareng di atas) | sedang |
| Tipe rute (`params`, return loader) | SvelteKit `$types`, TanStack | props saja | **AMBIL** | tinggi, biaya rendah |
| Prefetch saat hover | Next, Nuxt, TanStack | **tidak** | **AMBIL** | sedang-tinggi, biaya rendah |
| Scroll restoration | semua | **tidak** | AMBIL | rendah, tapi terasa |
| View Transitions | Next 16, Astro, SvelteKit | **tidak** | TUNDA | rendah (API browser sudah ada) |
| Sitemap + robots otomatis | Next, Nuxt, Astro | **tidak** | AMBIL | rendah, murah, SEO |
| i18n routing | semua | **tidak** | TUNDA | sedang |
| Image optimization (`srcset`, AVIF) | Next, Nuxt, Astro | **tidak** | TUNDA | tinggi nilainya, tinggi biayanya |
| Font self-host + preload | Next, Nuxt | **tidak** | TUNDA | sedang |
| Progressive enhancement (form jalan tanpa JS) | Remix/RR7 (jualan utama) | **belum kuuji** | AMBIL kalau belum | tinggi: satu-satunya pembeda Remix yang murah |
| Error overlay dev | semua | ada | SUDAH | — |
| Fast Refresh jaga state | semua | ada (dengan virtualisasi CJS yang rapuh) | SUDAH, kandidat diganti | — |
| LSP (hover, def, rename, completion) | sebagian | ada | SUDAH | di atas rata-rata |
| Plugin bundler (Vite/esbuild) | semua | ada, **tidak dipromosikan** | **JUAL** | tertinggi per rupiah |
| Deploy target | Nitro 20+, adapter 10+ | static + node | TOLAK menambah sekarang | — |

---

## Tier 2 — ekspektasi 2026

| Fitur | Punya siapa | Hydra | Verdict |
|---|---|---|---|
| Cache/revalidate berbasis waktu | Next (`revalidate`), Nuxt `routeRules`, SvelteKit | **tidak** | **AMBIL** (versi kecil: `page.cache = 60`) |
| Cache tag / invalidasi on-demand | Next `cacheTag`, Nuxt | tidak | TUNDA |
| ETag/304 untuk HTML | hampir semua | hanya file statis | AMBIL — murah, satu fungsi |
| ISR / stale-while-revalidate | Next (eksklusif praktisnya) | tidak | TUNDA |
| PPR (shell statis + lubang dinamis) | Next 16 saja | tidak | **TOLAK** |
| RSC | Next, (Waku) | tidak | **TOLAK** |
| Islands / partial hydration | Astro, Fresh | tidak | TOLAK |
| Resumability | Qwik | tidak | TOLAK (model berbeda total) |
| Server function bertipe end-to-end | TanStack Start (tanpa codegen), Next (dengan codegen) | tidak | **AMBIL** — bisa lebih baik dari keduanya, lihat Tier 4 |
| Hook siklus request (`onRequest`/`onError`) | semua yang serius | **tidak** | **AMBIL** — tanpa ini tidak bisa di-on-call |
| Observability / access log terstruktur | lewat integrasi, bukan semua | tidak | AMBIL |
| Error reporting hook + frame `.hyx` | semua lewat SDK | tidak | AMBIL |
| CSP nonce | Next, Nuxt | tidak | AMBIL (sudah tercatat di roadmap lama) |
| CORS terkonfigurasi | semua | tidak (hanya lewat header manual) | AMBIL, murah |
| Bundle budget di CI | sebagian | `analyze` ada, budget tidak | AMBIL |
| A11y gate | hampir tidak ada yang default | tidak | **AMBIL** — langka, dan gate sudah ada |
| Realtime (SSE/WebSocket) | SvelteKit (via adapter), Nuxt (Nitro), Hono | tidak | TUNDA |
| Codemod resmi | Next (`next upgrade --agent`), Angular (terbaik) | tidak | AMBIL (parser = murah) |
| DevTools panel | Next, Nuxt | tidak | TOLAK (biaya besar, nilai kecil) |
| Multi-instance / cluster | lewat orchestrator | single process | TUNDA |
| Graceful shutdown / drain | semua | 5 detik hard | AMBIL, murah |

---

## Tier 3 — eksklusif milik mereka (yang jarang, dan kenapa)

Bukan untuk ditiru semua. Ini daftar "hal yang bikin orang memilih framework itu",
supaya jelas mana yang benar-benar pembeda dan mana yang cuma fitur.

| Framework | Fitur eksklusif | Kenapa orang mau | Layak diambil? |
|---|---|---|---|
| Next | PPR + Cache Components | halaman personalisasi yang tetap instan | tidak — butuh resolver renderer |
| Next | Intercepting/parallel routes | modal sebagai URL | tidak — nisab, biaya konsep tinggi |
| Nuxt | Nitro (20+ preset deploy) | deploy ke mana saja tanpa ubah kode | tidak, sampai ada pengguna |
| Nuxt | Modul ekosistem | satu baris `npx nuxi module add` | **ide bagus, bentuk lain**: registry plugin hydra |
| SvelteKit | `+server.ts` seragam untuk API dan action | satu konsep, bukan dua | **ya** — hydra punya dua permukaan |
| SvelteKit | Form snapshot (`snapshot` export) | isian form selamat saat navigasi | ya, murah |
| Remix/RR7 | Form jalan tanpa JavaScript | aplikasi yang tahan jaringan buruk | **ya**, dan bisa jadi pembeda |
| Remix/RR7 | `single fetch` (satu request per navigasi) | navigasi cepat | ya, murah kalau manifest rapi |
| Astro | Content collections | blog/docs tanpa database | **ya**, cocok dengan SSG yang sudah ada |
| Astro | Zero-JS by default | skor performa | tidak (model bertentangan) |
| TanStack | Tipe end-to-end tanpa codegen | refactor aman | **ya**, dan hydra bisa lebih baik |
| TanStack | Validasi search param (zod) | URL sebagai state yang sah | ya, murah |
| NestJS | DI container + module | tim besar, struktur | tidak — diganti aturan arsitektur compile-time |
| NestJS | `nest g resource` | scaffold konsisten | **ya** — `hydra generate` |
| NestJS | Guard/interceptor/pipe | irisan lintas fitur | ya, dalam bentuk middleware + hook |
| Qwik | Resumability | TTI tanpa hidrasi | tidak |

---

## Tier 4 — yang hanya Hydra bisa, karena punya parser (dan belum ada di siapa pun)

Ini bagian yang menjawab "apa yang menambah nilai". Semua di bawah ini mustahil atau
mahal di framework lain, karena mereka menyerahkan parsing ke TypeScript/Babel dan hanya
melihat output bundler. Hydra melihat AST, dan melihat **dua sisi sekaligus** (server dan
klien) dalam satu proses.

### 4.1 Aturan arsitektur yang ditegakkan saat compile — nilai tertinggi

```json
{ "architecture": {
    "layers": { "ui": "./src/pages", "domain": "./src/domain", "data": "./src/db" },
    "rules": ["ui -> domain", "domain -> data", "data -/-> ui"]
}}
```

`src/pages/x.hyx` yang mengimpor `src/db` = **gagal build**, pesan menyebut dua file dan
aturan yang dilanggar. NestJS menegakkan batas modul saat runtime; ESLint bisa menegakkan
sebagian, tapi buta terhadap `.hys` yang diimpor dan buta terhadap ekspor yang dikonsumsi.
Hydra bisa, dan tidak bisa disalin orang lain tanpa menulis compiler sendiri.
Biaya: sedang (graf impor sudah ada untuk `PUBLIC_` dan `hydra/server`). Ini bahan 1.0.

### 4.2 Kontrak tipe loader → halaman tanpa codegen — nilai tinggi

Compiler tahu `loader` mengembalikan apa (karena `.server.hys` ada di pohon yang sama) dan
tahu halaman membaca `props["post"]["title"]`. Jadi `props["post"]["titel"]` bisa jadi
**error compile**, bukan `undefined` di produksi. TanStack butuh tipe TS untuk ini; Next
butuh codegen; Hydra bisa tanpa keduanya. Ini klaim yang bisa diucapkan di README dan
tidak ada yang bisa mengklaimnya.

### 4.3 Kontrak form ↔ action saat compile

`form(action="/login")` dengan dua input, dan `def action(ctx)` yang membaca
`ctx["form"]["email"]` dan `ctx["form"]["password"]`. Compiler punya keduanya. Field yang
tidak cocok, field wajib yang hilang, dan field yang dibaca tapi tidak pernah dikirim =
error build. Tidak ada framework JS yang melakukan ini karena form-HTML dan handler-nya
berada di dua bahasa berbeda.

### 4.4 `hydra explain` — build yang bisa ditanyai

```
$ hydra explain /blog/x
/blog/x  → SSR (punya loader, tidak ada static_params)
  chunk   : 14 KB gzip (react-dom 41 KB shared)
  why SSR: blog/[slug].server.hys mendefinisikan loader tanpa static_params
  gate    : lolos, 0 exception, hidrasi bersih
```

Pertanyaan "kenapa halaman ini tidak statis" adalah pertanyaan yang paling sering ditanya
pemula Next, dan jawabannya tersebar di dokumen. Di sini jawabannya bisa dihasilkan mesin,
karena keputusannya memang dibuat mesin.

### 4.5 `hydra verify` — gate sebagai produk

Gate sekarang internal, outputnya lulus/gagal. Naikkan jadi perintah dengan tiga tambahan
murah (cek tautan internal, axe-core, anggaran ukuran) dan output yang bisa ditempel di PR:

```
✔ 24/24 halaman termuat tanpa exception (Chrome 141)
✔ hidrasi bersih 24/24
✔ 0 tautan internal mati (312 diperiksa)
✖ /blog/x — a11y: 2 pelanggaran serius (color-contrast, label)
✔ anggaran: entry 61 KB / 80 KB
```

Satu-satunya fitur di seluruh daftar ini yang tidak bisa disalin tanpa membangun ulang
arsitektur.

### 4.6 `hydra test --route` yang di-generate dari manifest

Untuk setiap rute: 200, tidak ada exception, `meta` ada, tidak ada tautan mati. Ditambah
tes khusus yang ditulis manusia. Artinya proyek baru punya 20 tes kontrak tanpa menulis
satu baris — dan ini yang membuat orang berani refactor.

### 4.7 Ekstraksi i18n saat compile

`t("nav.home")` di `.hyx` → katalog dikumpulkan compiler saat build, tanpa scanner
runtime, tanpa regex terhadap teks. Kunci yang tidak ada di katalog = error build. Ini
fitur yang di Nuxt/Next butuh plugin dan tetap rapuh.

### 4.8 Codemod struktural (`hydra migrate`)

Punya parser = bisa menulis ulang AST, bukan regex. `hydra migrate 0.16 1.0` yang benar
dan tidak merusak string yang kebetulan mirip kode. Ini yang membuat janji "setiap
breaking change punya codemod" bisa ditepati tanpa kerja manual selamanya.

### 4.9 Deteksi kode mati lintas `.hyx`

Komponen yang tidak diimpor siapa pun, prop yang tidak pernah dibaca, helper runtime yang
tidak dipanggil proyek. Compiler punya grafnya; bundler cuma punya hasil setelah di-tree-shake.

### 4.10 `hydra doctor --fix`

`doctor` sekarang melaporkan. `--fix` bisa memperbaiki yang deterministik: config yang
salah tipe, `hydraconfig.json` yang melanggar schema, import yang seharusnya
`hydra/server`, `.gitignore` yang belum memuat `.hydra/`.

---

## Skor: nilai per biaya

| # | Fitur | Tier | Nilai | Biaya | Skor |
|---|---|---|---|---|---|
| 1 | Cookie/session + middleware halaman | 1 | 10 | sedang | **10/6** |
| 2 | Jual plugin Vite/esbuild (adopsi incremental) | 1 | 9 | sangat rendah | **9/2** |
| 3 | `hydra verify` (gate + link + axe + budget) | 4.5 | 9 | rendah | **9/3** |
| 4 | Aturan arsitektur compile-time | 4.1 | 8 | sedang | **8/5** |
| 5 | Revalidasi loader setelah action | 1 | 8 | rendah | **8/3** |
| 6 | Tipe rute + kontrak loader→halaman | 1 + 4.2 | 8 | sedang | **8/5** |
| 7 | `hydra test --route` + DOM | 4.6 | 7 | sedang | **7/5** |
| 8 | Hook `on_request`/`on_error` + log | 2 | 7 | rendah | **7/3** |
| 9 | Prefetch link + scroll restoration | 1 | 5 | rendah | **5/2** |
| 10 | Sitemap/robots | 1 | 4 | sangat rendah | **4/1** |
| 11 | `hydra explain` | 4.4 | 6 | rendah | **6/3** |
| 12 | Content collections | 3 | 6 | sedang | **6/5** |
| 13 | Form↔action compile contract | 4.3 | 6 | tinggi | **6/7** |
| 14 | Image optimization | 1 | 7 | tinggi | **7/7** |
| 15 | i18n routing | 1 | 5 | tinggi | **5/7** |

Urutannya sudah terbaca dari tabel itu: 2 → 1 → 3 → 5 → 8 → 6 → 4.

---

## Yang tetap ditolak, tanpa ragu

RSC, PPR, Cache Components, islands, resumability, adapter multi-platform, DI container,
auto-import, GraphQL/WebSocket/microservices, DevTools panel. Semuanya permukaan dukungan
permanen untuk nilai yang tidak membedakan — dan separuhnya justru sumber keluhan yang
membuat Next kehilangan kepuasan.

---

## Ringkas

Basic-nya sudah lengkap; yang kurang di Tier 1 punya penyebab yang sama — lapisan request
belum punya identitas (cookie, lifecycle, cache). Exclusive yang layak dikejar bukan
fitur Next, tapi yang lahir dari parser sendiri: arsitektur yang ditegakkan saat compile,
kontrak tipe loader→halaman, form↔action, dan `hydra verify`. Empat itu tidak bisa
disalin orang lain tanpa membangun ulang compiler — dan tidak satu pun dari mereka
memilikinya.
