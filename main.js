// Куда уходит анкета. Пока formEndpoint пустой, кнопка открывает Telegram с готовым текстом.
// Когда появится реле (POST JSON), вписать сюда его адрес. Токены ботов в этот файл не класть.
const CONFIG = {
  formEndpoint: "",
  telegram: "marchvlv",
};

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

/* плакат: каждая строка растянута на ширину колонки */
function fitPoster() {
  $$(".fit").forEach((line) => {
    const inner = line.firstElementChild;
    line.style.fontSize = "100px";
    const w = inner.getBoundingClientRect().width;
    if (w) line.style.fontSize = (100 * line.clientWidth / w) * 0.995 + "px";
  });
}
fitPoster();
if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitPoster);
new ResizeObserver(fitPoster).observe($(".poster"));

/* бейдж */
const form = $("#form");
const badge = $("#badge");
const bName = $("#b-name");
const bRole = $("#b-role");
const bWhat = $("#b-what");
const bDate = $("#b-date");
const bPlace = $("#b-place");

function setBadge(el, value, placeholder) {
  el.textContent = value || placeholder;
  el.classList.toggle("is-empty", !value);
}

function tick() {
  badge.classList.remove("is-tick");
  void badge.offsetWidth;
  badge.classList.add("is-tick");
}

function readForm() {
  const fd = new FormData(form);
  return {
    name: (fd.get("name") || "").trim(),
    roles: fd.getAll("role"),
    what: (fd.get("what") || "").trim(),
    telegram: normalizeTg(fd.get("telegram") || ""),
    phone: (fd.get("phone") || "").trim(),
    date: fd.get("date") || "",
    place: fd.get("place") || "",
    seek: (fd.get("seek") || "").trim(),
  };
}

function renderBadge() {
  const d = readForm();
  setBadge(bName, d.name, "твоё имя");
  bName.classList.toggle("is-mid", d.name.length > 9 && d.name.length <= 16);
  bName.classList.toggle("is-long", d.name.length > 16);
  setBadge(bRole, d.roles.join(", ").toLowerCase().replace("smm", "SMM"), "кто ты");
  bWhat.textContent = d.what;
  const dateInput = $('input[name="date"]:checked', form);
  const placeInput = $('input[name="place"]:checked', form);
  setBadge(bDate, dateInput ? dateInput.dataset.badge : "", "день");
  setBadge(bPlace, placeInput ? placeInput.dataset.badge : "", "место");
}

form.addEventListener("input", renderBadge);
form.addEventListener("change", (e) => {
  renderBadge();
  if (e.target.matches('input[type="radio"], input[type="checkbox"]')) tick();
  clearError(e.target.name);
});
renderBadge();

/* проверка */
function normalizeTg(raw) {
  let v = String(raw).trim();
  v = v.replace(/^https?:\/\/(t\.me|telegram\.me)\//i, "").replace(/^t\.me\//i, "").replace(/^@+/, "");
  return v ? "@" + v : "";
}

function setError(name, text) {
  const el = $(`[data-err="${name}"]`);
  if (!el) return;
  el.textContent = text;
  const field = el.closest(".field");
  if (field) field.classList.toggle("is-bad", Boolean(text));
}
function clearError(name) {
  const map = { name: "name", role: "role", telegram: "telegram", date: "date", place: "place" };
  if (map[name]) setError(map[name], "");
  setError("form", "");
}

function validate(d) {
  const errors = {};
  if (d.name.length < 2) errors.name = "Напиши, как к тебе обращаться.";
  if (!d.roles.length) errors.role = "Отметь хотя бы один вариант.";
  if (!/^@[A-Za-z0-9_]{4,32}$/.test(d.telegram)) errors.telegram = "Нужен ник в Telegram, например @ivanov. По нему я пришлю день и адрес.";
  if (!d.date) errors.date = "Выбери день, это твой голос.";
  if (!d.place) errors.place = "Выбери место, это твой голос.";
  return errors;
}

function anketaText(d) {
  const lines = [
    "Анкета на встречу в Вологде",
    "Имя: " + d.name,
    "Кто: " + d.roles.join(", "),
  ];
  if (d.what) lines.push("Чем занимаюсь: " + d.what);
  lines.push("Telegram: " + d.telegram);
  if (d.phone) lines.push("Телефон: " + d.phone);
  lines.push("День: " + d.date, "Место: " + d.place);
  if (d.seek) lines.push("Хочу встретить: " + d.seek);
  return lines.join("\n");
}

/* отправка */
const submitBtn = $("#submit");
const anketa = $("#anketa");
const done = $("#done");
const viaTelegram = !CONFIG.formEndpoint;
if (viaTelegram) submitBtn.textContent = "Отправить в Telegram";

function showDone(title, text, tgUrl, plain) {
  $("#done-title").textContent = title;
  $("#done-text").textContent = text;
  const tg = $("#done-tg");
  const copy = $("#done-copy");
  tg.hidden = !tgUrl;
  copy.hidden = !plain;
  if (tgUrl) tg.href = tgUrl;
  if (plain) {
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(plain);
        copy.textContent = "Анкета скопирована";
      } catch (e) {
        copy.textContent = "Не скопировалось, открой Telegram кнопкой";
      }
    };
  }
  form.classList.add("is-done");
  anketa.classList.add("is-done");
  $(".badge-stamp").textContent = tgUrl ? "почти" : "в списке";
  badge.classList.add("is-stamped");
  done.hidden = false;
  done.focus({ preventScroll: true });
  anketa.scrollIntoView({ block: "start" });
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (form.company.value) return;

  const d = readForm();
  const errors = validate(d);
  ["name", "role", "telegram", "date", "place"].forEach((k) => setError(k, errors[k] || ""));
  const firstBad = Object.keys(errors)[0];
  if (firstBad) {
    const target = $(`[data-err="${firstBad}"]`).closest(".field");
    target.scrollIntoView({ block: "center" });
    const input = $("input", target);
    if (input) input.focus({ preventScroll: true });
    return;
  }

  const text = anketaText(d);
  const tgUrl = "https://t.me/" + CONFIG.telegram + "?text=" + encodeURIComponent(text);

  if (viaTelegram) {
    window.open(tgUrl, "_blank", "noopener");
    showDone(
      "Остался один шаг",
      "Открылся Telegram с готовой анкетой. Нажми «Отправить», и ты в списке. День и адрес пришлю туда же.",
      tgUrl,
      text
    );
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = "Отправляю анкету";
  try {
    const res = await fetch(CONFIG.formEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...d, source: "vologda-networking", sentAt: new Date().toISOString() }),
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    showDone("Ты в списке", "Анкета у меня. День, время и адрес пришлю в Telegram на " + d.telegram + ".", "", "");
  } catch (err) {
    submitBtn.disabled = false;
    submitBtn.textContent = "Записаться на встречу";
    setError("form", "Анкета не ушла. Проверь интернет и нажми ещё раз.");
  }
});
