// Приёмник анкет встречи в Вологде и админка к ним.
// Без зависимостей: node:http + встроенный node:sqlite (Node 22.13+).
// Пароль админки приходит из окружения (EnvironmentFile на сервере), в репозитории его нет.
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8797);
const DB_PATH = process.env.DB_PATH || join(HERE, "leads.db");
const ADMIN_USER = process.env.ADMIN_USER || "";
const ADMIN_PASS = process.env.ADMIN_PASS || "";
const SITE_URL = process.env.SITE_URL || "https://shumniyvlad-cell.github.io/vologda-networking/";
const ORIGINS = (process.env.ALLOWED_ORIGINS || "https://shumniyvlad-cell.github.io,http://localhost:8796")
  .split(",").map((s) => s.trim()).filter(Boolean);
const MAX_LEADS = 5000;

const ROLES = ["Предприниматель", "Эксперт", "SMM", "Оператор", "Контент-мейкер", "Другое"];
const DATES = ["28 октября", "29 октября", "Любой из двух дней"];
const PLACES = ["Коворкинг", "Ресторан", "Без разницы"];

const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    name TEXT NOT NULL,
    roles TEXT NOT NULL,
    what TEXT NOT NULL DEFAULT '',
    telegram TEXT NOT NULL,
    tg_key TEXT NOT NULL UNIQUE,
    phone TEXT NOT NULL DEFAULT '',
    date TEXT NOT NULL,
    place TEXT NOT NULL,
    seek TEXT NOT NULL DEFAULT '',
    deleted INTEGER NOT NULL DEFAULT 0
  );
`);

// согласие на показ в каталоге появилось позже первой версии базы
if (!db.prepare("PRAGMA table_info(leads)").all().some((c) => c.name === "catalog")) {
  db.exec("ALTER TABLE leads ADD COLUMN catalog INTEGER NOT NULL DEFAULT 0");
}

const upsert = db.prepare(`
  INSERT INTO leads (created_at, updated_at, name, roles, what, telegram, tg_key, phone, date, place, seek, catalog, deleted)
  VALUES (@now, @now, @name, @roles, @what, @telegram, @tg_key, @phone, @date, @place, @seek, @catalog, 0)
  ON CONFLICT(tg_key) DO UPDATE SET
    updated_at = @now, name = @name, roles = @roles, what = @what, telegram = @telegram,
    phone = @phone, date = @date, place = @place, seek = @seek, catalog = @catalog, deleted = 0
