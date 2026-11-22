<!-- [xihanzu-NR] -->
# Analisis banding: HydraScript vs meta-framework besar (Nov 2026)

Dokumen riset. Bukan kode, bukan janji. Melengkapi
[RESEARCH-META-FRAMEWORK.md](RESEARCH-META-FRAMEWORK.md) (ditulis sebelum router ada) dan
[PRODUCTION-ROADMAP.md](PRODUCTION-ROADMAP.md) (defect + rencana 1.0). Dua dokumen itu
menjawab "apa yang kurang untuk jujur". Dokumen ini menjawab **"apa yang membuat orang
memilih ini, bukan Next"** — pertanyaan yang berbeda, dan belum pernah dijawab.

Basis: repo di 0.15.1 (dibaca langsung, bukan dari README), State of JS 2025 (rilis
Feb 2026, 13.002 responden), Next.js 16.4, dan dokumen resmi Nuxt 4 / SvelteKit /
React Router 7 / Astro 5 / TanStack Start RC / NestJS 11.

---

## 1. Kondisi terverifikasi (bukan klaim README)

Yang **sudah** ada, dan ini aset nyata:

| Aset | Bukti | Kenapa penting |
|---|---|---|
| Compiler native + validasi output | `compiler-rs/src/validate.rs`, 428 tes | build tidak bisa "berhasil" dengan output yang tidak mungkin jalan |
| Compile cache content-addressed | `packages/cli/`, warm build = 0 file | DX yang tidak dimiliki esbuild mentah |
| Router file-based + konflik terdeteksi | `[slug]`, `[...rest]`, group, `_layout/_404/_error`, bentrok = error build menyebut dua file | setara SvelteKit, lebih ketat dari Nuxt |
| SSG per-route + static_params + metadata | `docs/GUIDE.md` | cukup untuk situs konten |
| SSR streaming + request context AsyncLocalStorage | `packages/cli/ssr.mjs` | di atas Remix-lite |
| Runtime gate: buka tiap HTML hasil build di Chrome sungguhan | runner | **tidak ada framework lain yang melakukan ini default** |
| Plugin esbuild + plugin Vite terpisah | `packages/cli/esbuild-plugin.mjs`, `vite-plugin/` | pintu masuk adopsi incremental — dan ini di-*undersell* total |
| `.hyx.d.ts` generator | `hydra types` | lintas batas TypeScript benar, bukan `declare module '*'` |
| `hydra check --strict` dalam build | runner | nama tak terikat = gagal build, bukan ReferenceError di produksi |

Yang **belum** ada, dan semuanya di lapisan request (diverifikasi grep, Nov 2026):

| Hilang | Bukti | Artinya |
|---|---|---|
| Cookie / session / auth | `Set-Cookie` hanya muncul di `security-p0.test.mjs` | tidak ada satu aplikasi ber-login pun bisa dibangun |
| Middleware untuk halaman | `runner.mjs:3700` — "middleware runs for requests that reach the API" | `/dashboard` tidak bisa dijaga |
| Hook siklus request | `onRequest`/`onError` milik penulis tidak ada | tidak ada logger, request id, error reporter |
| Cache / revalidate / tag | tidak ada; SSR selalu `no-store` | setiap page memukul DB setiap request |
| Route/loader test harness | `runtime/test.ts` = komponen + snapshot, tanpa DOM | bagian yang paling sering rusak tidak bisa dites |
| Realtime / SSE / WebSocket | tidak ada | tidak bisa bikin apa pun yang hidup |

Kesimpulan satu baris: **compiler-nya produk jadi, framework-nya demo.** Gap-nya bukan
sintaks dan bukan fitur parity — gap-nya tiga primitif (auth, siklus request, cache)
plus satu jalur distribusi.

---

## 2. Peta pasar, dan kenapa sekarang waktunya

State of JS 2025 (terbit Feb 2026):

