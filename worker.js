const CATEGORIES = new Set(["materials", "work", "delivery", "tools", "other"]);
const MAX_BYTES = 10 * 1024 * 1024;
const CHUNK_BYTES = 4000;
const UPLOAD_TTL = 60 * 60 * 24;
const EXT = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
  "image/heic": "heic",
  "image/heif": "heic",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FILE_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp|pdf|heic)$/;

function allowedOrigin(request) {
  const origin = request.headers.get("Origin");
  if (!origin) return null;
  if (origin === "https://wataplayer.github.io") return origin;
  if (/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)) return origin;
  return false;
}

function corsHeaders(origin) {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}

function json(data, status, origin) {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  };
  if (origin) Object.assign(headers, corsHeaders(origin));
  return new Response(JSON.stringify(data), { status, headers });
}

function textField(formData, name) {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

function parseKopecks(raw) {
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 9999999999) return null;
  return value;
}

function matchesMagic(bytes, mime) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (mime === "image/jpeg") {
    return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  }
  if (mime === "image/png") {
    return data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47;
  }
  if (mime === "application/pdf") {
    return data.length >= 5 && data[0] === 0x25 && data[1] === 0x50 && data[2] === 0x44 && data[3] === 0x46;
  }
  if (mime === "image/webp") {
    return data.length >= 12
      && data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46
      && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50;
  }
  if (mime === "image/heic" || mime === "image/heif") return isHeic(data);
  return false;
}

function isHeic(data) {
  if (data.length < 12) return false;
  const box = String.fromCharCode(data[4], data[5], data[6], data[7]);
  if (box !== "ftyp") return false;
  const brand = String.fromCharCode(data[8], data[9], data[10], data[11]);
  return ["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"].includes(brand);
}

function detectMime(bytes, declared) {
  const mime = declared === "image/jpg" ? "image/jpeg" : declared;
  if (EXT[mime] && matchesMagic(bytes, mime)) return mime;
  for (const candidate of Object.keys(EXT)) {
    if (matchesMagic(bytes, candidate)) return candidate;
  }
  return "";
}

function isUpload(value) {
  return Boolean(value)
    && typeof value === "object"
    && typeof value.arrayBuffer === "function";
}

function receiptName(key) {
  if (typeof key !== "string") return null;
  const name = key.slice(key.lastIndexOf("/") + 1);
  return FILE_NAME.test(name) ? name : null;
}

function publicExpense(row) {
  const name = receiptName(row.receipt_key);
  return {
    id: row.id,
    spent_on: row.spent_on,
    amount_kopecks: row.amount_kopecks,
    category: row.category,
    note: row.note,
    receipt_name: name,
    receipt_type: name ? row.receipt_type : null,
    created_at: row.created_at,
  };
}

async function readPayload(request) {
  const length = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(length) && length > MAX_BYTES + 100000) {
    return { error: "Файл больше 10 МБ.", status: 413 };
  }
  let formData;
  try {
    formData = await request.formData();
  } catch {
    return { error: "Не удалось выполнить действие. Проверьте соединение и попробуйте ещё раз.", status: 400 };
  }
  const spentOn = textField(formData, "spent_on").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(spentOn) || spentOn < "2000-01-01" || spentOn > "2100-12-31") {
    return { error: "Укажите дату.", status: 400 };
  }
  const kopecks = parseKopecks(textField(formData, "amount_kopecks").trim());
  if (kopecks === null) {
    return { error: "Введите сумму больше нуля, например 1500 или 1500,50.", status: 400 };
  }
  const category = textField(formData, "category").trim();
  if (!CATEGORIES.has(category)) return { error: "Выберите категорию.", status: 400 };
  const note = textField(formData, "note").trim();
  if (note.length > 200 || [...note].length > 200) {
    return { error: "Заметка длиннее 200 символов.", status: 400 };
  }
  const file = formData.get("receipt");
  let stored = null;
  if (isUpload(file)) {
    const size = typeof file.size === "number" ? file.size : 0;
    if (size > MAX_BYTES) return { error: "Файл больше 10 МБ.", status: 413 };
    const head = new Uint8Array(await file.slice(0, 32).arrayBuffer());
    if (head.length === 0) return { error: "Файл пустой.", status: 400 };
    const declared = typeof file.type === "string" ? file.type : "";
    const mime = detectMime(head, declared);
    if (!mime) return { error: "Нужен файл JPEG, PNG, WebP, PDF или HEIC.", status: 400 };
    const body = typeof file.stream === "function" ? file.stream() : head;
    stored = { body, mime, ext: EXT[mime] };
  }
  return { value: { spentOn, kopecks, category, note, stored } };
}

