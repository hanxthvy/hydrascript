// [xihanzu-NR]
/**
 * HTTP intent: what a loader, an action or an API handler asked the SERVER to
 * do, as opposed to what it returned as data.
 *
 * `redirect(path)` and `fail(status, data)` from `hydra/server` are not values a
 * page should render. They are instructions. Before this module existed each
 * consumer decided for itself: `handleAction` knew about `redirect`, the loader
 * path knew about nothing, and `apiResult` treated both as ordinary JSON — so
 * `fail(401)` answered HTTP **200** with the refusal sitting in the body, and a
 * loader that redirected rendered a page with a redirect object as its props.
 *
 * One function, four call sites (action, API route, SSR render, data endpoint),
 * so a new consumer cannot invent a fifth reading of the same two shapes.
 */

/**
 * Read an intent out of a returned value, or null when the value is just data.
 *
 * Deliberately narrow. A handler that returns `{"redirect": "/x"}` as DATA —
 * a config object, say — would be misread, so the shape is checked strictly:
 * `redirect` must be a string, and a fail envelope must have an integer
 * `status` in range plus a `data` key and no `body` key (which is what
 * distinguishes it from the `{status, body}` shape `apiResult` documents).
 */
export function httpIntent(out) {
  if (!out || typeof out !== 'object' || Array.isArray(out)) return null;

  if (typeof out.redirect === 'string') {
    const status = Number.isInteger(out.status) ? out.status : 303;
    return { kind: 'redirect', status, location: out.redirect };
  }

  const hasStatus = Number.isInteger(out.status) && out.status >= 100 && out.status <= 599;
  if (hasStatus && 'data' in out && !('body' in out)) {
    return { kind: 'fail', status: out.status, data: out.data === undefined ? null : out.data };
  }

  return null;
}

/**
 * Write an intent to a node response. Returns true when it answered.
 *
 * A redirect is `Location` + the status the helper chose (303 by default, so a
 * POST becomes a GET on the next request — the behaviour a form expects).
 * A fail is the status plus the data as JSON, which is what the page needs to
 * explain itself.
 */
export function sendHttpIntent(res, intent, extraHeaders = {}) {
  if (!intent) return false;
  if (intent.kind === 'redirect') {
    res.writeHead(intent.status, { ...extraHeaders, Location: intent.location });
    res.end();
    return true;
  }
  const head = { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders };
  res.writeHead(intent.status, head);
  res.end(JSON.stringify(intent.data === null ? null : intent.data));
  return true;
}

/**
 * The framework's error envelope — ONE shape for every failure it produces.
 *
 * There used to be no shape at all: each site wrote its own object, so a client
 * saw `{error: "..."}` from a thrown handler, `{error, hint}` from a 404,
 * `{error, route, file}` from a 500, and `fail(401, {...})` answering the
 * project's own data with no wrapper. Four schemes for one question — "did this
 * request fail, and why" — and the only field they shared was `error`, whose
 * TYPE was not even stable.
 *
 * `error` stays a human string so nothing breaks; `code` is the machine field a
 * client branches on, and `detail` carries whatever the site knows (the route, a
 * limit, the file). `fail(status, data)` is deliberately NOT wrapped: that is the
 * application's answer, not the framework's complaint, and a project that wants
 * a body of its own shape must be able to have one.
 */
/**
 * Apakah pesan internal boleh keluar ke klien.
 *
 * Default: tidak, kalau NODE_ENV=production. Pesan exception memuat path
 * filesystem, nama tabel, nama modul, dan kadang potongan konfigurasi -- semua
 * itu gratis untuk pengintaian. Escaping HTML tidak menolong: yang bocor
 * bukan markup, tapi isi.
 *
 * Bisa dinyalakan lewat HYDRA_EXPOSE_ERRORS=1 untuk debugging di server yang
 * memang tidak publik. Sengaja memilih "sembunyikan" sebagai default: lupa
 * mematikan lebih berbahaya daripada lupa menyalakan.
 */
function bolehBocorDetail() {
  if (process.env.HYDRA_EXPOSE_ERRORS === '1') return true;
  return process.env.NODE_ENV !== 'production';
}

/** ID korelasi pendek: menyambungkan respons ke baris log tanpa membocorkan isi. */
function idKorelasi() {
  return Math.random().toString(36).slice(2, 10);
}

export function errorBody(code, message, detail = null, status = 500) {
  // Hanya 5xx yang disamarkan. 4xx adalah jawaban yang memang untuk pemanggil
  // ("field ini salah", "route tidak ada") -- menyembunyikannya membuat
  // framework sulit dipakai tanpa menambah keamanan apa pun, karena pesannya
  // ditulis framework, bukan berasal dari exception.
  const internal = Number(status) >= 500;
  if (!internal || bolehBocorDetail()) {
    return { error: String(message), code, ...(detail ? { detail } : {}) };
  }
  // Produksi: pesan generik + ID yang bisa dicari di log server. Pengunjung
  // tetap punya sesuatu untuk dilaporkan; penyerang tidak dapat apa-apa.
  const ref = idKorelasi();
  try {
    console.error(`[hydra] ${ref} ${code}: ${message}`, detail ?? '');
  } catch {
    /* logging tidak boleh menggagalkan respons */
  }
  return { error: 'internal error', code, ref };
}

/** Write a framework error. Returns nothing; the response is finished. */
export function sendError(res, status, code, message, detail = null, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...headers,
  });
  res.end(JSON.stringify(errorBody(code, message, detail, status)));
}