- Next.js dipakai ~59% responden, tapi sentimen positif **turun 68% → 55%** — penurunan
  terbesar dari semua proyek yang disurvei. 303 keluhan "excessive complexity", 70 soal
  lock-in.
- Astro memimpin kepuasan, unggul **39 poin persen** dari Next.
- TanStack Start dapat 235 sebutan tulis-sendiri padahal belum keluar dari RC.
- 40% responden sekarang TypeScript eksklusif. "TypeScript won."
- Rata-rata developer cuma pernah pakai **2,6 framework frontend seumur karier**.

Dua bacaan dari angka itu, dan keduanya menguntungkan Hydra:

1. **Pasar tidak mencari framework baru.** Pasar mencari *jalan keluar tanpa menulis
   ulang*. Yang laku adalah yang bisa masuk ke proyek yang sudah ada.
2. **Kompleksitas adalah biaya yang sekarang dihitung orang.** Next 16.4 baru saja
   menjadikan Cache Components default — `'use cache'`, `cacheLife`, `cacheTag`,
   PPR, partial prefetching, `navigation()`, `prefetch()`, `instant = false`. Itu
   lapisan konsep baru di atas lapisan konsep sebelumnya. Framework yang menjawab
   "kamu tidak perlu mempelajari ini" punya cerita.

Artinya: bersaing di "Next tapi Pythonic" adalah bertarung di lapangan yang sudah
padat, dengan lawan yang punya 100+ engineer. Bertarung di *"React tanpa JSX, tanpa
config bundler, dan build yang bisa dibuktikan"* adalah lapangan kosong.

---

## 3. Yang layak dicuri, per framework

### Next.js 16 — ambil dua, tolak sisanya

Ambil: **prefetch pada link** (murah: manifest route sudah ada, `link` bisa
`rel=prefetch` chunk rute tujuan saat hover/idle) dan **`cacheLife` versi kecil**
(`page.cache = 60` → satu header + satu store, tanpa direktif).

Tolak: RSC, PPR, Cache Components, Server Actions sebagai model. Semua itu menuntut
resolver-based renderer — persis batas yang README sudah tulis jujur. Menambahkan
`'use cache'` ke bahasa yang sintaksnya dibekukan adalah cara termahal untuk terlihat
seperti Next.

Catatan penting: **Next 16.4 adalah pelajaran negatif yang bisa dikutip.** Mereka
menambah satu model pemrograman penuh (Cache Components) untuk memperbaiki cacat model
sebelumnya, dan butuh `next upgrade --agent` karena migrasinya tidak bisa dilakukan
manusia biasa. Itu bukan kompetitor yang perlu ditiru; itu argumen untuk Hydra.

### SvelteKit — ambil satu, yang paling murah dan paling berdampak

Ambil: **`+server.ts` menyatukan API dan form action**. Hydra sudah punya
`src/api/*.hys` dan `action` tapi sebagai dua permukaan berbeda. Satu bentuk ekspor
(`def GET/post/PUT`) untuk keduanya menghapus satu konsep, bukan menambah.

Juga ambil: **`$types`** — hydra punya `hydra types` tapi hanya props. Route params +
loader return type yang di-generate akan membuat `props["post"]["title"]` salah ketik
jadi error TypeScript. Ini perbaikan dengan nilai besar dan biaya kecil, karena
compiler sudah tahu bentuknya.

### Nuxt 4 — ambil nol, tapi pelajari satu hal

Nitro (20+ preset deploy) adalah alasan orang memilih Nuxt, dan PRODUCTION-ROADMAP
sudah benar memutuskan menolaknya sekarang. Yang layak ditiru bukan presets-nya, tapi
**`runtimeConfig`**: satu tempat untuk env yang tahu mana publik dan mana rahasia.
Hydra sudah punya `PUBLIC_`, jadi yang kurang hanya permukaan baca yang seragam
(`env.port` alih-alih `process.env.PORT` di tiga tempat).

### React Router 7 / Remix — ambil mental model, bukan kode

