const CURRENCIES = [
  { code: "RUB", name: "Российский рубль" },
  { code: "USD", name: "Доллар США" },
  { code: "EUR", name: "Евро" },
  { code: "GBP", name: "Фунт стерлингов" },
  { code: "CNY", name: "Китайский юань" },
  { code: "KZT", name: "Казахстанский тенге" },
  { code: "BYN", name: "Белорусский рубль" },
];

const FALLBACK_RATES = {
  usd: 1,
  eur: 0.92,
  gbp: 0.78,
  cny: 7.1,
  rub: 95,
  kzt: 490,
  byn: 3.27,
};

const API_URL =
  "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.min.json";

const amountInput = document.querySelector("#amount");
const fromSelect = document.querySelector("#from");
const toSelect = document.querySelector("#to");
const swapButton = document.querySelector("#swap");
const hint = document.querySelector("#hint");
const result = document.querySelector("#result");
const rateLine = document.querySelector("#rate");
const inverseLine = document.querySelector("#inverse");
const meta = document.querySelector("#meta");

const quotes = {
  rates: { ...FALLBACK_RATES },
  date: null,
  fallback: true,
};

function withNums(text) {
  return String(text).replace(/\d+/g, (digits) => `<span class="num">${digits}</span>`);
}

function codeHtml(code) {
  return `<span translate="no">${code}</span>`;
}

function formatAmount(value) {
  return new Intl.NumberFormat("ru-RU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatRate(value) {
  const abs = Math.abs(value);
  const digits = abs >= 100 ? 2 : abs >= 1 ? 4 : 6;
  return new Intl.NumberFormat("ru-RU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: digits,
  }).format(value);
}

function formatRateDate(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return iso;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
}

function parseAmount(raw) {
  const text = raw.trim().replace(/\s/g, "").replace(",", ".");
  if (text === "") return null;
  const value = Number(text);
  if (!Number.isFinite(value)) return null;
  return value;
}

function isCurrency(code) {
  return CURRENCIES.some((currency) => currency.code === code);
}

function fillSelect(select, selected) {
  select.replaceChildren();
  for (const currency of CURRENCIES) {
    const option = document.createElement("option");
    option.value = currency.code;
    option.textContent = `${currency.code} — ${currency.name}`;
    select.append(option);
  }
  select.value = selected;
}

function applyParams() {
  const params = new URLSearchParams(location.search);
  const amount = params.get("amount");
  const from = params.get("from");
  const to = params.get("to");
  if (amount !== null) amountInput.value = amount;
  if (isCurrency(from)) fromSelect.value = from;
  if (isCurrency(to)) toSelect.value = to;
}

function syncUrl() {
  const params = new URLSearchParams(location.search);
  params.set("amount", amountInput.value);
  params.set("from", fromSelect.value);
  params.set("to", toSelect.value);
  const next = `${location.pathname}?${params.toString()}`;
  if (`${location.pathname}${location.search}` !== next) {
    history.replaceState(null, "", next);
  }
}

function rateOf(code) {
  const key = code.toLowerCase();
  const value = quotes.rates[key];
  return typeof value === "number" && value > 0 ? value : null;
}

function pairRate(from, to) {
  const fromRate = rateOf(from);
  const toRate = rateOf(to);
  if (fromRate === null || toRate === null) return null;
  return toRate / fromRate;
}

function render(options = {}) {
  const amount = parseAmount(amountInput.value);
  const from = fromSelect.value;
  const to = toSelect.value;
  amountInput.setAttribute("aria-invalid", amount === null ? "true" : "false");

  if (amount === null) {
    hint.hidden = false;
    result.textContent = "";
    rateLine.textContent = "";
    inverseLine.textContent = "";
    meta.textContent = "";
    if (options.sync !== false) syncUrl();
    return;
  }

  hint.hidden = true;
  const direct = pairRate(from, to);
  if (direct === null) {
    result.textContent = "Нет курса для этой пары. Выберите другие валюты.";
    rateLine.textContent = "";
    inverseLine.textContent = "";
    meta.textContent = "";
    if (options.sync !== false) syncUrl();
    return;
  }

  const converted = amount * direct;
  const inverse = direct === 0 ? null : 1 / direct;

  result.innerHTML = withNums(`${formatAmount(converted)}\u00A0${codeHtml(to)}`);
  rateLine.innerHTML = withNums(`1\u00A0${codeHtml(from)} = ${formatRate(direct)}\u00A0${codeHtml(to)}`);
  inverseLine.innerHTML =
    inverse === null
      ? ""
      : withNums(`1\u00A0${codeHtml(to)} = ${formatRate(inverse)}\u00A0${codeHtml(from)}`);

  if (quotes.fallback) {
    meta.textContent = "Показан запасной курс";
  } else {
    meta.innerHTML = withNums(`Курс на ${formatRateDate(quotes.date)}`);
  }

  if (options.sync !== false) syncUrl();
}

function hasNeededRates(rates) {
  return CURRENCIES.every((currency) => {
    const key = currency.code.toLowerCase();
    return key === "usd" || (typeof rates[key] === "number" && rates[key] > 0);
  });
}

async function loadRates() {
  try {
    const response = await fetch(API_URL);
    if (!response.ok) throw new Error(String(response.status));
    const data = await response.json();
    if (!data.usd || !hasNeededRates(data.usd) || typeof data.date !== "string") {
      throw new Error("incomplete");
    }
    quotes.rates = { usd: 1, ...data.usd };
    quotes.date = data.date;
    quotes.fallback = false;
  } catch {
    quotes.rates = { ...FALLBACK_RATES };
    quotes.date = null;
    quotes.fallback = true;
  }
  render();
}

fillSelect(fromSelect, "RUB");
fillSelect(toSelect, "USD");
applyParams();

amountInput.addEventListener("input", () => render());
fromSelect.addEventListener("change", () => render());
toSelect.addEventListener("change", () => render());
swapButton.addEventListener("click", () => {
  const nextFrom = toSelect.value;
  toSelect.value = fromSelect.value;
  fromSelect.value = nextFrom;
  render();
});
document.querySelector("#converter").addEventListener("submit", (event) => {
  event.preventDefault();
});
window.addEventListener("popstate", () => {
  applyParams();
  render({ sync: false });
});

render();
loadRates();
