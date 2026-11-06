import { API_URL } from "./config.js";

const CATEGORIES = [
  { id: "materials", name: "Материалы" },
  { id: "work", name: "Работы" },
  { id: "delivery", name: "Доставка" },
  { id: "tools", name: "Инструмент" },
  { id: "other", name: "Прочее" },
];

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_NOTE = 200;
const MAX_KOPECKS = 9999999999;

const MIME_EXT = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

const EXT_MIME = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  pdf: "application/pdf",
};

const KNOWN_ERRORS = new Set([
  "Укажите дату.",
  "Введите сумму больше нуля, например 1500 или 1500,50.",
  "Выберите категорию.",
  "Заметка длиннее 200 символов.",
  "Файл пустой.",
  "Файл больше 10 МБ.",
  "Нужен файл JPEG, PNG, WebP или PDF.",
  "Этой записи уже нет. Обновите страницу.",
  "Чек не найден.",
  "Хранилище ещё не подключено.",
  "Не удалось выполнить действие. Проверьте соединение и попробуйте ещё раз.",
]);

const form = document.querySelector("#expense-form");
const formTitle = document.querySelector("#form-title");
const dateInput = document.querySelector("#spent-on");
const amountInput = document.querySelector("#amount");
const categoryInput = document.querySelector("#category");
const noteInput = document.querySelector("#note");
const fileInput = document.querySelector("#receipt");
const replaceHint = document.querySelector("#replace-hint");
const preview = document.querySelector("#preview");
const previewImage = document.querySelector("#preview-image");
const previewName = document.querySelector("#preview-name");
const formError = document.querySelector("#form-error");
const saveButton = document.querySelector("#save");
const cancelButton = document.querySelector("#cancel");
const totalOutput = document.querySelector("#total");
const breakdown = document.querySelector("#by-category");
const countOutput = document.querySelector("#count");
const statusOutput = document.querySelector("#status");
const emptyOutput = document.querySelector("#empty");
const list = document.querySelector("#list");

const fields = [dateInput, amountInput, categoryInput, noteInput, fileInput];

let expenses = [];
let totalKopecks = 0;
let byCategory = [];
let entryCount = 0;
let editingId = null;
let saving = false;
let previewUrl = "";

function setText(element, text) {
  element.textContent = text;
}

function todayISO() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

function isConfigured() {
  try {
    const url = new URL(API_URL);
    return url.protocol === "https:" && url.hostname.endsWith(".workers.dev");
  } catch {
    return false;
  }
}

function formatAmount(kopecks) {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
  }).format(kopecks / 100);
}

function formatDate(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return iso;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
}

function categoryName(id) {
  return CATEGORIES.find((category) => category.id === id)?.name ?? "Прочее";
}

function parseAmount(raw) {
  const text = raw.trim().replace(/\s/g, "").replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const [rubles, fraction = ""] = text.split(".");
  const kopecks = Number(rubles) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(kopecks) || kopecks <= 0 || kopecks > MAX_KOPECKS) return null;
  return kopecks;
}

function extensionOf(name) {
  const match = /\.([a-z0-9]+)$/i.exec(name);
  return match ? match[1].toLowerCase() : "";
}

function fileKind(file) {
  if (file.size <= 0) return { error: "Файл пустой." };
  if (file.size > MAX_BYTES) return { error: "Файл больше 10 МБ." };
  let mime = MIME_EXT[file.type] ? file.type : "";
  if (!mime && (file.type === "" || file.type === "application/octet-stream")) {
    mime = EXT_MIME[extensionOf(file.name)] ?? "";
  }
  if (!mime) return { error: "Нужен файл JPEG, PNG, WebP или PDF." };
  const canonical = mime === "image/jpg" ? "image/jpeg" : mime;
  return { mime: canonical, ext: MIME_EXT[canonical] };
}

function announce(message) {
  setText(statusOutput, message);
}

function setError(message) {
  if (!message) {
    formError.hidden = true;
    formError.replaceChildren();
    return;
  }
  formError.hidden = false;
  setText(formError, message);
}

function clearInvalid() {
  for (const field of fields) field.setAttribute("aria-invalid", "false");
  setError("");
}

function showFieldError(field, message) {
  for (const input of fields) input.setAttribute("aria-invalid", input === field ? "true" : "false");
  setError(message);
  field.focus();
}

function clearPreview() {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = "";
  preview.hidden = true;
  previewImage.hidden = true;
  previewImage.removeAttribute("src");
  previewName.replaceChildren();
}

function showPreview(file, kind) {
  clearPreview();
  setText(previewName, file.name);
  preview.hidden = false;
  if (kind?.mime?.startsWith("image/")) {
    previewUrl = URL.createObjectURL(file);
    previewImage.src = previewUrl;
    previewImage.hidden = false;
  }
}

function setBusy(busy) {
  for (const field of [...fields, saveButton, cancelButton]) field.disabled = busy;
  form.setAttribute("aria-busy", busy ? "true" : "false");
}