Yang berharga dari Remix: **form + HTTP sebagai primitif**, dan revalidasi otomatis
setelah action. Hydra sudah punya `action` + `redirect`. Yang hilang cuma satu:
setelah action sukses, loader rute itu jalan lagi tanpa reload penuh. Itu satu
`event.revalidate()` di klien, bukan arsitektur baru, dan efeknya besar — tanpa itu
setiap aplikasi CRUD menulis state management sendiri.

### Astro 5 — tolak modelnya, tiru satu hal kecil

Islands bertentangan langsung dengan keputusan emit React client, dan itu keputusan yang
benar untuk proyek ini. Yang bisa ditiru: **content collections** versi tipis — folder
`src/content/*.md` dengan schema di `hydraconfig.json`, di-type dan di-render saat build.
Murah, karena SSG per-route sudah ada. Ini yang membuat situs dokumentasi/blog tidak
perlu database, dan audiensnya persis audiens yang paling mungkin mencoba hal baru.

### TanStack Start — kompetitor paling relevan, dan pelajarannya soal tipe

TanStack menang di: **tipe end-to-end tanpa codegen**. Server function dan pemanggilnya
berbagi satu tipe. Hydra punya keunggulan yang bisa mengalahkan itu — compiler-nya
*punya* parser, jadi tipe bisa diturunkan saat compile tanpa file `.d.ts` perantara.
Ini belum dikerjakan dan seharusnya jadi janji 1.0.

### NestJS — yang paling relevan untuk sisi `.hys`, dan yang paling sering salah dibaca

NestJS bukan kompetitor frontend; dia kompetitor untuk **"bagaimana orang menulis
backend yang bisa dirawat tim"**. Yang dia jual:

| NestJS | Padanan Hydra yang murah | Biaya |
|---|---|---|
| Lifecycle (`onModuleInit`, `OnRequest`) | `on_request(event)`, `on_error(event, err)`, `on_response(event)` di `src/hooks.hys` | rendah — sudah ada runner request path |
| Guards | middleware yang mengembalikan `{status}` — perlu middleware halaman dulu | sedang |
| DI container + module boundary | **tidak perlu ditiru.** Diganti `hydra check --strict` yang sudah ada | nol |
| `nest g resource` | `hydra generate route blog/[slug]` → halaman + loader + test + entry manifest | rendah, dampak besar |
| `Test.createTestingModule` | `hydra test --route /blog/x` in-process | sedang (sudah ada di P1-4) |

Satu hal yang NestJS **tidak bisa** lakukan dan Hydra bisa: Nest menegakkan batas modul
saat runtime lewat DI — kodenya sudah bundel dan jalan sebelum errornya muncul. Hydra
punya parser. Artinya Hydra bisa menolak `import` terlarang **saat compile**:

```json
// hydraconfig.json
{ "architecture": {
    "layers": { "ui": "./src/pages", "domain": "./src/domain", "data": "./src/db" },
    "rules": ["ui -> domain", "domain -> data", "data -/-> ui"]
}}
```

`src/pages/x.hyx` yang mengimpor `src/db` = gagal build dengan pesan yang menyebut dua
file dan aturannya. Tidak ada meta-framework JS yang bisa melakukan ini, karena tidak ada
yang memiliki parser-nya. Ini pembeda yang tidak bisa dicuri Next dalam setahun.

---

## 4. Di mana Hydra sudah menang (dan belum pernah dikatakan)

Empat hal ini tidak dimiliki pesaing, dan semuanya sudah jalan hari ini:

1. **Build yang bisa dibuktikan.** Runtime gate membuka setiap HTML hasil build di
   Chrome sungguhan dan gagal kalau ada exception. Next, Nuxt, SvelteKit: tidak, secara
   default. "Build hijau berarti halamannya benar-benar hidup" adalah kalimat yang bisa
   dijual, dan tidak ada yang bisa mengklaimnya tanpa menyalin arsitekturnya.