async function storeReceipt(env, expenseId, stored) {
  const key = `${expenseId}/${crypto.randomUUID()}.${stored.ext}`;
  await env.RECEIPTS.put(key, stored.body);
  return key;
}

async function discardReceipt(env, key) {
  if (!key) return;
  try {
    await env.RECEIPTS.delete(key);
  } catch (error) {
    console.error(error);
  }
}

async function listExpenses(env, origin) {
  const listed = await env.DB.prepare(
    `select id, spent_on, amount_kopecks, category, note, receipt_key, receipt_type, created_at
     from expenses
     order by spent_on desc, created_at desc
     limit 500`,
  ).all();
  const totals = await env.DB.prepare(
    "select count(*) as expense_count, coalesce(sum(amount_kopecks), 0) as total_kopecks from expenses",
  ).first();
  const grouped = await env.DB.prepare(
    "select category, coalesce(sum(amount_kopecks), 0) as total_kopecks from expenses group by category",
  ).all();
  return json({
    expenses: (listed.results ?? []).map(publicExpense),
    count: Number(totals?.expense_count ?? 0),
    total_kopecks: Number(totals?.total_kopecks ?? 0),
    by_category: (grouped.results ?? []).map((row) => ({
      category: typeof row.category === "string" ? row.category : "other",
      total_kopecks: Number(row.total_kopecks ?? 0),
    })),
  }, 200, origin);
}

