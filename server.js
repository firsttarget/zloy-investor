'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const config = require('./lib/config');
const engine = require('./lib/engine');

// ---------- Статика: только файлы из белого списка (никакого обхода путей) ----------

const PUBLIC = path.join(__dirname, 'public');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
  '/samples.js': ['samples.js', 'text/javascript; charset=utf-8'],
};

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), geolocation=(), microphone=(self)',
};

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
  res.end(payload);
}

// ---------- Ограничение частоты запросов по IP (в памяти) ----------

const hits = new Map();
const RATE = {
  start: { limit: 8, windowMs: 10 * 60 * 1000 },
  answer: { limit: 60, windowMs: 10 * 60 * 1000 },
};

function clientIp(req) {
  if (config.trustProxy) {
    // Берём ПОСЛЕДНИЙ адрес: его добавляет прокси хостинга, первый может подделать клиент.
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',').pop().trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress || 'unknown';
}

function rateLimited(req, kind) {
  const key = `${kind}:${clientIp(req)}`;
  const now = Date.now();
  const { limit, windowMs } = RATE[kind];
  const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
  list.push(now);
  hits.set(key, list);
  return list.length > limit;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, list] of hits) if (!list.some((t) => now - t < 10 * 60 * 1000)) hits.delete(k);
}, 60 * 1000).unref();

// ---------- Чтение JSON-тела с ограничением размера ----------

const MAX_BODY = 40 * 1024;

function readJson(req) {
  return new Promise((resolve, reject) => {
    const type = String(req.headers['content-type'] || '');
    if (!type.includes('application/json')) return reject(new engine.UserError(415, 'Нужен JSON'));
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        // Перестаём копить данные, но дочитываем поток, чтобы клиент получил ответ 413.
        req.removeAllListeners('data');
        req.resume();
        reject(new engine.UserError(413, 'Слишком большой запрос'));
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        const data = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
        resolve(data);
      } catch {
        reject(new engine.UserError(400, 'Некорректный JSON'));
      }
    });
    req.on('error', reject);
  });
}

// ---------- Роутинг ----------

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const route = `${req.method} ${url.pathname}`;

  if (req.method === 'GET' && STATIC[url.pathname]) {
    const [file, type] = STATIC[url.pathname];
    return send(res, 200, fs.readFileSync(path.join(PUBLIC, file)), type);
  }

  switch (route) {
    case 'GET /healthz':
      return send(res, 200, { ok: true });
    case 'GET /api/config':
      return send(res, 200, engine.info());
    case 'POST /api/start': {
      if (rateLimited(req, 'start')) return send(res, 429, { error: 'Слишком много попыток. Подождите пару минут.' });
      const body = await readJson(req);
      return send(res, 200, await engine.start(body));
    }
    case 'POST /api/answer': {
      if (rateLimited(req, 'answer')) return send(res, 429, { error: 'Слишком много запросов. Подождите минуту.' });
      const body = await readJson(req);
      return send(res, 200, await engine.answer(body));
    }
    default:
      return send(res, 404, { error: 'Не найдено' });
  }
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    if (e instanceof engine.UserError) return send(res, e.status, { error: e.message, ...(e.extra || {}) });
    // Внутренние детали (в том числе ответы провайдера LLM) наружу не отдаём.
    console.error(JSON.stringify({ event: 'error', message: e.message, status: e.status }));
    const busy = e.status === 429 || e.name === 'TimeoutError';
    send(res, busy ? 503 : 502, {
      error: busy ? 'Инвестор задумался слишком надолго. Нажмите «Отправить» ещё раз.' : 'Инвестор временно недоступен. Попробуйте ещё раз.',
    });
  });
});

server.requestTimeout = 120000;
server.headersTimeout = 20000;

if (require.main === module) {
  server.listen(config.port, () => {
    console.log(`Злой инвестор: http://localhost:${config.port} | персонаж: ${config.investor} | режим: ${config.provider}`);
  });
}

module.exports = server;