2. **Impor yang salah = error build yang menjelaskan.** `hydra/server` di halaman,
   `PUBLIC_` di klien, nama tak terikat di `--strict`. Framework JS lain menemukan ini
   di runtime, di staging, atau di tagihan.
3. **Tidak ada konfigurasi bundler.** Tidak ada `vite.config.ts`, tidak ada
   `webpack.config.js`, tidak ada `next.config.ts` dengan 40 kunci. Satu
   `hydraconfig.json` opsional.
4. **Determinisme.** Compile in-process sub-milidetik, cache content-addressed, warm
   build nol file. Terukur, bukan klaim.

Belum pernah ada satu dari empat ini yang muncul di README sebagai *alasan memilih*.
Semuanya ditulis sebagai catatan teknis.

---

## 5. Tiga gerakan berikutnya, berurutan

Urutan ini sengaja **berbeda** dari PRODUCTION-ROADMAP, karena menjawab pertanyaan lain.
Roadmap itu soal tidak memalukan diri di produksi. Ini soal ada yang mau memakainya.

### Gerakan A — "Hydra di dalam proyek yang sudah ada" (biaya terendah, jangkauan terbesar)

Plugin Vite dan esbuild sudah ada dan sudah diekspor (`hydrascript/vite`,
`hydrascript/esbuild`). Yang tidak ada: jalan masuk yang bisa diikuti orang dalam 60 detik.

- `npx hydrascript add` → menulis `vite.config` patch, satu `hydra.d.ts`, satu
  `hydraconfig.json`, dan mencetak "sekarang tulis `.hyx` di proyekmu".
- Satu halaman dokumentasi yang isinya **hanya** itu. Bukan 967 baris README.
- Contoh nyata: `examples/into-vite/` — satu proyek Vite React standar, satu komponen
  `.hyx` di dalamnya, build jalan.

*Penerimaan:* dari folder kosong, `npm create vite`, tambah plugin, tulis satu
`Counter.hyx`, `npm run dev` — hidup dalam < 2 menit, tanpa `hydra init`.

Kenapa ini duluan: 2,6 framework per karier berarti orang tidak pindah. Tapi orang mau
menambah satu file. Svelte tumbuh persis lewat jalur ini (compile-to-JS, dipakai di
proyek yang sudah ada), dan Next tidak punya jalur ini sama sekali.

### Gerakan B — Auth dalam 20 baris (gerbang kelayakan)

Cookie, session bertanda tangan, `require_user()` di loader/action/middleware halaman,
dan middleware yang berlaku untuk **halaman**, bukan cuma API. Ini P0-6 dan P1-1 di
roadmap lama; di sini ditulis ulang sebagai *satu contoh yang jalan*:

```
src/pages/dashboard.hyx          # halaman yang dijaga
src/pages/login.hyx              # form; action menulis session
src/middleware.hys               # redirect("/login") kalau tidak ada user
```

*Penerimaan:* `examples/auth/` — login, logout, halaman terjaga, sesi tamper = `null`,
dan satu tes yang meng-curl tiga request. Kalau contoh ini tidak ada di repo, klaim
"bisa untuk produksi" tidak punya bukti yang bisa dijalankan orang.

### Gerakan C — `hydra verify`: jadikan gate sebagai produk

Runtime gate sekarang internal, dan hasilnya cuma "lulus/gagal". Naikkan jadi perintah
yang bisa dijalankan siapa pun dan hasilnya bisa ditunjukkan ke orang lain:

```
$ hydra verify
  ✔ 24/24 halaman termuat tanpa exception (Chrome 141)
  ✔ hidrasi bersih di 24/24
  ✔ 0 tautan internal mati (dari 312)
  ⚠ /pricing — root kosong, body tidak punya teks
  ✖ /blog/x — aksesibilitas: 2 pelanggaran serius (color-contrast, label)
  ✔ anggaran: entry 61 KB / 80 KB, 8 chunk / 12
```