`);
const listLeads = db.prepare("SELECT * FROM leads WHERE deleted = 0 ORDER BY created_at DESC");
const countLeads = db.prepare("SELECT COUNT(*) AS n FROM leads");
const softDelete = db.prepare("UPDATE leads SET deleted = 1 WHERE id = ?");

/* ограничение частоты: по адресу, в памяти */
const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) { hits.set(key, arr); return true; }
  arr.push(now);
  hits.set(key, arr);
  return false;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of hits) if (!arr.some((t) => now - t < 3600e3)) hits.delete(k);
}, 600e3).unref();

const clientIp = (req) => String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();

function send(res, status, body, headers = {}) {
  const isObj = typeof body === "object" && !Buffer.isBuffer(body);
  const data = isObj ? JSON.stringify(body) : body;
  res.writeHead(status, {
    "Content-Type": isObj ? "application/json; charset=utf-8" : "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end(data);
}

function readJson(req, limit = 10_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch { reject(new Error("bad json")); }
    });
    req.on("error", reject);
  });
}

const clean = (v, max) => String(v ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);

function parseLead(body) {
  const name = clean(body.name, 80);
  const roles = Array.isArray(body.roles) ? [...new Set(body.roles.map(String))].filter((r) => ROLES.includes(r)) : [];
  const telegram = clean(body.telegram, 40);
  const date = clean(body.date, 40);
  const place = clean(body.place, 40);
  if (name.length < 2) return { error: "name" };
  if (!roles.length) return { error: "roles" };
  if (!/^@[A-Za-z0-9_]{4,32}$/.test(telegram)) return { error: "telegram" };
  if (!DATES.includes(date)) return { error: "date" };
  if (!PLACES.includes(place)) return { error: "place" };
  return {
    lead: {
      name, roles: roles.join(", "), telegram, tg_key: telegram.toLowerCase(), date, place,
      what: clean(body.what, 120), seek: clean(body.seek, 400), catalog: body.catalog === true ? 1 : 0,
      phone: clean(body.phone, 40).replace(/[^0-9+() -]/g, "").slice(0, 30),
    },
  };
}

function corsHeaders(req) {
  const origin = req.headers.origin;
  if (!origin || !ORIGINS.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

const digest = (s) => createHash("sha256").update(s).digest();
function isAdmin(req) {
  if (!ADMIN_USER || !ADMIN_PASS) return false;
  const m = /^Basic (.+)$/.exec(req.headers.authorization || "");
  if (!m) return false;
  const raw = Buffer.from(m[1], "base64").toString("utf8");
  const i = raw.indexOf(":");
  if (i < 0) return false;
  const okUser = timingSafeEqual(digest(raw.slice(0, i)), digest(ADMIN_USER));
  const okPass = timingSafeEqual(digest(raw.slice(i + 1)), digest(ADMIN_PASS));
  return okUser && okPass;
}

function tally(leads, field, options) {
  return options.map((o) => ({ label: o, count: leads.filter((l) => l[field] === o).length }));
}

function adminData() {
  const leads = listLeads.all();
  const roles = ROLES.map((r) => ({ label: r, count: leads.filter((l) => l.roles.split(", ").includes(r)).length }));
  return { leads, total: leads.length, catalog: leads.filter((l) => l.catalog).length, dates: tally(leads, "date", DATES), places: tally(leads, "place", PLACES), roles };
}

function csv(leads) {
  const cell = (v) => '"' + String(v ?? "").replace(/"/g, '""') + '"';
  // свободный текст анкеты Excel может принять за формулу, ник и телефон уже проверены на входе
  const text = (v) => (/^[=+\-@\t]/.test(String(v ?? "")) ? "'" + v : v);
  const when = new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", dateStyle: "short", timeStyle: "short" });
  const head = ["Подана (МСК)", "Имя", "Кто", "Чем занимается", "Telegram", "Телефон", "День", "Место", "Кого хочет встретить", "В каталог"];
  const rows = leads.map((l) => [when.format(new Date(l.created_at)), text(l.name), l.roles, text(l.what), l.telegram, l.phone, l.date, l.place, text(l.seek), l.catalog ? "да" : "нет"]);
  return "﻿" + [head, ...rows].map((r) => r.map(cell).join(";")).join("\r\n") + "\r\n";
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const path = url.pathname;
  const ip = clientIp(req);

  try {
    if (path === "/health") return send(res, 200, { ok: true });

    if (path === "/api/lead") {
      const cors = corsHeaders(req);
      if (req.method === "OPTIONS") return send(res, 204, "", cors);
      if (req.method !== "POST") return send(res, 405, { error: "method" }, cors);
      // порог с запасом: за одним адресом мобильного оператора сидит много людей
      if (limited("lead:" + ip, 30, 600e3)) return send(res, 429, { error: "rate" }, cors);
      let body;
      try { body = await readJson(req); } catch { return send(res, 400, { error: "body" }, cors); }
      if (body.company) return send(res, 200, { ok: true }, cors); // приманка для ботов
      const { lead, error } = parseLead(body);
      if (error) return send(res, 422, { error }, cors);
      if (countLeads.get().n >= MAX_LEADS) return send(res, 503, { error: "full" }, cors);
      upsert.run({ ...lead, now: new Date().toISOString() });
      return send(res, 200, { ok: true }, cors);
    }

    if (path === "/admin" || path.startsWith("/admin/")) {
      if (limited("auth:" + ip, 120, 600e3)) return send(res, 429, "Слишком много запросов, подожди 10 минут.");
      if (!isAdmin(req)) {
        if (req.headers.authorization && limited("authfail:" + ip, 10, 600e3)) return send(res, 429, "Слишком много попыток, подожди 10 минут.");
        return send(res, 401, "Нужен пароль.", { "WWW-Authenticate": 'Basic realm="Vologda", charset="UTF-8"' });
      }
      if (path === "/admin" && req.method === "GET") {
        return send(res, 200, readFileSync(join(HERE, "admin.html")), {
          "Content-Type": "text/html; charset=utf-8",
          "X-Robots-Tag": "noindex, nofollow",
          "X-Frame-Options": "DENY",
          "Referrer-Policy": "no-referrer",
        });
      }
      if (path === "/admin/leads.json" && req.method === "GET") return send(res, 200, adminData());
      if (path === "/admin/leads.csv" && req.method === "GET") {
        return send(res, 200, csv(listLeads.all()), {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": 'attachment; filename="vologda-ankety.csv"',
        });
      }
      if (path === "/admin/delete" && req.method === "POST") {
        // заголовок нельзя выставить формой с чужого сайта, это защита от подделки запроса
        if (req.headers["x-admin"] !== "1") return send(res, 403, { error: "forbidden" });
        const body = await readJson(req);
        softDelete.run(Number(body.id) || 0);
        return send(res, 200, { ok: true });
      }
      return send(res, 404, "Нет такой страницы.");
    }

    if (path === "/") return send(res, 302, "", { Location: SITE_URL });
    return send(res, 404, "Нет такой страницы.");
  } catch (err) {
    console.error(err);
    return send(res, 500, { error: "server" });
  }
});

server.listen(PORT, "127.0.0.1", () => console.log("vologda-leads on 127.0.0.1:" + PORT));