async function createExpense(request, env, origin) {
  const payload = await readPayload(request);
  if (payload.error) return json({ error: payload.error }, payload.status, origin);
  const id = crypto.randomUUID();
  const { spentOn, kopecks, category, note, stored } = payload.value;
  let key = null;
  let mime = null;
  if (stored) {
    key = await storeReceipt(env, id, stored);
    mime = stored.mime;
  }
  try {
    await env.DB.prepare(
      `insert into expenses
        (id, spent_on, amount_kopecks, category, note, receipt_key, receipt_type, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, spentOn, kopecks, category, note, key, mime, new Date().toISOString()).run();
  } catch (error) {
    await discardReceipt(env, key);
    throw error;
  }
  return json({ id }, 201, origin);
}

async function updateExpense(request, env, origin, id) {
  const current = await env.DB.prepare(
    "select id, receipt_key from expenses where id = ?",
  ).bind(id).first();
  if (!current) return json({ error: "Этой записи уже нет. Обновите страницу." }, 404, origin);
  const payload = await readPayload(request);
  if (payload.error) return json({ error: payload.error }, payload.status, origin);
  const { spentOn, kopecks, category, note, stored } = payload.value;
  let key = current.receipt_key;
  let mime = null;
  let uploaded = null;
  if (stored) {
    uploaded = await storeReceipt(env, id, stored);
    key = uploaded;
    mime = stored.mime;
  }
  try {
    const updated = await env.DB.prepare(
      stored
        ? `update expenses
           set spent_on = ?, amount_kopecks = ?, category = ?, note = ?, receipt_key = ?, receipt_type = ?
           where id = ?
           returning id`
        : `update expenses
           set spent_on = ?, amount_kopecks = ?, category = ?, note = ?
           where id = ?
           returning id`,
    ).bind(
      ...(stored
        ? [spentOn, kopecks, category, note, key, mime, id]
        : [spentOn, kopecks, category, note, id]),
    ).first();
    if (!updated) {
      await discardReceipt(env, uploaded);
      return json({ error: "Этой записи уже нет. Обновите страницу." }, 404, origin);
    }
  } catch (error) {
    await discardReceipt(env, uploaded);
    throw error;
  }
  if (uploaded && current.receipt_key && current.receipt_key !== uploaded) {
    await discardReceipt(env, current.receipt_key);
  }
  return json({ id }, 200, origin);
}

async function deleteExpense(env, origin, id) {
  const current = await env.DB.prepare(
    "select receipt_key from expenses where id = ?",
  ).bind(id).first();
  if (!current) return json({ error: "Этой записи уже нет. Обновите страницу." }, 404, origin);
  await env.DB.prepare("delete from expenses where id = ?").bind(id).run();
  await discardReceipt(env, current.receipt_key);
  return json({ ok: true }, 200, origin);
}

async function readReceipt(env, origin, id, name) {
  const key = `${id}/${name}`;
  const row = await env.DB.prepare(
    "select receipt_key, receipt_type from expenses where id = ?",
  ).bind(id).first();
  if (!row || row.receipt_key !== key) return json({ error: "Чек не найден." }, 404, origin);
  const bytes = await env.RECEIPTS.get(key, { type: "arrayBuffer" });
  if (!bytes) return json({ error: "Чек не найден." }, 404, origin);
  const headers = {
    "content-type": row.receipt_type || "application/octet-stream",
    "content-disposition": "inline",
    "cache-control": "private, max-age=86400",
    "x-content-type-options": "nosniff",
  };
  if (origin) Object.assign(headers, { "access-control-allow-origin": origin, vary: "Origin" });
  return new Response(bytes, { status: 200, headers });
}

function fieldError(spentOn, kopecks, category, note) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(spentOn) || spentOn < "2000-01-01" || spentOn > "2100-12-31") {
    return "Укажите дату.";
  }
  if (kopecks === null) return "Введите сумму больше нуля, например 1500 или 1500,50.";
  if (!CATEGORIES.has(category)) return "Выберите категорию.";
  if (note.length > 200 || [...note].length > 200) return "Заметка длиннее 200 символов.";
  return "";
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

async function startUpload(request, env, origin) {
  const body = await readJson(request);
  if (!body || typeof body !== "object") {
    return json({ error: "Не удалось выполнить действие. Проверьте соединение и попробуйте ещё раз." }, 400, origin);
  }
  const spentOn = typeof body.spent_on === "string" ? body.spent_on.trim() : "";
  const kopecks = parseKopecks(String(body.amount_kopecks ?? "").trim());
  const category = typeof body.category === "string" ? body.category.trim() : "";
  const note = typeof body.note === "string" ? body.note.trim() : "";
  const invalid = fieldError(spentOn, kopecks, category, note);
  if (invalid) return json({ error: invalid }, 400, origin);
  const total = Number(body.total_bytes);
  if (!Number.isSafeInteger(total) || total < 1) return json({ error: "Файл пустой." }, 400, origin);
  if (total > MAX_BYTES) return json({ error: "Файл больше 10 МБ." }, 413, origin);
  let expenseId = null;
  if (body.expense_id) {
    if (typeof body.expense_id !== "string" || !UUID.test(body.expense_id)) {
      return json({ error: "Этой записи уже нет. Обновите страницу." }, 404, origin);
    }
    const current = await env.DB.prepare("select id from expenses where id = ?").bind(body.expense_id).first();
    if (!current) return json({ error: "Этой записи уже нет. Обновите страницу." }, 404, origin);
    expenseId = body.expense_id;
  }
  const id = crypto.randomUUID();
  const meta = {
    spent_on: spentOn,
    amount_kopecks: kopecks,
    category,
    note,
    total_bytes: total,
    content_type: typeof body.content_type === "string" ? body.content_type : "",
    received: total,
    parts: Math.ceil(total / CHUNK_BYTES),
    assembled: 0,
    expense_id: expenseId,
  };
  await env.DB.prepare(
    `insert into uploads
      (id, spent_on, amount_kopecks, category, note, total_bytes, content_type, parts, assembled, expense_id)
     values (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
  ).bind(
    id,
    meta.spent_on,
    meta.amount_kopecks,
    meta.category,
    meta.note,
    meta.total_bytes,
    meta.content_type,
    meta.parts,
    meta.expense_id,
  ).run();
  return json({ id, chunk_size: CHUNK_BYTES }, 201, origin);
}

function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return Uint8Array.from(value);
  return new Uint8Array(value);
}

async function loadUpload(env, id) {
  return env.DB.prepare(
    `select id, spent_on, amount_kopecks, category, note, total_bytes, content_type, parts, assembled, expense_id
     from uploads where id = ?`,
  ).bind(id).first();
}

async function appendChunk(request, env, origin, id, index) {
  const meta = await loadUpload(env, id);
  if (!meta) return json({ error: "Чек загрузился не полностью. Попробуйте ещё раз." }, 400, origin);
  if (!Number.isSafeInteger(index) || index < 0 || index >= meta.parts) {
    return json({ error: "Чек загрузился не полностью. Попробуйте ещё раз." }, 400, origin);
  }
  const expected = index === meta.parts - 1
    ? meta.total_bytes - index * CHUNK_BYTES
    : CHUNK_BYTES;
  const chunk = new Uint8Array(await request.arrayBuffer());
  if (chunk.byteLength !== expected) {
    return json({ error: "Чек загрузился не полностью. Попробуйте ещё раз." }, 400, origin);
  }
  await env.DB.prepare(
    `insert into upload_parts (upload_id, part_index, bytes) values (?, ?, ?)
     on conflict (upload_id, part_index) do update set bytes = excluded.bytes`,
  ).bind(id, index, chunk).run();
  return json({ ok: true, index }, 200, origin);
}

async function finishUpload(env, origin, id) {
  const meta = await loadUpload(env, id);
  if (!meta || meta.parts < 1) {
    return json({ error: "Чек загрузился не полностью. Попробуйте ещё раз." }, 400, origin);
  }
  const saved = await env.DB.prepare(
    "select count(*) as saved_parts from upload_parts where upload_id = ?",
  ).bind(id).first();
  if (Number(saved?.saved_parts ?? 0) < meta.parts) {
    return json({ error: "Чек загрузился не полностью. Попробуйте ещё раз." }, 400, origin);
  }
  const batch = 8;
  const from = meta.assembled || 0;
  const to = Math.min(meta.parts, from + batch);
  const rows = await env.DB.prepare(
    `select part_index, bytes from upload_parts
     where upload_id = ? and part_index >= ? and part_index < ?
     order by part_index`,
  ).bind(id, from, to).all();
  const parts = rows.results ?? [];
  if (parts.length !== to - from) {
    return json({ error: "Чек загрузился не полностью. Попробуйте ещё раз." }, 400, origin);
  }
  let joined;
  if (from === 0) {
    let extra = 0;
    const pieces = parts.map((row) => {
      const piece = asBytes(row.bytes);
      extra += piece.byteLength;
      return piece;
    });
    joined = new Uint8Array(extra);
    let offset = 0;
    for (const piece of pieces) {
      joined.set(piece, offset);
      offset += piece.byteLength;
    }
  } else {
    const current = await env.RECEIPTS.get(`upload/${id}/data`, { type: "arrayBuffer" });
    if (!current) return json({ error: "Чек загрузился не полностью. Попробуйте ещё раз." }, 400, origin);
    const pieces = [new Uint8Array(current), ...parts.map((row) => asBytes(row.bytes))];
    const extra = pieces.reduce((sum, piece) => sum + piece.byteLength, 0);
    joined = new Uint8Array(extra);
    let offset = 0;
    for (const piece of pieces) {
      joined.set(piece, offset);
      offset += piece.byteLength;
    }
  }
  await env.RECEIPTS.put(`upload/${id}/data`, joined);
  await env.DB.prepare("update uploads set assembled = ? where id = ?").bind(to, id).run();
  if (to < meta.parts) return json({ done: false, assembled: to, parts: meta.parts }, 200, origin);
  return commitUpload(env, origin, id, meta, joined);
}

async function commitUpload(env, origin, id, meta, bytes) {
  const mime = detectMime(bytes.subarray(0, 32), meta.content_type);
  if (!mime) return json({ error: "Нужен файл JPEG, PNG, WebP, PDF или HEIC." }, 400, origin);
  const expenseId = meta.expense_id || crypto.randomUUID();
  const receiptKey = `${expenseId}/${crypto.randomUUID()}.${EXT[mime]}`;
  await env.RECEIPTS.put(receiptKey, bytes);
  try {
    if (meta.expense_id) {
      const current = await env.DB.prepare(
        "select receipt_key from expenses where id = ?",
      ).bind(expenseId).first();
      if (!current) return json({ error: "Этой записи уже нет. Обновите страницу." }, 404, origin);
      const updated = await env.DB.prepare(
        `update expenses
         set spent_on = ?, amount_kopecks = ?, category = ?, note = ?, receipt_key = ?, receipt_type = ?
         where id = ?
         returning id`,
      ).bind(meta.spent_on, meta.amount_kopecks, meta.category, meta.note, receiptKey, mime, expenseId).first();
      if (!updated) return json({ error: "Этой записи уже нет. Обновите страницу." }, 404, origin);
      if (current.receipt_key && current.receipt_key !== receiptKey) await discardReceipt(env, current.receipt_key);
    } else {
      await env.DB.prepare(
        `insert into expenses
          (id, spent_on, amount_kopecks, category, note, receipt_key, receipt_type, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        expenseId,
        meta.spent_on,
        meta.amount_kopecks,
        meta.category,
        meta.note,
        receiptKey,
        mime,
        new Date().toISOString(),
      ).run();
    }
  } catch (error) {
    await discardReceipt(env, receiptKey);
    throw error;
  }
  await discardReceipt(env, `upload/${id}/data`);
  await env.DB.prepare("delete from upload_parts where upload_id = ?").bind(id).run();
  await env.DB.prepare("delete from uploads where id = ?").bind(id).run();
  return json({ id: expenseId }, 200, origin);
}

async function handle(request, env) {
  const origin = allowedOrigin(request);
  if (origin === false) {
    return json({ error: "Не удалось выполнить действие. Проверьте соединение и попробуйте ещё раз." }, 403, null);
  }
  if (request.method === "OPTIONS") {
    if (!origin) return new Response(null, { status: 204 });
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }

  const url = new URL(request.url);
  const path = url.pathname;
  const expenseMatch = /^\/api\/expenses\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(path);
  const uploadFinish = /^\/api\/uploads\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/finish$/.exec(path);
  const uploadPart = /^\/api\/uploads\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(\d+)$/.exec(path);
  const receiptMatch = /^\/api\/receipts\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:jpg|png|webp|pdf|heic))$/.exec(path);

  if (path === "/api/expenses" && request.method === "GET") return listExpenses(env, origin);
  if (path === "/api/expenses" && request.method === "POST") return createExpense(request, env, origin);
  if (path === "/api/uploads" && request.method === "POST") return startUpload(request, env, origin);
  if (uploadFinish && request.method === "POST") return finishUpload(env, origin, uploadFinish[1]);
  if (uploadPart && request.method === "PUT") {
    return appendChunk(request, env, origin, uploadPart[1], Number(uploadPart[2]));
  }
  if (expenseMatch && request.method === "PATCH") return updateExpense(request, env, origin, expenseMatch[1]);
  if (expenseMatch && request.method === "DELETE") return deleteExpense(env, origin, expenseMatch[1]);
  if (receiptMatch && request.method === "GET") {
    if (!UUID.test(receiptMatch[1]) || !FILE_NAME.test(receiptMatch[2])) {
      return json({ error: "Чек не найден." }, 404, origin);
    }
    return readReceipt(env, origin, receiptMatch[1], receiptMatch[2]);
  }
  return json({ error: "Не удалось выполнить действие. Проверьте соединение и попробуйте ещё раз." }, 404, origin);
}

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (error) {
      console.error(error);
      const origin = allowedOrigin(request);
      return json(
        { error: "Не удалось выполнить действие. Проверьте соединение и попробуйте ещё раз." },
        500,
        origin || null,
      );
    }
  },
};