Tiga bagian yang belum ada dan murah: cek tautan internal, axe-core, anggaran ukuran.
Sisanya sudah dijalankan.

Kenapa ini gerakan, bukan polish: ini satu-satunya fitur yang **tidak bisa disalin**
tanpa membangun ulang arsitekturnya, dan hasilnya adalah artefak yang orang tempel di
PR. Tidak ada pemasaran yang lebih baik daripada output terminal yang hijau.

---

## 6. Yang harus ditolak, dengan alasan yang bisa diucapkan di publik

| Tolak | Alasan satu baris |
|---|---|
| RSC / Server Components | output compiler adalah React client; ini ganti arsitektur, bukan fitur |
| Cache Components / `'use cache'` | direktif = sintaks baru; sintaks dibekukan, dan modelnya sendiri sedang bermasalah di Next |
| Islands / partial hydration | kebalikan dari keputusan emit; kalau mau itu, pakai Astro |
| Adapter edge / serverless multi-platform | abstraksi sebelum primitifnya ada = bentuk yang salah dibekukan (kesalahan `pages/` middleware Next) |
| Auto-import ala Nuxt | bertabrakan langsung dengan `hydra check` yang mendeteksi nama tak terikat |
| Auth bawaan lengkap (OAuth, SSO) | sesi + cookie adalah primitif; OAuth adalah library. Berhenti di primitif |
| GraphQL / WebSocket / microservices ala Nest | permukaan dukungan permanen untuk nilai yang tidak membedakan |

Yang **tidak** ditolak tapi ditunda sampai ada pengguna kedua: i18n routing, image
optimization, font subsetting (P1-6, P1-7 lama). Semuanya bisa dikerjakan userland atau
plugin, dan tidak ada satu pun yang membuat orang berkata "oh, ini bisa".

---

## 7. Risiko yang harus dihadapi, bukan dihindari

1. **Tidak ada yang tahu proyek ini ada.** Ini risiko terbesar, lebih besar dari semua
   item teknis di atas. npm dengan 0 unduhan tidak akan menjadi framework apa pun.
   Mitigasinya bukan fitur — Gerakan A.
2. **Bus factor 1.** Satu orang, 428 tes, tujuh target binary. Setiap fitur baru menambah
   beban yang harus dijaga selamanya. Ini argumen kuat untuk "tolak" di bagian 6,
   dan argumen untuk `hydra verify` (yang memindahkan sebagian kepercayaan dari manusia
   ke mesin).
3. **Sintaks Pythonic adalah filter audiens, bukan magnet.** Sebagian orang menyukainya,
   sebagian besar developer React tidak peduli. Audiens yang paling mungkin: orang
   Python (Django/FastAPI) yang butuh React dan benci JSX. Itu audiens yang nyata, dan
   di situlah kata "Pythonic" harus diucapkan — bukan ke audiens JSX.
4. **Klaim 428 tes + 255 tes adalah aset yang rapuh.** Begitu satu suite di-skip,
   angkanya jadi kebohongan. Angka-angka di README harus dihasilkan CI, bukan diketik.

---

## 8. Ringkas

Jangan kejar parity. Parity dengan Next sudah kalah sebelum dimulai, dan Next sendiri
sedang kehilangan kepuasan karena parity itu.

Yang dimiliki Hydra dan tidak dimiliki siapa pun: **compiler sendiri, gate yang membuka
browser sungguhan, dan build yang bisa dibuktikan.** Tiga hal itu belum pernah dijual.

Yang harus dikerjakan supaya itu ada gunanya: masuk ke proyek yang sudah ada (A), bisa
menulis login (B), dan bukti yang bisa ditempel di PR (C). Sesudah itu, arsitektur yang
ditegakkan saat compile (bagian 3, NestJS) adalah hal yang tidak bisa disalin siapa pun
dalam setahun — dan itu bisa jadi 1.0.