function resetForm() {
  editingId = null;
  form.reset();
  dateInput.value = todayISO();
  categoryInput.value = "materials";
  formTitle.textContent = "Новый расход";
  saveButton.textContent = "Добавить";
  cancelButton.hidden = true;
  replaceHint.hidden = true;
  clearPreview();
  clearInvalid();
}

function appError(message) {
  const error = new Error(message);
  error.appMessage = message;
  return error;
}

function knownError(message) {
  return KNOWN_ERRORS.has(message)
    ? message
    : "Не удалось выполнить действие. Проверьте соединение и попробуйте ещё раз.";
}

function readForm() {
  const spentOn = dateInput.value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(spentOn) || spentOn < "2000-01-01" || spentOn > "2100-12-31") {
    return { ok: false, field: dateInput, message: "Укажите дату." };
  }
  const kopecks = parseAmount(amountInput.value);
  if (kopecks === null) {
    return {
      ok: false,
      field: amountInput,
      message: "Введите сумму больше нуля, например 1500 или 1500,50.",
    };
  }
  const category = categoryInput.value;
  if (!CATEGORIES.some((item) => item.id === category)) {
    return { ok: false, field: categoryInput, message: "Выберите категорию." };
  }
  const note = noteInput.value.trim();
  if (note.length > MAX_NOTE) {
    return { ok: false, field: noteInput, message: "Заметка длиннее 200 символов." };
  }
  const file = fileInput.files?.[0] ?? null;
  let kind = null;
  if (file) {
    kind = fileKind(file);
    if (kind.error) return { ok: false, field: fileInput, message: kind.error };
  }
  return { ok: true, value: { spentOn, kopecks, category, note, file, kind } };
}

function receiptUrl(expense) {
  if (!/^[0-9a-f-]{36}$/.test(expense.id)) return "";
  if (!/^[0-9a-f-]{36}\.(jpg|png|webp|pdf)$/.test(expense.receipt_name ?? "")) return "";
  return `${API_URL}/api/receipts/${expense.id}/${expense.receipt_name}`;
}

function categoryTotals() {
  const totals = new Map();
  const rows = byCategory.length
    ? byCategory
    : expenses.map((expense) => ({
      category: expense.category,
      total_kopecks: expense.amount_kopecks,
    }));
  for (const row of rows) {
    if (!Number.isSafeInteger(row.total_kopecks) || row.total_kopecks <= 0) continue;
    const id = CATEGORIES.some((category) => category.id === row.category) ? row.category : "other";
    totals.set(id, (totals.get(id) ?? 0) + row.total_kopecks);
  }
  return CATEGORIES
    .map((category) => ({ name: category.name, total: totals.get(category.id) ?? 0 }))
    .filter((category) => category.total > 0);
}

function render() {
  setText(totalOutput, formatAmount(totalKopecks));
  breakdown.replaceChildren();
  for (const category of categoryTotals()) {
    const item = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = category.name;
    const amount = document.createElement("span");
    amount.className = "breakdown-amount";
    amount.textContent = formatAmount(category.total);
    item.append(name, amount);
    breakdown.append(item);
  }
  const countText = entryCount > expenses.length
    ? `Записей: ${entryCount}. В списке ${expenses.length}.`
    : `Записей: ${expenses.length}`;
  setText(countOutput, countText);
  emptyOutput.hidden = expenses.length !== 0;
  list.replaceChildren();

  for (const expense of expenses) {
    const item = document.createElement("li");
    item.dataset.id = expense.id;
    if (expense.id === editingId) item.dataset.editing = "true";

    const title = document.createElement("h3");
    setText(title, formatDate(expense.spent_on));
    item.append(title);

    const category = document.createElement("p");
    category.className = "category";
    category.textContent = categoryName(expense.category);
    item.append(category);

    if (expense.note) {
      const note = document.createElement("p");
      note.className = "note";
      setText(note, expense.note);
      item.append(note);
    }

    const amount = document.createElement("p");
    amount.className = "amount";
    setText(amount, formatAmount(expense.amount_kopecks));
    item.append(amount);

    const url = receiptUrl(expense);
    if (url) {
      const receipt = document.createElement("div");
      receipt.className = "receipt";
      if (/\.(jpg|png|webp)$/.test(expense.receipt_name)) {
        const image = document.createElement("img");
        image.src = url;
        image.alt = "";
        image.loading = "lazy";
        image.decoding = "async";
        receipt.append(image);
      }
      const link = document.createElement("a");
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "Открыть чек";
      receipt.append(link);
      item.append(receipt);
    }

    const actions = document.createElement("div");
    actions.className = "item-actions";
    const editButton = document.createElement("button");
    editButton.type = "button";
    editButton.dataset.action = "edit";
    editButton.textContent = "Изменить";
    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.dataset.action = "delete";
    deleteButton.textContent = "Удалить";
    actions.append(editButton, deleteButton);
    item.append(actions);
    list.append(item);
  }
}

function normalize(row) {
  if (!row || typeof row.id !== "string" || !/^[0-9a-f-]{36}$/.test(row.id)) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.spent_on)) return null;
  if (!Number.isSafeInteger(row.amount_kopecks)) return null;
  const receiptName = typeof row.receipt_name === "string"
    && /^[0-9a-f-]{36}\.(jpg|png|webp|pdf)$/.test(row.receipt_name)
    ? row.receipt_name
    : null;
  return {
    id: row.id,
    spent_on: row.spent_on,
    amount_kopecks: row.amount_kopecks,
    category: typeof row.category === "string" ? row.category : "other",
    note: typeof row.note === "string" ? row.note : "",
    receipt_name: receiptName,
  };
}

async function api(path, options) {
  let response;
  try {
    response = await fetch(`${API_URL}${path}`, options);
  } catch {
    throw appError("Не удалось выполнить действие. Проверьте соединение и попробуйте ещё раз.");
  }
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  if (!response.ok) throw appError(knownError(body?.error));
  return body;
}

async function loadExpenses() {
  const data = await api("/api/expenses");
  expenses = (data?.expenses ?? []).map(normalize).filter(Boolean);
  totalKopecks = Number.isSafeInteger(data?.total_kopecks)
    ? data.total_kopecks
    : expenses.reduce((sum, expense) => sum + expense.amount_kopecks, 0);
  byCategory = Array.isArray(data?.by_category)
    ? data.by_category.filter((row) => row && typeof row.category === "string" && Number.isSafeInteger(row.total_kopecks))
    : [];
  entryCount = Number.isSafeInteger(data?.count) ? data.count : expenses.length;
  render();
}

function formDataFor(value) {
  const body = new FormData();
  body.set("spent_on", value.spentOn);
  body.set("amount_kopecks", String(value.kopecks));
  body.set("category", value.category);
  body.set("note", value.note);
  if (value.file) body.set("receipt", value.file, `receipt.${value.kind.ext}`);
  return body;
}

async function createExpense(value) {
  await api("/api/expenses", { method: "POST", body: formDataFor(value) });
}

async function updateExpense(id, value) {
  await api(`/api/expenses/${id}`, { method: "PATCH", body: formDataFor(value) });
}

async function deleteExpense(id) {
  await api(`/api/expenses/${id}`, { method: "DELETE" });
}

function startEdit(expense) {
  editingId = expense.id;
  dateInput.value = expense.spent_on;
  amountInput.value = (expense.amount_kopecks / 100).toFixed(2).replace(".", ",");
  categoryInput.value = CATEGORIES.some((item) => item.id === expense.category) ? expense.category : "other";
  noteInput.value = expense.note;
  fileInput.value = "";
  clearPreview();
  clearInvalid();
  formTitle.textContent = "Изменить расход";
  saveButton.textContent = "Сохранить";
  cancelButton.hidden = false;
  replaceHint.hidden = false;
  render();
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
  form.scrollIntoView({ behavior: motion, block: "start" });
  amountInput.focus();
}

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (!file) {
    clearPreview();
    return;
  }
  const kind = fileKind(file);
  if (kind.error) {
    showPreview(file, null);
    showFieldError(fileInput, kind.error);
    return;
  }
  clearInvalid();
  showPreview(file, kind);
});

cancelButton.addEventListener("click", () => {
  resetForm();
  render();
  amountInput.focus();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (saving) return;
  if (!isConfigured()) {
    setError("Хранилище ещё не подключено.");
    return;
  }
  const parsed = readForm();
  if (!parsed.ok) {
    showFieldError(parsed.field, parsed.message);
    return;
  }
  const wasEditing = editingId !== null;
  const currentId = editingId;
  saving = true;
  setBusy(true);
  try {
    if (wasEditing) await updateExpense(currentId, parsed.value);
    else await createExpense(parsed.value);
    resetForm();
    await loadExpenses();
    announce(wasEditing ? "Расход сохранён." : "Расход добавлен.");
    amountInput.focus();
  } catch (error) {
    console.error(error);
    setError(knownError(error.appMessage));
  } finally {
    saving = false;
    setBusy(false);
  }
});

list.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button || saving) return;
  const id = button.closest("li")?.dataset.id;
  const expense = expenses.find((item) => item.id === id);
  if (!expense) return;
  if (button.dataset.action === "edit") {
    startEdit(expense);
    return;
  }
  if (button.dataset.action !== "delete") return;
  if (!confirm(`Удалить расход ${formatAmount(expense.amount_kopecks)}?`)) return;
  saving = true;
  setBusy(true);
  try {
    await deleteExpense(expense.id);
    if (editingId === expense.id) resetForm();
    await loadExpenses();
    announce("Расход удалён.");
  } catch (error) {
    console.error(error);
    setError(knownError(error.appMessage));
  } finally {
    saving = false;
    setBusy(false);
  }
});

for (const field of fields) {
  field.addEventListener("input", () => {
    if (field.getAttribute("aria-invalid") === "true") clearInvalid();
  });
}

resetForm();

if (!isConfigured()) {
  announce("Хранилище ещё не подключено.");
  saveButton.disabled = true;
} else {
  announce("Загрузка…");
  loadExpenses()
    .then(() => {
      statusOutput.replaceChildren();
    })
    .catch((error) => {
      console.error(error);
      announce(knownError(error.appMessage));
    });
}
