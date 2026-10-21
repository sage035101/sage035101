import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const KB_FILE = path.join(DATA, 'kb.jsonl');
const UPLOAD_FILE = path.join(DATA, 'uploads.jsonl');
const GUEST_FILE = process.env.GUEST_CODES_FILE || path.join(DATA, 'guest_codes.json');
const GUEST_BAK = GUEST_FILE + '.bak';
const CRED_FILE = 'C:/Users/39713/.dsh/.credentials.yaml';
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const API_BASE = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/anthropic';
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-flash';
const ACCESS_PASSWORD = String(process.env.SAGE_ACCESS_PASSWORD || '');
const SESSION_SECRET = String(process.env.SAGE_SESSION_SECRET || crypto.createHash('sha256')
  .update(`sage-session|${ACCESS_PASSWORD}|${process.env.UPSTASH_REDIS_REST_TOKEN || ''}|${process.env.DEEPSEEK_API_KEY || ''}|${process.env.DEEPSEEK_ACCOUNT_TOKEN || ''}`)
  .digest('hex'));
const REQUIRE_USER_KEY = process.env.REQUIRE_USER_DEEPSEEK_KEY === '1';
const SESSION_TTL = 365 * 86400 * 1000;
const SESSION_COOKIE = 'sage_session';
const CLIENT_COOKIE = 'sage_client';
const CLIENT_TTL = 365 * 86400 * 1000;
const sessions = new Map();
let sessionSaveQueue = Promise.resolve();
const UPSTASH_URL = String(process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const UPSTASH_TOKEN = String(process.env.UPSTASH_REDIS_REST_TOKEN || '');
const REMOTE_CODES = !!(UPSTASH_URL && UPSTASH_TOKEN);
const REMOTE_CODES_KEY = process.env.GUEST_CODES_KEY || 'sage:guest_codes:v1';
const SESSIONS_KEY = process.env.SAGE_SESSIONS_KEY || 'sage:sessions:v1';
const SESSIONS_FILE = process.env.SAGE_SESSIONS_FILE || path.join(DATA, 'sessions.json');
const USAGE_KEY = process.env.SAGE_USAGE_KEY || 'sage:usage:v1';
const USAGE_FILE = process.env.SAGE_USAGE_FILE || path.join(DATA, 'usage.json');
const HISTORICAL_AVG_COST = Math.max(0, Number(process.env.SAGE_HISTORICAL_AVG_COST) || 0.015);
const MASTER_HISTORY_COST = Math.max(0, Number(process.env.SAGE_MASTER_HISTORY_COST) || 0);
const CODE_BUDGET = process.env.SAGE_CODE_BUDGET === undefined ? 9 : Math.max(0, Number(process.env.SAGE_CODE_BUDGET) || 0);
const CODE_BUDGET_RESERVE = Math.max(0, Number(process.env.SAGE_CODE_BUDGET_RESERVE) || 0.3);
let guestCodes = new Map();
let saveQueue = Promise.resolve();
let usageStats = defaultUsage();
let usageQueue = Promise.resolve();

// 远程持久化只保存"密码记录"本身；修改密码、登录、扣次数都会写回 Upstash。
// 本地文件保留为断网/Upstash 故障时的兜底，逻辑与旧版一致。
function sanitizeGuestCodes(input) {
  const out = new Map();
  if (!input || typeof input !== 'object') return out;
  for (const [code, rec] of Object.entries(input)) {
    if (!/^\d{6}$/.test(code) || !rec || typeof rec !== 'object') continue;
    const remaining = Math.max(0, Math.floor(Number(rec.remaining) || 0));
    const limit = Math.max(remaining, Math.floor(Number(rec.limit) || remaining));
    out.set(code, {
      remaining,
      limit,
      spent: Math.max(0, Number(rec.spent) || Math.max(0, limit - remaining) * HISTORICAL_AVG_COST),
      activeSid: typeof rec.activeSid === 'string' && /^[A-Za-z0-9_-]{10,100}$/.test(rec.activeSid) ? rec.activeSid : null,
      createdAt: Number(rec.createdAt) || nowMs(),
      usesOwnerKey: rec.usesOwnerKey !== false,
    });
  }
  return out;
}
function loadGuestCodesLocal() {
  for (const file of [GUEST_FILE, GUEST_BAK]) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      guestCodes = sanitizeGuestCodes(raw);
      if (guestCodes.size) return true;
    } catch { /* try backup */ }
  }
  return false;
}
async function remoteGetCodes() {
  if (!REMOTE_CODES) return null;
  const res = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(REMOTE_CODES_KEY)}`, {
    headers: { authorization: `Bearer ${UPSTASH_TOKEN}` },
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error(`upstash get ${res.status}`);
  const body = await res.json().catch(() => null);
  return body && body.result != null ? String(body.result) : null;
}
async function remoteSetCodes(payload) {
  if (!REMOTE_CODES) return;
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(REMOTE_CODES_KEY)}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${UPSTASH_TOKEN}`,
          'content-type': 'text/plain; charset=utf-8',
        },
        body: payload,
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`upstash set ${res.status}`);
      const body = await res.json().catch(() => null);
      if (body && body.result !== 'OK') throw new Error(`upstash set rejected: ${String(body.result).slice(0, 40)}`);
      return;
    } catch (e) {
      lastErr = e;
      if (attempt < 1) await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw lastErr;
}
function serializeGuestCodes() {
  return JSON.stringify({
    v: 1,
    updatedAt: nowMs(),
    codes: Object.fromEntries(guestCodes),
  });
}
function saveGuestCodesLocal() {
  try {
    fs.mkdirSync(path.dirname(GUEST_FILE), { recursive: true });
    const body = JSON.stringify(Object.fromEntries(guestCodes), null, 2);
    const tmp = GUEST_FILE + '.tmp';
    fs.writeFileSync(tmp, body, 'utf8');
    fs.renameSync(tmp, GUEST_FILE);
    fs.writeFileSync(GUEST_BAK, body, 'utf8');
  } catch (e) { console.error('save guest codes local', e.message); }
}
function saveGuestCodes() {
  saveGuestCodesLocal();
  if (!REMOTE_CODES) return Promise.resolve();
  const payload = serializeGuestCodes();
  saveQueue = saveQueue
    .then(() => remoteSetCodes(payload))
    .catch((e) => console.error('save guest codes remote', e.message));
  return saveQueue;
}
async function initGuestCodes() {
  loadGuestCodesLocal();
  if (!REMOTE_CODES) return;
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const raw = await remoteGetCodes();
      if (raw) {
        const parsed = JSON.parse(raw);
        const codes = parsed && typeof parsed === 'object' && parsed.codes ? parsed.codes : parsed;
        guestCodes = sanitizeGuestCodes(codes);
        console.log(`guest codes: loaded ${guestCodes.size} from upstash`);
        saveGuestCodesLocal();
      } else {
        console.log('guest codes: upstash empty, seeding from local file');
        saveGuestCodesLocal();
        await remoteSetCodes(serializeGuestCodes());
      }
      return;
    } catch (e) {
      lastErr = e;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
  // 读不到远端时宁可让本次启动失败，也不能用空内存覆盖远端已有密码。
  console.error('guest codes: upstash load failed, refusing to start:', lastErr?.message || lastErr);
  process.exit(1);
}
function guestQuota(session) {
  if (!session || session.role !== 'guest') return null;
  const rec = guestCodes.get(session.code);
  return rec ? Math.max(0, Number(rec.remaining) || 0) : 0;
}
const rateBuckets = new Map();

const nowMs = () => Date.now();

// ---------- 用量统计（按 DeepSeek API 实际 usage 估算） ----------
function defaultUsage() {
  return {
    v: 1,
    initialized: false,
    guest: { cost: 0, questions: 0, historicalCost: 0, historicalQuestions: 0 },
    master: { cost: 0, questions: 0, historicalCost: 0, historicalQuestions: 0 },
    self: { cost: 0, questions: 0 },
    updatedAt: Date.now(),
  };
}
function sanitizeUsage(input) {
  const out = defaultUsage();
  const num = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Number(v)) : 0);
  if (input && typeof input === 'object') {
    out.initialized = input.initialized === true;
    for (const key of ['guest', 'master']) {
      const src = input[key];
      if (src && typeof src === 'object') {
        out[key].cost = num(src.cost);
        out[key].questions = Math.floor(num(src.questions));
        out[key].historicalCost = num(src.historicalCost);
        out[key].historicalQuestions = Math.floor(num(src.historicalQuestions));
      }
    }
    if (input.self && typeof input.self === 'object') {
      out.self.cost = num(input.self.cost);
      out.self.questions = Math.floor(num(input.self.questions));
    }
    out.updatedAt = num(input.updatedAt) || Date.now();
  }
  return out;
}
function loadUsageLocal() {
  try {
    usageStats = sanitizeUsage(JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8')));
  } catch { /* optional */ }
}
function saveUsageLocal() {
  try {
    fs.mkdirSync(path.dirname(USAGE_FILE), { recursive: true });
    fs.writeFileSync(USAGE_FILE, JSON.stringify(usageStats, null, 2), 'utf8');
  } catch (e) { console.error('save usage local', e.message); }
}
async function remoteGetUsage() {
  if (!REMOTE_CODES) return null;
  const res = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(USAGE_KEY)}`, {
    headers: { authorization: `Bearer ${UPSTASH_TOKEN}` },
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error(`upstash usage get ${res.status}`);
  const body = await res.json().catch(() => null);
  return body && body.result != null ? String(body.result) : null;
}
async function remoteSetUsage(payload) {
  if (!REMOTE_CODES) return;
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(USAGE_KEY)}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${UPSTASH_TOKEN}`,
          'content-type': 'text/plain; charset=utf-8',
        },
        body: payload,
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`upstash usage set ${res.status}`);
      const body = await res.json().catch(() => null);
      if (body && body.result !== 'OK') throw new Error(`upstash usage set rejected: ${String(body.result).slice(0, 40)}`);
      return;
    } catch (e) {
      lastErr = e;
      if (attempt < 1) await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw lastErr;
}
function serializeUsage() {
  return JSON.stringify(usageStats);
}
function saveUsage() {
  saveUsageLocal();
  if (!REMOTE_CODES) return Promise.resolve();
  const payload = serializeUsage();
  usageQueue = usageQueue
    .then(() => remoteSetUsage(payload))
    .catch((e) => console.error('save usage remote', e.message));
  return usageQueue;
}
function backfillUsage() {
  if (usageStats.initialized) return;
  let questions = 0;
  let cost = 0;
  for (const rec of guestCodes.values()) {
    const limit = Math.max(0, Number(rec.limit) || 0);
    const remaining = Math.max(0, Number(rec.remaining) || 0);
    const used = Math.max(0, limit - remaining);
    questions += used;
    cost += used * HISTORICAL_AVG_COST;
  }
  usageStats.guest.historicalQuestions += questions;
  usageStats.guest.historicalCost += cost;
  usageStats.master.historicalCost = Math.max(usageStats.master.historicalCost, MASTER_HISTORY_COST);
  usageStats.initialized = true;
  usageStats.updatedAt = Date.now();
  if (questions > 0) {
    console.log(`usage: backfilled ${questions} historical guest questions, estimated ¥${cost.toFixed(4)}`);
  }
}
async function initUsage() {
  loadUsageLocal();
  if (REMOTE_CODES) {
    try {
      const raw = await remoteGetUsage();
      if (raw) {
        usageStats = sanitizeUsage(JSON.parse(raw));
        saveUsageLocal();
        if (!usageStats.initialized) {
          backfillUsage();
          await saveUsage();
        }
        return;
      }
    } catch (e) {
      console.error('usage: remote load failed, using local estimate:', e.message);
    }
  }
  if (!usageStats.initialized) {
    backfillUsage();
    await saveUsage();
  } else if (REMOTE_CODES) {
    await saveUsage();
  }
}
function isPeakNow() {
  const bj = new Date(Date.now() + 8 * 3600 * 1000);
  const day = bj.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = bj.getUTCHours();
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18);
}
const MODEL_PRICES = {
  'deepseek-flash': { hit: [0.04, 0.02], miss: [2, 1], out: [8, 4] },
  'deepseek-v4-pro': { hit: [0.30, 0.15], miss: [9, 4.5], out: [27, 13.5] },
};
function estimateUsageCost(u) {
  if (!u || typeof u !== 'object') return 0;
  const price = MODEL_PRICES[MODEL] || MODEL_PRICES['deepseek-flash'];
  const idx = isPeakNow() ? 0 : 1;
  const input = Math.max(0, Number(u.input_tokens) || 0);
  const cache = Math.min(input, Math.max(0, Number(u.cache_read_input_tokens) || 0));
  const miss = Math.max(0, input - cache);
  const output = Math.max(0, Number(u.output_tokens) || 0);
  return (miss * price.miss[idx] + cache * price.hit[idx] + output * price.out[idx]) / 1e6;
}
function recordUsage(role, payer, u, code = '') {
  if (!u || typeof u !== 'object') return;
  const cost = estimateUsageCost(u);
  if (!Number.isFinite(cost) || cost <= 0) return;
  const target = payer === 'self'
    ? usageStats.self
    : (role === 'master' ? usageStats.master : usageStats.guest);
  target.cost += cost;
  target.questions += 1;
  usageStats.updatedAt = Date.now();
  void saveUsage();
  if (code) {
    const rec = guestCodes.get(code);
    if (rec) {
      rec.spent = Math.max(0, Number(rec.spent) || 0) + cost;
      guestCodes.set(code, rec);
      void saveGuestCodes();
    }
  }
}
function formatMoney(n) {
  const value = Math.max(0, Number(n) || 0);
  if (value > 0 && value < 0.01) return `¥${value.toFixed(4)}`;
  if (value > 0 && value < 1) return `¥${value.toFixed(3)}`;
  return `¥${value.toFixed(2)}`;
}
function codeHasBudget(rec) {
  const limit = Math.max(0, Number(rec?.limit) || 0);
  return limit > 0 && limit <= 260;
}
const clientIp = (req) => String(req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
function rateLimit(key, limit, windowMs) {
  const t = nowMs();
  const b = rateBuckets.get(key) || { start: t, n: 0 };
  if (t - b.start > windowMs) { b.start = t; b.n = 0; }
  b.n++;
  rateBuckets.set(key, b);
  if (rateBuckets.size > 5000) {
    for (const [k, v] of rateBuckets) if (t - v.start > 3600000) rateBuckets.delete(k);
  }
  return b.n <= limit;
}
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore malformed cookie */ }
  }
  return out;
}
function sanitizeSessions(input) {
  const out = new Map();
  if (!input || typeof input !== 'object') return out;
  for (const [sid, rec] of Object.entries(input)) {
    if (!/^[A-Za-z0-9_-]{10,100}$/.test(sid) || !rec || typeof rec !== 'object') continue;
    if (rec.role !== 'master' && rec.role !== 'guest') continue;
    const expires = Number(rec.expires) || 0;
    if (expires <= nowMs()) continue;
    const code = rec.role === 'guest' && /^\d{6}$/.test(String(rec.code || '')) ? String(rec.code) : undefined;
    if (rec.role === 'guest' && !code) continue;
    out.set(sid, {
      role: rec.role,
      ...(code ? { code } : {}),
      usesOwnerKey: rec.usesOwnerKey !== false,
      createdAt: Number(rec.createdAt) || nowMs(),
      expires,
    });
  }
  return out;
}
function loadSessionsLocal() {
  try {
    const raw = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    sessions.clear();
    for (const [sid, rec] of sanitizeSessions(raw && raw.sessions ? raw.sessions : raw)) sessions.set(sid, rec);
    if (sessions.size) console.log(`sessions: loaded ${sessions.size} from local`);
  } catch { /* optional */ }
}
function saveSessionsLocal() {
  try {
    fs.mkdirSync(path.dirname(SESSIONS_FILE), { recursive: true });
    const data = { v: 1, updatedAt: nowMs(), sessions: Object.fromEntries(sessions) };
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) { console.error('save sessions local', e.message); }
}
async function remoteGetSessions() {
  if (!REMOTE_CODES) return null;
  const res = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(SESSIONS_KEY)}`, {
    headers: { authorization: `Bearer ${UPSTASH_TOKEN}` },
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error(`upstash sessions get ${res.status}`);
  const body = await res.json().catch(() => null);
  return body && body.result != null ? String(body.result) : null;
}
async function remoteSetSessions(payload) {
  if (!REMOTE_CODES) return;
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(SESSIONS_KEY)}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${UPSTASH_TOKEN}`,
          'content-type': 'text/plain; charset=utf-8',
        },
        body: payload,
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`upstash sessions set ${res.status}`);
      const body = await res.json().catch(() => null);
      if (body && body.result !== 'OK') throw new Error(`upstash sessions set rejected: ${String(body.result).slice(0, 40)}`);
      return;
    } catch (e) {
      lastErr = e;
      if (attempt < 1) await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw lastErr;
}
function saveSessions() {
  saveSessionsLocal();
  if (!REMOTE_CODES) return Promise.resolve();
  const payload = JSON.stringify({ v: 1, updatedAt: nowMs(), sessions: Object.fromEntries(sessions) });
  sessionSaveQueue = sessionSaveQueue
    .then(() => remoteSetSessions(payload))
    .catch((e) => console.error('save sessions remote', e.message));
  return sessionSaveQueue;
}
async function initSessions() {
  loadSessionsLocal();
  if (!REMOTE_CODES) return;
  try {
    const raw = await remoteGetSessions();
    if (raw) {
      const parsed = JSON.parse(raw);
      sessions.clear();
      for (const [sid, rec] of sanitizeSessions(parsed && parsed.sessions ? parsed.sessions : parsed)) sessions.set(sid, rec);
      saveSessionsLocal();
      console.log(`sessions: loaded ${sessions.size} from upstash`);
    }
  } catch (e) {
    console.error('sessions: remote load failed, using local:', e.message);
  }
}
function sessionInfo(req) {
  const raw = parseCookies(req)[SESSION_COOKIE];
  if (!raw) return null;
  const [sid, exp, sig] = raw.split('.');
  if (!sid || !exp || !sig || Number(exp) < nowMs()) return null;
  const data = `${sid}.${exp}`;
  const want = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const stored = sessions.get(sid);
  if (!stored || stored.expires < nowMs()) return null;
  return { id: sid, ...stored };
}
function createSession(req, res, data) {
  const sid = crypto.randomBytes(18).toString('base64url');
  const exp = nowMs() + SESSION_TTL;
  const info = { ...data, createdAt: nowMs(), expires: exp };
  sessions.set(sid, info);
  void saveSessions();
  const raw = `${sid}.${exp}`;
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(raw).digest('base64url');
  const secure = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(`${raw}.${sig}`)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL / 1000)}${secure ? '; Secure' : ''}`);
  return { sid, info };
}
function trimMasterSessions(max = 5) {
  const list = [...sessions.entries()]
    .filter(([, s]) => s.role === 'master' && s.expires > nowMs())
    .sort((a, b) => (a[1].createdAt || 0) - (b[1].createdAt || 0));
  while (list.length >= max) {
    const [sid] = list.shift();
    sessions.delete(sid);
  }
  if (list.length) void saveSessions();
}
function setSessionCookie(req, res) {
  return createSession(req, res, { role: 'master' }).sid;
}
function clearSession(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}
function clientInfo(req, res) {
  const raw = parseCookies(req)[CLIENT_COOKIE];
  if (raw) {
    const [sid, exp, sig] = raw.split('.');
    if (sid && exp && sig && Number(exp) > nowMs()) {
      const data = `${sid}.${exp}`;
      const want = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
      const a = Buffer.from(sig);
      const b = Buffer.from(want);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) return { id: sid };
    }
  }
  const sid = crypto.randomBytes(18).toString('base64url');
  const exp = nowMs() + CLIENT_TTL;
  const data = `${sid}.${exp}`;
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
  const secure = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  res.setHeader('Set-Cookie', `${CLIENT_COOKIE}=${encodeURIComponent(`${data}.${sig}`)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(CLIENT_TTL / 1000)}${secure ? '; Secure' : ''}`);
  return { id: sid };
}
function passwordOk(input) {
  if (!ACCESS_PASSWORD) return true;
  const a = Buffer.from(String(input || ''));
  const b = Buffer.from(ACCESS_PASSWORD);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function redirect(res, to) {
  res.writeHead(302, { location: to, 'cache-control': 'no-store' });
  res.end();
}
function loginPage() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>访问验证 · Sage 答疑服务</title><style>
  :root{--ink:#22303f;--muted:#72849a;--line:#d7e1eb;--paper:#eef3f8;--sage:#3f5f82}
  *{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;background:radial-gradient(circle at 20% 10%,#fff,#e9f0f7 60%,#e2ebf4);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;color:var(--ink);padding:20px}
  .card{width:min(380px,100%);background:rgba(255,255,255,.86);border:1px solid rgba(215,225,235,.9);border-radius:18px;padding:30px 28px 24px;box-shadow:0 24px 70px rgba(42,65,88,.15);text-align:center;backdrop-filter:blur(10px)}
  img{width:92px;height:auto;display:block;margin:0 auto 8px}h1{font-family:Georgia,"Songti SC",serif;font-size:22px;margin:4px 0 4px}p{font-size:12px;color:var(--muted);margin:0 0 18px;line-height:1.7}
  input{width:100%;height:44px;border:1px solid var(--line);border-radius:10px;padding:0 13px;font-size:15px;outline:0;background:#fff;color:var(--ink)}
  input:focus{border-color:#8ba6c2;box-shadow:0 0 0 3px rgba(63,95,130,.09)}
  button{width:100%;height:44px;margin-top:10px;border:0;border-radius:10px;background:var(--sage);color:#fff;font-size:14px;font-weight:600;cursor:pointer}button:disabled{opacity:.55}
  .err{min-height:18px;color:#a95b5b;font-size:11.5px;margin:8px 0 0}.fine{font-size:10px;color:#9aa9b8;margin-top:16px;line-height:1.6}
  </style></head><body><main class="card"><img src="/logo.png" alt="Sage"><h1>Sage 答疑服务</h1><p>站长输入总密码，访客输入 6 位答疑密码</p><form id="f"><input id="p" type="password" autocomplete="current-password" placeholder="站长密码或 6 位答疑密码" autofocus><button id="b" type="submit">进入</button><div class="err" id="e"></div></form><div class="fine">仅限本人及获授权的人使用<br>请勿把密码和链接转发到公开群</div></main><script>
  const f=document.querySelector('#f'),p=document.querySelector('#p'),b=document.querySelector('#b'),e=document.querySelector('#e');
  if(new URLSearchParams(location.search).get('kicked')) e.textContent='该密码已在另一台设备登录，本设备已退出';
  f.addEventListener('submit',async(ev)=>{ev.preventDefault();e.textContent='';b.disabled=true;try{const r=await fetch('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:p.value})});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||'密码不正确');location.href='/'}catch(err){e.textContent=err.message||'密码不正确';b.disabled=false;p.select()}});
  </script></body></html>`;
}


const SOURCE_TITLES = {  '27法硕精讲一本通-刑法学-车润海.pdf': '《法硕精讲一本通·刑法学》',
  '27法硕精讲一本通-民法学-岳业鹏.pdf': '《法硕精讲一本通·民法》',
  '27法硕精讲一本通-法理学-杜洪波.pdf': '《法硕精讲一本通·法理学》',
  '27法硕精讲一本通-宪法学-马峰_1.pdf': '《法硕精讲一本通·宪法学》',
  '27法硕精讲一本通-法制史-龚成思_1.pdf': '《法硕精讲一本通·法制史》',
  '刑法学（95）0001.pdf': '《刑法学讲义》',
  '27年刑法母子题合集（解析版）.pdf': '《27刑法母子题·解析》',
  '帮信罪、诈骗共犯、掩隐罪区分解题思路及其案例分析训练(1).pdf': '《帮信罪·诈骗共犯·掩隐罪区分专题》',
  '母子题试题册_文字版.pdf': '《民法母子题·试题册》',
  '母子题解析册_文字版.pdf': '《民法母子题·解析册》',
  '法理五连鞭通用@一头大番茄(1).pdf': '《法理五连鞭·论述模板》',
};
const TEACHER_NAME_RE = /车润海|岳业鹏|杜洪波|马峰|龚成思|于越/g;
const stripTeacherNames = (value) => String(value || '').replace(TEACHER_NAME_RE, '老师');
const titleOf = (doc) => stripTeacherNames(doc.title || SOURCE_TITLES[doc.source] || doc.book || doc.source.replace(/\.pdf$/i, ''));

const SUBJECTS = ['刑法', '民法', '法理', '宪法', '法制史'];

// Server-side continuity fallback. The browser normally sends the full history,
// but this keeps the last turns available for flaky mobile clients and reloads.
const conversationMemory = new Map();

function textKey(m) {
  return `${m.role}:${String(m.content || m.text || '').replace(/\s+/g, ' ').trim()}`;
}

function mergeHistory(convId, incoming) {
  const stored = convId ? (conversationMemory.get(convId) || []) : [];
  const all = [...stored, ...incoming];
  const byId = new Set();
  const byText = new Set();
  const out = [];
  for (const m of all) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const content = String(m.content ?? m.text ?? '').trim();
    if (!content && !(m.images?.length)) continue;
    const tk = textKey({ role: m.role, content });
    if ((m.id && byId.has(m.id)) || byText.has(tk)) continue;
    if (m.id) byId.add(m.id);
    byText.add(tk);
    out.push({ ...m, content });
  }
  return out.slice(-40);
}

function rememberTurn(convId, userId, userText, aiId, aiText) {
  if (!convId || (!userText && !aiText)) return;
  const old = conversationMemory.get(convId) || [];
  const next = mergeHistory(convId, [
    ...old,
    { id: userId || `srv-user-${Date.now()}`, role: 'user', content: userText },
    { id: aiId || `srv-ai-${Date.now()}`, role: 'assistant', content: aiText },
  ]);
  conversationMemory.set(convId, next.slice(-30));
  if (conversationMemory.size > 200) {
    const first = conversationMemory.keys().next().value;
    conversationMemory.delete(first);
  }
}

function buildContextBrief(history, currentQuery) {
  const lastUserAt = history.map((m) => m.role).lastIndexOf('user');
  const prior = lastUserAt >= 0 ? history.slice(0, lastUserAt) : history;
  const turns = [];
  for (let i = 0; i < prior.length; i++) {
    if (prior[i].role !== 'user') continue;
    const u = String(prior[i].content || '').replace(/\s+/g, ' ').trim();
    if (!u) continue;
    const aMsg = prior.slice(i + 1).find((m) => m.role === 'assistant' && String(m.content || '').trim());
    const a = aMsg ? String(aMsg.content).replace(/\s+/g, ' ').trim() : '';
    turns.push({ u: u.slice(0, 380), a: a.slice(0, 700) });
  }
  const recent = turns.slice(-3);
  if (!recent.length) return '';
  const lines = recent.map((t, i) => `第${i + 1}轮 用户：${t.u}\n你的回答（节选）：${t.a || '（无）'}`).join('\n');
  return `【真实对话上文】
${lines}
当前追问：${currentQuery || '（本轮以图片为主）'}
要求：这是同一段连续对话。遇到“你确定吗 / 为什么 / 那…… / 还有呢”这类追问，先判断它指向上一答的哪一部分，再正面回应；绝对不要说你“看不到上一条”或“不知道用户在问什么”。如果确实指代不明，先用一句话复述你理解的上一问，再请用户确认。`;
}

// ---------- knowledge base ----------
let docs = [];
let postings = new Map(); // token -> [docId, tf, docId, tf, ...]
let docLens = [];
let avgdl = 1;
let indexReady = false;

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch {}
  }
  return out;
}

const STOP_TOKENS = new Set(['下列', '哪一', '说法', '正确', '错误', '关于', '的是', '本题', '请', '问', '一下', '如何', '什么', '为什么', '是否', '可以', '应当', '属于', '选项']);

function tokenize(text) {
  const s = String(text || '').toLowerCase().replace(/[^\p{Script=Han}a-z0-9]+/gu, ' ');
  const out = [];
  for (const part of s.split(' ')) {
    if (!part) continue;
    if (/^\p{Script=Han}+$/u.test(part)) {
      if (part.length === 1) out.push(part);
      else {
        for (let i = 0; i < part.length - 1; i++) out.push(part.slice(i, i + 2));
        if (part.length <= 8) out.push(part);
      }
    } else if (/^[a-z][a-z0-9]*$/.test(part) && part.length > 1) {
      out.push(part);
    }
  }
  return out.filter((t) => !STOP_TOKENS.has(t));
}

function cleanQuery(q) {
  return String(q || '')
    .replace(/[（(]\s*[）)]/g, ' ')
    .replace(/异同点?|相同点?和?不同点?|对比|比较|区别与联系|区别和联系|联系与区别|联系和区别|辨析|区分/g, ' 比较 异同 ')
    .replace(/构成要件|成立条件|成立要件/g, ' 构成要件 ')
    .replace(/下列|哪一|哪项|哪个|说法|表述|选项|正确的是|错误的是|不正确的是|关于|请|问一下|如何理解|怎么理解|是什么|有哪些/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const answerCache = new Map();
const ANSWER_CACHE_TTL = 6 * 60 * 60 * 1000;
const ANSWER_CACHE_MAX = 120;

function canonicalQuestion(q) {
  return cleanQuery(q)
    .replace(/的/g, '')
    .replace(/与|及|跟/g, '和')
    .replace(/[？?！!。；;：:，,、\s]/g, '')
    .toLowerCase();
}

const SYNONYMS = {
  '帮信': ['帮助信息网络犯罪活动罪', '明知', '支付结算', '情节严重'],  '掩隐': ['掩饰、隐瞒犯罪所得', '犯罪所得', '转移', '收购'],
  '诈骗共犯': ['诈骗罪', '共同犯罪', '帮助犯', '明知'],
  '正当防卫': ['特殊防卫', '防卫过当', '不法侵害', '紧迫'],
  '紧急避险': ['危险', '不得已', '超过必要限度'],
  '善意取得': ['无权处分', '善意', '合理价格', '登记', '交付'],
  '表见代理': ['无权代理', '有理由相信', '相对人', '善意'],
  '无权处分': ['处分行为', '负担行为', '合同效力', '善意取得'],
  '缔约过失': ['先合同义务', '信赖利益', '合同不成立'],
  '不当得利': ['没有法律根据', '得利', '损失', '返还'],
  '无因管理': ['没有法定或约定义务', '管理他人事务', '必要费用'],
  '情势变更': ['基础条件', '重大变化', '继续履行明显不公平'],
  '居住权': ['用益物权', '合同', '登记', '生活居住'],
  '离婚冷静期': ['协议离婚', '三十日', '撤回'],
  '合宪性审查': ['宪法', '备案审查', '规范性文件', '抵触'],
  '法律解释': ['文义解释', '体系解释', '目的解释', '历史解释'],
  '唐律': ['唐律疏议', '礼法合一', '十恶', '保辜'],
  '礼法合一': ['一准乎礼', '礼与法', '儒家礼治', '唐律的特点', '礼法结合'],
  '唐律疏议': ['一准乎礼', '唐律的特点', '礼法合一'],
  '十恶': ['重罪十条', '常赦所不原', '谋反', '恶逆'],
  '八议': ['上请', '官当', '特权'],
  '罪刑法定': ['法无明文规定不为罪', '法无明文规定不处罚'],
  '共同犯罪': ['共同故意', '帮助犯', '教唆犯', '主犯', '从犯'],
  '犯罪中止': ['自动放弃', '有效性', '没有造成损害'],
  '犯罪未遂': ['已经着手', '意志以外', '未得逞'],
  '想象竞合': ['一行为', '数个罪名', '从一重'],
  '法条竞合': ['特别法', '普通法', '特别关系'],
  '异同': ['相同点', '不同点', '区别', '联系', '比较'],
  '对比': ['相同点', '不同点', '区别', '联系', '比较'],
  '构成要件': ['成立条件', '成立要件', '要件', '要素'],
};

const SUBJECT_WORDS = {
  '刑法': ['罪', '刑', '共犯', '正当防卫', '紧急避险', '犯罪', '帮信', '掩隐', '诈骗', '盗窃', '抢劫', '贪污', '受贿', '缓刑', '自首', '立功', '未遂', '中止', '既遂', '数罪', '竞合', '量刑', '累犯'],
  '民法': ['合同', '物权', '债权', '侵权', '婚姻', '继承', '代理', '时效', '善意', '抵押', '担保', '人格权', '民事', '法人', '合伙', '得利', '无因管理', '缔约', '违约', '居住权', '离婚'],
  '法理': ['法理', '法律解释', '法律效力', '法律关系', '法治', '立法', '司法', '法系', '权利', '义务', '法律职业', '法律溯及'],
  '宪法': ['宪法', '人大', '选举', '基本权利', '合宪', '备案审查', '国家机构', '民族区域', '特别行政区', '国务院'],
  '法制史': ['唐律', '汉律', '秦律', '西周', '礼', '大清', '民国', '根据地', '法经', '九章律', '唐律疏议', '宋刑统', '大明律', '会典', '刑书'],
};

function detectSubject(query) {
  let best = null, bestScore = 0;
  for (const [subject, words] of Object.entries(SUBJECT_WORDS)) {
    let score = 0;
    for (const w of words) if (query.includes(w)) score += w.length >= 2 ? 2 : 1;
    if (score > bestScore) { bestScore = score; best = subject; }
  }
  return bestScore >= 2 ? best : null;
}

function makeSnippet(text, query) {
  const terms = tokenize(cleanQuery(query)).filter((t) => t.length >= 2);
  let best = -1;
  for (const t of terms) {
    const i = text.indexOf(t);
    if (i >= 0 && (best < 0 || i < best)) best = i;
  }
  if (best < 0) return text.slice(0, 240);
  const start = Math.max(0, best - 70);
  const end = Math.min(text.length, start + 260);
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
}

function sourceExcerpt(source, query, maxChars) {
  const text = String(source?.text || '');
  if (!text) return '';
  if (text.length <= maxChars) return text;
  const terms = [...new Set(tokenize(cleanQuery(query)).filter((t) => t.length >= 2))];
  let best = -1;
  for (const t of terms) {
    const i = text.indexOf(t);
    if (i >= 0 && (best < 0 || i < best)) best = i;
  }
  if (best < 0) return text.slice(0, maxChars);
  let start = Math.max(0, best - Math.floor(maxChars * 0.25));
  const end = Math.min(text.length, start + maxChars);
  if (end - start < maxChars) start = Math.max(0, end - maxChars);
  return text.slice(start, end);
}

function validateCitations(text, sources) {
  if (!text || !sources.length) return text;
  const byN = new Map(sources.map((s) => [String(s.n), s]));
  const parts = text.split(/(?<=[。！？；\n])/);
  return parts.map((sentence) => {
    if (!/〔资料\s*\d+〕/.test(sentence)) return sentence;
    const plain = sentence.replace(/〔资料\s*\d+〕/g, '');
    const toks = [...new Set(tokenize(plain).filter((t) => t.length >= 2))];
    const keep = [];
    for (const m of sentence.matchAll(/〔资料\s*(\d+)〕/g)) {
      const src = byN.get(m[1]);
      if (!src) continue;
      const srcText = src.text || '';
      let hits = 0;
      for (const t of toks) if (srcText.includes(t)) hits++;
      if (hits >= 2 || (plain.length >= 6 && srcText.includes(plain.slice(0, 12)))) keep.push(m[1]);
    }
    const uniq = [...new Set(keep)];
    return plain + uniq.map((n) => `〔资料${n}〕`).join('');
  }).join('');
}

function looksLikeContextRefusal(text) {
  return /(看不到|看不见|没有看到).{0,12}(上一条|上一答|追问|回答|上下文)|只看到.{0,12}(四个字|几个字|这句话)|不知道你.{0,6}(问|指|说).{0,4}哪|没有(对话)?上下文|无法(看到|获取).{0,6}(上文|历史)/.test(String(text || ''));
}

function stripMetaAttribution(text) {
  let out = String(text || '').trim();
  const lead = /^\s*(?:\*\*)?\s*(?:(?:根据|依据|按照|从)\s*)?(?:你(?:上传|提供|发)的|你发的|材料|参考材料|参考资料|视频|字幕|PDF|资料)[^。\n]{0,120}[，,：:。]\s*/u;
  for (let i = 0; i < 2; i++) {
    const next = out.replace(lead, '');
    if (next === out) break;
    out = next.trim();
  }
  // Remove standalone attribution sentences such as
  // “这是车润海老师《刑法速记口诀》中……的原文。”
  out = out.replace(/(?:^|\n)[^\n。！？]{0,140}(?:你上传的|你提供的|你发的|参考材料|参考资料|材料里|材料中|视频里|字幕|PDF|《[^》]*(?:口诀|速记)[^》]*》)[^\n。！？]{0,140}(?:原文|内容|资料|显示|提到|写道|来自|出自)[^\n。！？]{0,20}[。！？]?/gu, '\n');
  out = out.replace(/(?:^|\n)\s*《[^》]*(?:口诀|速记)[^》]*》[^\n。！？]{0,100}[。！？]?/gu, '\n');
  out = out.replace(/\n{3,}/g, '\n\n').trim();
  return out || String(text || '').trim();
}

async function retryForContext({ system, messages, auth, contextBrief }) {
  if (!contextBrief) return '';
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 45000);
  try {
    const r = await fetch(`${API_BASE.replace(/\/$/, '')}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...auth },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4096,
        system: `${system}\n\n【强制承接】${contextBrief}\n用户当前这句话明确是在追问上一答。必须直接针对上一答作出确认、修正或补充，第一句就承接；严禁说你“看不到上一条”或“不知道用户指什么”。`,
        messages,
        temperature: 0.25,
        output_config: { effort: 'high' },
        stream: false,
      }),
      signal: ac.signal,
    });
    if (!r.ok) return '';
    const j = await r.json();
    const text = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    return text.length > 30 ? text : '';
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

async function retryForEmpty({ system, messages, auth }) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 60000);
  try {
    const r = await fetch(`${API_BASE.replace(/\/$/, '')}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...auth },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4096,
        system: `${system}\n\n【补答要求】上一次没有生成正文。这次不要长篇思考：先直接给结论，再用最短的必要理由分点说明；不要重复题目，不要输出思考过程。`,
        messages,
        temperature: 0.2,
        output_config: { effort: 'low' },
        stream: false,
      }),
      signal: ac.signal,
    });
    if (!r.ok) return null;
    const j = await r.json();
    const text = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    return text.length > 10 ? { text, usage: j.usage || null } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function sourceWeight(doc, query) {
  let w = 1;
  const mnemonic = /口诀|记忆|背诵|带背|视频|课程|逻辑|方法/.test(query);
  if (doc.source.includes('考试分析')) w += 0.45;
  if (doc.source.includes('精讲一本通')) w += mnemonic ? 0.22 : 0.12;
  if (doc.source.includes('背诵一本通')) w += mnemonic ? 0.3 : 0.1;
  if (doc.source.includes('B站2027课程')) w += mnemonic ? 0.42 : 0.12;
  if (doc.source.includes('速记口诀') || doc.source.includes('口诀（用户提供）')) w += mnemonic ? 0.5 : 0.18;
  if (doc.source.includes('指导性案例')) w += /指导性案例|类似|相似|案例|案号|检例/.test(query) ? 0.38 : -0.16;
  if (doc.source.includes('法硕观点校验')) w += /非法拘禁|转化|致死|死亡|罪名|观点|定性/.test(query) ? 0.7 : 0.08;
  if (mnemonic && /口诀|速记|背诵逻辑|记忆方法|顺口溜/.test(doc.text || '')) w += 0.28;
  if (doc.source.includes('司法解释')) w += /司法解释|法释|条文|解释/.test(query) ? 0.22 : -0.12;
  if (doc.source.includes('官方索引')) w -= 0.05;
  if (doc.source.includes('刑法学（95）')) w -= 0.12;
  if (doc.source.includes('母子题')) w += 0.06;
  if (/案例|题目|真题|分析|判断|选择/.test(query) && /母子题|解析/.test(doc.source)) w += 0.18;
  if (/专题/.test(doc.source)) w += 0.05;
  return w;
}

function rebuildIndex() {
  docs = [...readJsonl(KB_FILE), ...readJsonl(UPLOAD_FILE)];
  for (let i = 0; i < docs.length; i++) docs[i]._id = i;
  postings = new Map();
  docLens = new Array(docs.length);
  let total = 0;
  for (let i = 0; i < docs.length; i++) {
    const toks = tokenize(docs[i].text);
    docLens[i] = Math.max(toks.length, 1);
    total += docLens[i];
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    for (const [t, c] of tf) {
      let arr = postings.get(t);
      if (!arr) { arr = []; postings.set(t, arr); }
      arr.push(i, c);
    }
  }
  avgdl = docs.length ? total / docs.length : 1;
  indexReady = true;
  console.log(`[kb] ${docs.length} pages, ${postings.size} terms, avgdl ${avgdl.toFixed(0)}`);
}

function search(query, subject = '全部', limit = 8, owner = '') {
  if (!indexReady || !docs.length) return [];
  const cleaned = cleanQuery(query);
  if (!cleaned || cleaned.length < 2) return [];
  let qTokens = tokenize(cleaned);
  for (const [k, extra] of Object.entries(SYNONYMS)) {
    if (cleaned.includes(k)) qTokens = qTokens.concat(extra.flatMap(tokenize));
  }
  qTokens = [...new Set(qTokens)];
  if (!qTokens.length) return [];

  const detected = subject && subject !== '全部' ? subject : detectSubject(cleaned);
  const N = docs.length;
  const scores = new Map();
  for (const t of qTokens) {
    const arr = postings.get(t);
    if (!arr) continue;
    const df = arr.length / 2;
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
    for (let p = 0; p < arr.length; p += 2) {
      const id = arr[p], tf = arr[p + 1];
      if (subject && subject !== '全部' && docs[id].subject !== subject && !docs[id].guideCase) continue;
      if (docs[id].uploaded && docs[id].owner && docs[id].owner !== owner) continue;
      const dl = docLens[id];
      const s = idf * (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * dl / avgdl));
      scores.set(id, (scores.get(id) || 0) + s);
    }
  }

  const phrase = cleaned.slice(0, Math.min(24, cleaned.length));
  const ranked = [];
  for (const [id, base] of scores) {
    const doc = docs[id];
    let s = base * sourceWeight(doc, query);
    if (subject && subject !== '全部' && doc.subject === subject) s *= 1.28;
    else if (detected && doc.subject === detected) s *= 1.12;
    if (doc.uploaded) s *= 1.1;
    if (phrase.length >= 4 && doc.text.includes(phrase)) s *= 1.22;
    if (s > 0) ranked.push([s, id]);
  }
  ranked.sort((a, b) => b[0] - a[0]);
  const top = ranked.slice(0, 30);
  const max = top[0]?.[0] || 1;
  const picked = [];
  const perSource = new Map();
  const seenPage = new Set();
  for (const [s, id] of top) {
    if (s < max * 0.18) break;
    const doc = docs[id];
    const key = doc.source;
    if ((perSource.get(key) || 0) >= 4) continue;
    const pageKey = `${doc.source}|${doc.page}`;
    if (seenPage.has(pageKey)) continue;
    seenPage.add(pageKey);
    perSource.set(key, (perSource.get(key) || 0) + 1);
    picked.push({
      n: picked.length + 1,
      subject: doc.subject,
      title: titleOf(doc),
      source: doc.source,
      page: doc.page,
      text: doc.text,
      snippet: makeSnippet(doc.text, query),
      score: Math.round(s * 10) / 10,
    });
    if (picked.length >= limit) break;
  }

  // Pull in the pages immediately before/after the strongest hits, so the model
  // sees the whole section rather than one isolated paragraph.
  const additions = [];
  for (const p of picked.slice(0, 3)) {
    for (const delta of [-1, 1]) {
      const page = p.page + delta;
      const pageKey = `${p.source}|${page}`;
      if (seenPage.has(pageKey) || page < 1) continue;
      const chunks = docs.filter((d) => d.source === p.source && d.page === page &&
        (!d.uploaded || !d.owner || d.owner === owner));
      if (!chunks.length) continue;
      seenPage.add(pageKey);
      additions.push({
        n: 0,
        subject: p.subject,
        title: p.title,
        source: p.source,
        page,
        text: chunks.map((d) => d.text).join('\n'),
        snippet: makeSnippet(chunks.map((d) => d.text).join('\n'), query),
        score: 0,
      });
      if (additions.length >= 4) break;
    }
    if (additions.length >= 4) break;
  }
  const all = [...picked, ...additions].slice(0, 12).map((s, i) => ({ ...s, n: i + 1 }));
  return all;
}

// ---------- auth / upstream ----------
function readAccountToken() {
  const envToken = String(process.env.DEEPSEEK_ACCOUNT_TOKEN || '').trim();
  if (envToken) return envToken;
  try {
    const raw = fs.readFileSync(CRED_FILE, 'utf8');
    const m = raw.match(/deepseek-account-platform\/default:[\s\S]*?token:\s*(\S+)/);
    return m ? m[1].trim() : '';
  } catch { return ''; }
}

function authHeaders(req, session = null) {
  const userKey = String(req.headers['x-user-api-key'] || '').trim();
  if (userKey) return { 'x-api-key': userKey };
  if (session && session.role === 'guest') {
    const rec = guestCodes.get(session.code);
    if (rec && rec.usesOwnerKey === false) return null;
  }
  if (session && (session.role === 'master' || session.role === 'guest')) {
    const envKey = String(process.env.DEEPSEEK_API_KEY || '').trim();
    if (envKey) return { 'x-api-key': envKey };
    const token = readAccountToken();
    if (token) return { 'x-dsh-auth-token': token };
  }
  return null;
}

function peerConfig(req) {
  const multi = String(req.headers['x-multi'] || '') === '1';
  const model = (v, fallback) => {
    const s = String(v || '').trim();
    return /^[A-Za-z0-9._:-]{1,100}$/.test(s) ? s : fallback;
  };
  const doubaoKey = String(req.headers['x-doubao-key'] || (REQUIRE_USER_KEY ? '' : process.env.DOUBAO_API_KEY) || '').trim();
  const qwenKey = String(req.headers['x-qwen-key'] || (REQUIRE_USER_KEY ? '' : process.env.QWEN_API_KEY) || '').trim();
  const list = [];
  if (doubaoKey) list.push({
    id: 'doubao', label: '豆包',
    key: doubaoKey,
    model: model(req.headers['x-doubao-model'], 'doubao-seed-1-6-250615'),
    url: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
  });
  if (qwenKey) list.push({
    id: 'qwen', label: '千问',
    key: qwenKey,
    model: model(req.headers['x-qwen-model'], 'qwen-plus'),
    url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
  });
  return { multi, list: multi ? list : [] };
}

function toOpenAIMessages(messages) {
  return messages.map((m) => {
    const text = Array.isArray(m.content)
      ? m.content.filter((b) => b && b.type === 'text').map((b) => String(b.text || '')).join('\n')
      : String(m.content || '');
    return { role: m.role, content: text.trim() };
  }).filter((m) => m.content);
}

async function askPeer(peer, { system, messages }) {
  const body = {
    model: peer.model,
    messages: [
      { role: 'system', content: `${system}\n\n【协作身份】你是${peer.label}，作为独立复核老师回答同一个问题。用 300—600 字给出结论、要件和易错点；只依据教材和法硕口径，不引用资料编号，不编造案例；如果与主答可能不同，直接指出分歧。` },
      ...toOpenAIMessages(messages),
    ],
    temperature: 0.2,
    max_tokens: 1400,
    stream: false,
  };
  const r = await fetch(peer.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${peer.key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${peer.label} ${r.status}: ${text.slice(0, 180)}`);
  let j;
  try { j = JSON.parse(text); } catch { throw new Error(`${peer.label} 返回格式异常`); }
  const answer = j.choices?.[0]?.message?.content;
  if (!answer) throw new Error(`${peer.label} 没有返回内容`);
  return String(answer).trim();
}

function buildMessages(history) {
  const out = [];
  for (const m of history) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const rawText = String(m.content || '').trim();
    const text = m.role === 'user' ? rawText.slice(0, 8000) : rawText.slice(0, 4000);
    const imgs = Array.isArray(m.images) ? m.images.filter(Boolean).slice(0, 5) : [];
    if (!text && !imgs.length) continue;
    if (m.role === 'assistant') {
      const clean = text.replace(/〔资料\s*\d+〕/g, '');
      if (clean) out.push({ role: 'assistant', content: [{ type: 'text', text: clean }] });
      continue;
    }
    const blocks = [];
    if (text) blocks.push({ type: 'text', text });
    for (const dataUrl of imgs) {
      const mm = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
      if (!mm) continue;
      if (mm[2].length > 3_200_000) continue;
      blocks.push({ type: 'image', source: { type: 'base64', media_type: mm[1], data: mm[2] } });
    }
    if (blocks.length) out.push({ role: 'user', content: blocks });
  }
  // Merge consecutive same-role turns; Anthropic requires alternating user/assistant.
  const merged = [];
  for (const msg of out) {
    const last = merged[merged.length - 1];
    if (last && last.role === msg.role) {
      last.content = Array.isArray(last.content) && Array.isArray(msg.content)
        ? [...last.content, ...msg.content]
        : msg.content;
    } else merged.push(msg);
  }
  while (merged.length && merged[0].role !== 'user') merged.shift();
  return merged;
}

// ---------- prompt ----------
function buildSystemPrompt({ subject, mode, sources, contextBrief, sourceChars = 1100, query = '' }) {
  const eff = subject && subject !== '全部' ? subject : '自动判断';
  const detail = mode === 'detail'
    ? '详细模式：可以展开到 1000—1600 字，但仍须句句有用。'
    : '简洁模式：总长 350—700 字，能一句说清就不写三句。';
  const material = sources.length
    ? sources.map((s) => {
        let loc;
        if (String(s.source).includes('B站2027课程')) loc = `视频第${s.page}讲`;
        else if (String(s.source).includes('最高法指导性案例')) loc = '最高法指导性案例';
        else if (String(s.source).includes('最高检指导性案例')) loc = '最高检指导性案例';
        else if (String(s.source).includes('司法解释')) loc = '司法解释官方索引';
        else if (String(s.source).includes('指导性案例')) loc = '指导性案例';
        else loc = `PDF第${s.page}页`;
        const link = s.link ? `\n链接：${s.link}` : '';
        return `〔资料${s.n}〕${s.title}｜${loc}${link}\n${stripTeacherNames(sourceExcerpt(s, query, sourceChars))}`;
      }).join('\n\n')
    : '（本轮没有检索到直接相关的资料。不要因此拒答：先用你自己的法律分析搭框架，再说明哪些属于通行理解。）';

  return `你是「Sage」，一位有经验的法硕辅导老师。你不是教材复读机，而是能把问题想透、讲透，并带着学生迁移到新题的人。

【先思考，再回答】
1. 先判断用户真正问什么，尤其是追问里的“那、这、它、上述、继续”指代什么。结合对话历史理解意图，不要把每一问都当成孤立新题。
2. 先自己搭分析框架：争点是什么 → 规则/要件 → 本案涵摄 → 结论 → 易混与迁移。教材用于校准术语、观点和边界，不是逐字照抄的台词。
3. 允许你推理、比较、举例、反问、总结口诀、指出出题陷阱；鼓励把教材逻辑迁移到新案例，而不是只复述书上的原句。
4. 用户问“为什么”“如果改成……”时，要正面回应假设，展示推理过程，不要用“教材如此规定”搪塞。
5. 若用户明显开启新话题（“换个问题”“另外”），按新问题处理；否则默认承接上文，不重复已讲过的内容。

【教材与观点】
1. 法硕答题的基准顺序是：《2027法硕考试分析》与法硕教材口径 → 法硕精讲/背诵一本通与课程 → 现行法/司法解释补强。不得用《法考》的二阶层、三阶层、法考少数说替换法硕教材的犯罪构成和判断顺序；教材明确采用的观点除外。
2. 教材存在多种观点时，先给法硕教材主线，再用一小段说明争议与应试取舍；不要把法考通说直接写成法硕通说。
3. 材料没有直接覆盖时，明确写“本轮材料没有直接覆盖”，只能标“按一般法理分析”，不得写成教材/法条原文，也不得用模型记忆冒充法硕教材观点。
4. 教材与现行法冲突时，以法硕备考口径为主，并提示冲突；不得用新法条直接推翻教材结论而不说明。
5. 观点题、学说题按“结论 → 教材主线 → 理由/要件 → 其他观点 → 法硕答题采哪一观点 → 易混点”写；不要把少数说写成通说，也不要把法考观点混进来。
6. 刑法按法硕教材/背诵一本通的犯罪构成、共同犯罪、财产犯罪表述；民法按法硕教材/背诵一本通的法律行为、物权变动、合同、侵权表述。教材内部有差异时按教材呈现，不自行“统一”。
7. 结论必须能在【参考材料】中找到依据；材料与模型记忆冲突时，以材料为准。不要先凭记忆作答再补材料。

【材料核对】
1. 每个结论先在【参考材料】中找直接依据；找不到就明确“材料未覆盖”，只能给一般法理分析，不得说“教材认为”“考试分析认为”。
2. 观点优先级：考试分析/教材 > 背诵一本通/课程 > 口诀/个人总结；冲突时先说明差异，再按法硕应试口径取舍。
3. 数字、年份、法条号、案例号、页码没有在材料中出现，不得编造；只写规范名称，不写具体编号。
4. 作答前自检：结论、构成要件、例外、案例编号是否都有材料支撑；没有支撑就降级表述或标注不确定。

【新增背诵书与指导性案例】
1. 参考材料包括《27法理学背诵一本通》《27法制史背诵一本通》《27刑法背诵一本通》《27宪法学背诵一本通》《最高人民法院历年指导性案例汇编》，以及此前所有教材、课程、案例、口诀资料。回答时综合检索，不得只看新资料，也不得只看旧资料。
2. 背诵一本通用于校准法硕口径、构成要件、易错点和口诀；与旧资料冲突时，先按法硕教材/背诵一本通主线，再说明差异。
3. 指导性案例不受科目限制。用户问“有没有类似案例/相关案例”时，先理解案情、行为结构、争点，不要死抠当事人姓名、金额、案名；大致案情能对上，就给类似案例。
4. 总结指导性案例按“案情—争点—裁判要点—参考意义”，并写明“指导性案例第X号”；材料有官方链接才附链接，没有链接只给编号；不得编造编号、案名、链接。
5. 口诀：用户没有直接问口诀，但问题有对应口诀时，可以附一句；必须与材料一致；材料没有明确标注口诀原文就不编。

【法硕高频转化犯校验】
1. 非法拘禁：拘禁行为本身致人重伤、死亡的，定非法拘禁罪的结果加重犯；使用暴力致人伤残的，定故意伤害罪；使用暴力致人死亡的，定故意杀人罪。
2. 为索取债务非法拘禁并使用暴力致人死亡的，同样定故意杀人罪一罪，不再定非法拘禁罪。
3. 不要把“非法拘禁使用暴力致人死亡”写成“故意伤害致人死亡”，也不要把“拘禁行为本身致死”写成转化犯。
4. 涉及“非法拘禁＋死亡”时，必须先按上述规则复核，再写结论；与模型的一般刑法记忆冲突时，以法硕考试分析/教材通说和本条为准。

【口诀还原】
1. 用户问“口诀、记忆、背诵、带背、视频里怎么说”时，必须先在【参考材料】的“B站2027课程/背诵一本通”中找原文；找到后按“口诀原文 → 逐词对应 → 教材解释/例外 → 易错点”回答。
2. 口诀原文必须保持词序、词数和结构，只允许把明显的同音错字改成教材术语；不得改写、增删、换顺序，也不得用相近口诀替代。
3. 材料没有检索到该口诀原文时，明确写“这轮没有找到可直接引用的口诀原文”，再按教材逻辑讲；不得凭记忆冒充课程/教材原话，也不得把其他老师或法考口诀混进来；没有原文就只讲法律逻辑，不要补“记忆线索/背诵逻辑/一句话记法”。
4. 用户只要口诀时，先给完整口诀，再解释；不要用大段理论淹没口诀本身。
5. 材料中没有课程/教材原口诀时，**不得自创口诀、顺口溜、记忆公式、对仗句、缩略语或“我帮你归纳”的口诀**；也不得用“判断主线”“一句话记法”“记忆抓手”“记忆线索”“背诵逻辑”“做题口诀”“换作我”等名义给出自创记忆句。只能用普通分点讲清区别和判断顺序；只有材料明确标注是口诀/速记/背诵逻辑原文时才引用。
6. 只要本题材料中有对应口诀，**正文第一行必须先给口诀本身**（写成“口诀：…”），不要先写结论、出处、引入或“根据…”；给完口诀再逐词、要件、例外和易错点。用户问的是构成要件、异同、区别，也按这个顺序。
7. 用户上传的《刑法速记口诀》《宪法学口诀》属于用户提供的口诀资料，涉及口诀、记忆、背诵时优先检索；引用其中的口诀要保持原文，不得自行改编。若与教材/课程冲突，先按教材/课程主线，再说明差异。
8. 用户没有直接问口诀，但问题明显对应某个口诀时，只有在【参考材料】明确标注“口诀/速记/记忆口诀/背诵口诀/背诵逻辑”时才附一句“口诀：…”；材料没有明确标注就不要附，也不要把教材普通表述改写成口诀。
9. 不得声称“课程/精讲用的是一条判断主线”来变相给口诀；也不得用“非口诀/不算口诀/原文表述/记忆线索”包装自创内容。材料没写口诀，就直接用普通分点讲。

【科目与检索】
1. 用户选择具体科目（刑法/民法/法理/宪法/法制史）时，只依据该科目及其官方资料回答，不要混入其他科目内容。
2. 用户选择“全部”时，先判断问题涉及哪些科目，再综合调用全部相关资料；跨科目问题可以同时使用多个科目材料。
3. 科目判断不确定时，优先按题干中的部门法、罪名、制度关键词判断，不要只凭题目标题。
4. 具体科目下检索不到足够材料时，可以按该科目基本原理推导，但要说明是原理分析，不要伪造教材内容。

【表达与等价问题】
1. 回答正文开头和段落中不得出现“根据你上传的《……》”“你提供的资料”“材料里”“参考材料”“视频里”“字幕”“PDF”“资料显示”等出处提示；直接给结论、口诀和解释。只有用户明确问“来源/出处/原文/根据什么”时才说明。
2. “异同、对比、比较、区别、联系、辨析、区分”视为同一类比较题；同一个法律问题要用同一套结论、同一套结构和同一个口诀，不能因为措辞不同就换口诀或换答案。
3. “构成要件、成立条件、成立要件”视为同一个问题；“怎么区分、区别是什么、异同”按同一争点处理。先识别实质问题，不要死抠字眼。
4. 同一考点的口诀一旦从资料中确认，换一种问法也要保持一致；不要每次重新编一套。

【官方案例与司法解释】
1. 官方材料分三类：最高法指导性案例（含《最高人民法院历年指导性案例汇编》）、最高检指导性案例（仅索引）、最高法/最高检司法解释（仅索引）。索引材料只能用于核对名称、案号和链接，不能当条文原文引用。
2. 用户问“这个案件有没有相似的指导性案例 / 最高法最高检有没有类似案例”时，只从“最高法指导性案例/最高人民法院历年指导性案例汇编”“最高检指导性案例”材料中找；找到就给 **指导性案例编号 / 检例编号 + 官方链接（如果有）**，可简要说明相似点；没有就明确说“没有找到相似的指导性案例”。不得编造案号、案名、链接，也不得拿普通案例冒充指导性案例。
3. 用户描述案情问相似案例时，先按案由、行为方式、争点检索，不要因为案名与描述不完全一样就直接说没有；有相近条目就列出并说明相似点和差异；只有确实没有时才回答没有。不能把“没有同名案件”当成“没有相似案例”。
4. 材料中标注“引用限制：未经授权不得转载、摘编或建立镜像”的（主要是最高检页面），**不得引用原文、不得逐字复述**；可以给编号、标题、官方链接和基于标题/关键词的相似点，具体内容改用教材/讲义表述。不要向用户解释“我没有引用”“有版权风险”“不能转载”，直接自然作答即可。
5. 标题含“修改决定”“废止”“失效”的文件，以及旧版本，不得作为现行有效司法解释引用；不要把它们混入现行规则。
6. 司法解释索引只用于确认名称、文号和链接；具体答题仍以教材/课程口径为主，索引不能替代条文。
7. 对没有引用限制的指导性案例，可以参考关键词、裁判要点、基本案情、裁判结果做概括性说明，但不要逐字复述全文，不要大段复制裁判理由。
8. 不要补充材料中没有的其他案例编号、案名或裁判要点。不要因为检索结果少就断言“最高法/最高检所有案例都集中在某领域”；只能表述为“本轮没有检索到”。
9. 用户明确要求来源或链接时，给出官方链接；这是答案内容，不是来源列表。其他情况下不要附来源列表。

【准确性红线】
1. 不得编造法条、司法解释、案例、页码、真题年份。记不清条文号时，只写规范名称，不写条号。
2. 司法解释仅限现行有效的最高人民法院、最高人民检察院解释，写全称；已废止的不得引用；不确定是否现行有效时，用“相关司法解释”而不是编造名称或条号。
3. 案例只可引用最高人民法院、最高人民检察院指导性案例、公报案例或二者公开发布的典型案例；引用具体案件时必须写出指导性案例编号（如“检例第47号”）或公报案例年份期号。写不出编号就不要写案名，改用“类似案件的处理”。不得引用基层法院、普通媒体或虚构案例。
4. 指导性案例和司法解释是“补强”，不是每道题都必须引；教材已经讲清时，不要为了显得权威硬塞案例。教材观点与司法解释冲突时，先交代教材口径，再说明司法解释的补充作用。
5. 回答正文不要出现“〔资料n〕”“参考来源”“参考依据”“第x页”或任何来源列表；直接作答。只有用户明确追问“你依据什么 / 参考哪里 / 原文怎么说”时，才用一段教材或法条原文回应，并说明出处；不要把来源附在每次回答后面。
6. 不确定就明说，宁可少答，不可错答；不要把“推测”写成“教材原文”。

【表达】
1. 结论先行，再依据、要件、涵摄、易混。选择题说明正确项理由，必要时逐项排除。
2. 观点题用“结论 → 教材主线 → 理由/要件 → 其他观点 → 法硕取舍 → 易混点”的结构；没有观点分歧就不要硬造分歧。
3. 用户发图片时，你会收到一段“图片识别出的题目”。先用一行复述题干和问题（选择题连选项一起核对），确认题号、数字、年份、主体、行为、结果和否定词，再作答；多题按题号逐题回答。图片与识别文字冲突时，以图片中清楚可见的内容为准；看不清就写“看不清”，不要猜题。
4. 与法硕考试无关的问题，礼貌拒绝并拉回。
5. ${detail}
6. 使用 Markdown，小标题用 **加粗**，不要用一级标题；多用短句、分点、对比。
7. 当前备考周期为 2027 法硕；法律依据以现行有效规范为准。真题只有确有把握时才写明年份题号。
8. 回答中不要出现具体老师姓名；需要指代时用“教材”“课程”“通说”。
9. 长案例、多小问：先用 1—3 行分别给出每个小问的结论，再展开理由；正文必须尽早出现，不要把全部内容压在思考里。若输出额度紧张，优先保证每个小问都有结论和核心依据。

【本轮信息】
当前科目倾向：${eff}
${contextBrief ? `【对话上下文】\n${contextBrief}\n` : ''}
【参考材料】
${material}`;
}

// ---------- HTTP helpers ----------
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function readBody(req, limit = 24 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.pdf': 'application/pdf',
};

async function serveGit(req, res, pathname) {
  const prefix = '/repo/sage.git/';
  if (!pathname.startsWith(prefix)) { res.writeHead(404); res.end('not found'); return; }
  let rel;
  try { rel = decodeURIComponent(pathname.slice(prefix.length)); } catch { res.writeHead(400); res.end('bad path'); return; }
  const root = path.join(ROOT, 'gitrepo-work', '.git');
  const file = path.normalize(path.join(root, rel));
  if (!file.startsWith(root)) { res.writeHead(403); res.end('forbidden'); return; }
  try {
    const stat = await fsp.stat(file);
    if (stat.isDirectory()) throw new Error('dir');
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    fs.createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }
}

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); res.end('forbidden'); return; }
  try {
    const stat = await fsp.stat(file);
    if (stat.isDirectory()) throw new Error('dir');
    const ext = path.extname(file).toLowerCase();
    const noStore = ['.html', '.js', '.mjs', '.css'].includes(ext);
    const headers = {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': noStore ? 'no-store' : 'public, max-age=3600',
      ...(noStore ? { 'cdn-cache-control': 'no-store', 'cloudflare-cdn-cache-control': 'no-store' } : {}),
      'x-content-type-options': 'nosniff',
    };
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404');
  }
}

// ---------- uploads ----------
function listUploads(owner = '') {
  const map = new Map();
  for (const d of readJsonl(UPLOAD_FILE)) {
    if (owner && d.owner && d.owner !== owner) continue;
    const k = `${d.subject}\u0000${d.source}`;
    if (!map.has(k)) map.set(k, { name: d.source, subject: d.subject, pages: 0, chars: 0, uploaded: true });
    const item = map.get(k);
    item.pages++;
    item.chars += (d.text || '').length;
  }
  return [...map.values()];
}

async function extractImageQuestion(auth, images) {
  if (!Array.isArray(images) || !images.length) return { text: '', usage: null };
  const blocks = [{
    type: 'text',
    text: `你是严谨的法硕题目 OCR。只提取图片中的题目，不要解答、不要分析、不要补充图片没有的内容。
按下面格式逐字输出：
【题干】……
【选项】A. …… B. ……（有选项才写）
【问题】……
要求：
1. 数字、年份、主体、行为、结果、否定词必须准确；看不清的字写〔不清〕，不要猜。
2. 图片里有多道题时，按题号分开。
3. 不要输出“答案是”“解析”等图片中没有的内容。`,
  }];
  for (const dataUrl of images.slice(0, 5)) {
    const mm = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl));
    if (!mm) continue;
    blocks.push({ type: 'image', source: { type: 'base64', media_type: mm[1], data: mm[2] } });
  }
  if (blocks.length === 1) return { text: '', usage: null };
  for (let attempt = 0; attempt < 2; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), attempt === 0 ? 30000 : 45000);
    try {
      const r = await fetch(`${API_BASE.replace(/\/$/, '')}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...auth },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 3000,
          temperature: 0,
          system: '你是题目识别器，只做逐字转录，不回答问题。',
          messages: [{ role: 'user', content: blocks }],
          output_config: { effort: 'low' },
          stream: false,
        }),
        signal: ac.signal,
      });
      if (!r.ok) {
        if (attempt === 0) continue;
        return { text: '', usage: null };
      }
      const j = await r.json();
      const text = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
      if (text.length >= 2) return { text: text.slice(0, 8000), usage: j.usage || null };
      if (attempt === 0) continue;
      return { text: '', usage: j.usage || null };
    } catch {
      if (attempt === 0) continue;
      return { text: '', usage: null };
    } finally {
      clearTimeout(timer);
    }
  }
  return { text: '', usage: null };
}

// 普通 6 位密码用户要求恢复/重置/增加额度、次数时，直接拒绝，避免诱导模型改额度。
// 只匹配“恢复类动作 + 额度类词”挨得很近的短句；正常法律问题里的“恢复原状”“犯罪次数”不会命中。
const QUOTA_WORD = '(?:额度|次数|余额|配额|剩余次数|剩余额度|剩余配额|可用次数|可用额度|原有额度|原有次数|初始额度|初始次数|原来额度|原来次数|原本额度|原本次数|\\d{2,5}\\s*次)';
const QUOTA_ACTION = '(?:恢复|重置|还原|回退|调回|改回|补回|复原|重设|刷新|清零|回满|补满|加回|加满|重新给|重新发放|再给|补上|补足|补到|恢复成|重置成|改成|修改|调整|设置|增加|提高|提升|减少|降低|续期|延长|扩容|回到|改到)';
const QUOTA_RESTORE_FWD = new RegExp(`${QUOTA_ACTION}[^，。！？；\\n]{0,10}${QUOTA_WORD}`);
const QUOTA_RESTORE_REV = new RegExp(`${QUOTA_WORD}[^，。！？；\\n]{0,10}${QUOTA_ACTION}`);
const QUOTA_RESTORE_EN = /(?:reset|restore|refill|replenish|increase|raise|top\s*up|add|boost|extend)[a-z\s]{0,20}(?:quota|credits?|limit|uses?|balance|allowance)|(?:quota|credits?|limit|uses?|balance|allowance)[a-z\s]{0,20}(?:reset|restored|refilled|increased|raised|topped\s*up|extended)/i;
function isQuotaRestoreRequest(text) {
  const raw = String(text || '').trim();
  if (!raw) return false;
  const compact = raw.replace(/\s+/g, '');
  return QUOTA_RESTORE_FWD.test(compact) || QUOTA_RESTORE_REV.test(compact) || QUOTA_RESTORE_EN.test(raw);
}

// ---------- chat ----------
async function handleChat(req, res, owner = '', session = null) {
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: '请求格式错误' }); }
  const convId = String(body.conversationId || '').slice(0, 80);
  const incoming = Array.isArray(body.messages) ? body.messages.slice(-40) : [];
  const history = mergeHistory(convId, incoming);
  const subject = SUBJECTS.includes(body.subject) ? body.subject : '全部';
  const mode = body.mode === 'detail' ? 'detail' : 'brief';
  const lastUser = [...history].reverse().find((m) => m && m.role === 'user');
  const query = lastUser ? String(lastUser.content || '') : '';
  if (!query && !(lastUser?.images?.length)) return sendJson(res, 400, { error: '请输入问题' });

  const manageCmd = query.trim();
  const isTempCode = manageCmd === '临时111';
  const isManageDelete = /^\/manage删除\s*[+＋]?\s*(\d{6})$/.test(manageCmd);
  const isManageImport = manageCmd.startsWith('/manage导入');
  const isManageExport = manageCmd === '/manage导出';
  const isUsageQuery = manageCmd === '/查询用量';
  const isMasterUsageQuery = manageCmd === '/站长查询用量';
  const isSetMasterHistory = manageCmd.startsWith('/设置历史站长用量');
  const isMasterViewCode = /^\d{6}$/.test(manageCmd) && session?.role === 'master';
  if (manageCmd === '/manage' || manageCmd === '/manage1' || isTempCode || isManageDelete || isManageImport || isManageExport || isUsageQuery || isMasterUsageQuery || isSetMasterHistory || isMasterViewCode) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const send = (event, data) => {
      if (res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    let answer;
    if (!session || session.role !== 'master') {
      answer = isManageDelete
        ? '只有站长密码登录后，才能删除答疑密码。'
        : isManageImport || isManageExport
          ? '只有站长密码登录后，才能导入或导出答疑密码。'
          : isUsageQuery || isMasterUsageQuery || isSetMasterHistory
            ? '只有站长密码登录后，才能查询或设置用量。'
            : '只有站长密码登录后，才能生成新的答疑密码。';
    } else if (isManageDelete) {
      const code = manageCmd.match(/^\/manage删除\s*[+＋]?\s*(\d{6})$/)[1];
      const rec = guestCodes.get(code);
      if (!rec) {
        answer = `密码 ${code} 不存在，或已经用完作废。`;
      } else {
        if (rec.activeSid) sessions.delete(rec.activeSid);
        guestCodes.delete(code);
        await saveGuestCodes();
        void saveSessions();
        answer = `已永久删除答疑密码：${code}\n该密码立即失效，无法再登录；正在使用它的设备也会退出。`;
      }
    } else if (isMasterViewCode) {
      const code = manageCmd;
      const rec = guestCodes.get(code);
      answer = rec
        ? `答疑密码：${code}\n剩余次数：${Math.max(0, Number(rec.remaining) || 0)} 次\n类型：${rec.usesOwnerKey === false ? '使用者自带 DeepSeek Key' : '站长 DeepSeek 额度'}\n状态：${rec.activeSid ? '已有设备登录' : '尚未登录'}\n已用预算：${codeHasBudget(rec) && CODE_BUDGET > 0 ? `${formatMoney(rec.spent)} / ¥${CODE_BUDGET}` : `${formatMoney(rec.spent)}（无上限）`}`
        : `密码 ${code} 不存在，或已经用完作废。`;
    } else if (isManageExport) {
      const list = [...guestCodes.entries()].sort((a, b) => (a[1].createdAt || 0) - (b[1].createdAt || 0));
      answer = list.length
        ? `共 ${list.length} 个答疑密码：\n` + list.map(([code, rec]) =>
          `${code}  剩余 ${Math.max(0, Number(rec.remaining) || 0)} 次  ${rec.usesOwnerKey === false ? '自带 Key' : '站长额度'}  ${rec.activeSid ? '已登录' : '未登录'}  已用 ${codeHasBudget(rec) && CODE_BUDGET > 0 ? `${formatMoney(rec.spent)} / ¥${CODE_BUDGET}` : `${formatMoney(rec.spent)} / 不限`}`).join('\n')
        : '当前没有可用的答疑密码。';
    } else if (isManageImport) {
      const bodyText = manageCmd.replace(/^\/manage导入\s*/, '');
      const lines = bodyText.split(/[\n\r；;]+/).map((s) => s.trim()).filter(Boolean);
      const imported = [];
      for (const line of lines) {
        const codeMatch = line.match(/^(\d{6})\b/);
        if (!codeMatch) continue;
        const code = codeMatch[1];
        const rest = line.slice(codeMatch[0].length);
        const numMatch = rest.match(/(\d{1,7})/);
        if (!numMatch) continue;
        const remaining = Math.max(0, Math.min(1000000, Number(numMatch[1]) || 0));
        const usesOwnerKey = !/(自带|own|self)/i.test(rest);
        const old = guestCodes.get(code);
        guestCodes.set(code, {
          remaining,
          limit: old ? Math.max(Number(old.limit) || remaining, remaining) : remaining,
          spent: Math.max(0, Number(old?.spent) || 0),
          activeSid: old?.activeSid || null,
          createdAt: old?.createdAt || nowMs(),
          usesOwnerKey,
        });
        imported.push(`${code}  剩余 ${remaining} 次  ${usesOwnerKey ? '站长额度' : '自带 Key'}`);
      }
      if (imported.length) {
        await saveGuestCodes();
        answer = `已导入 ${imported.length} 个答疑密码：\n${imported.join('\n')}\n\n导入只恢复密码和剩余次数，不改变现有额度规则。`;
      } else {
        answer = '没有识别到可导入的密码。格式示例：\n/manage导入 123456 210\n/manage导入 123456 210 own\n每行一个；own 表示该密码需要使用者自带 DeepSeek Key。';
      }
    } else if (isUsageQuery) {
      const g = usageStats.guest;
      const s = usageStats.self;
      answer = `随机 6 位密码用户用量（按 DeepSeek API 估算）\n已记录：${g.questions} 题，${formatMoney(g.cost)}\n历史估算：${g.historicalQuestions} 题，${formatMoney(g.historicalCost)}\n合计：${formatMoney(g.cost + g.historicalCost)}\n自带 Key 用户：${s.questions} 题，${formatMoney(s.cost)}（不计入站长余额）`;
    } else if (isMasterUsageQuery) {
      const m = usageStats.master;
      const g = usageStats.guest;
      const s = usageStats.self;
      const total = m.cost + m.historicalCost + g.cost + g.historicalCost;
      answer = `站长账号 Sage 总用量（按 DeepSeek API 估算）\n站长本人提问：${m.questions} 题，${formatMoney(m.cost)}\n站长历史补录：${formatMoney(m.historicalCost)}\n随机密码用户（站长额度）：${g.questions} 题，${formatMoney(g.cost)}\n随机密码历史估算：${g.historicalQuestions} 题，${formatMoney(g.historicalCost)}\n合计：${formatMoney(total)}\n自带 Key 用户（不计入）：${s.questions} 题，${formatMoney(s.cost)}\n\n历史站长本人未补录可发：/设置历史站长用量 金额`;
    } else if (isSetMasterHistory) {
      const amountText = manageCmd.replace(/^\/设置历史站长用量\s*/, '').trim();
      if (!/^\d+(?:\.\d{1,4})?$/.test(amountText)) {
        answer = '格式：/设置历史站长用量 12.34\n用于补录功能上线前的站长本人 Sage 用量；随机密码历史会自动估算。';
      } else {
        const amount = Math.min(100000, Number(amountText) || 0);
        usageStats.master.historicalCost = amount;
        usageStats.updatedAt = nowMs();
        await saveUsage();
        answer = `已设置站长历史用量：${formatMoney(amount)}\n说明：上线前的站长 Sage 提问没有流水，无法自动精确回溯；随机密码历史会按现有密码已用次数自动估算。`;
      }
    } else {
      const selfKey = manageCmd === '/manage1';
      const limit = isTempCode ? 25 : selfKey ? 500 : 260;
      let code;
      do { code = String(crypto.randomInt(100000, 1000000)); } while (guestCodes.has(code));
      guestCodes.set(code, { remaining: limit, limit, spent: 0, activeSid: null, createdAt: nowMs(), usesOwnerKey: !selfKey });
      await saveGuestCodes();
      const budgetLine = CODE_BUDGET > 0 && limit <= 260 ? `\n\n单码预算上限：¥${CODE_BUDGET}；达到后停止回答，剩余次数不扣。` : '';
      if (isTempCode) {
        answer = `已生成临时答疑密码：${code}\n\n剩余答疑次数：25 次\n类型：站长 DeepSeek 额度\n使用规则：单次临时密码，仅限一台浏览器或设备登录；换设备登录后，旧设备会自动退出。${budgetLine}`;
      } else if (selfKey) {
        answer = `已生成新的答疑密码：${code}\n\n剩余答疑次数：500 次\n这个密码必须由使用者填写自己的 DeepSeek API Key，不能使用站长额度。\n使用规则：长期有效，仅限一台浏览器或设备登录；换设备登录后，旧设备会自动退出。${budgetLine}`;
      } else {
        answer = `已生成新的答疑密码：${code}\n\n剩余答疑次数：260 次\n使用规则：这个密码长期有效，仅限一台浏览器或设备登录；换设备登录后，旧设备会自动退出。\n\n把密码发给对方即可，不要再公开发到群里。${budgetLine}`;
      }
    }
    send('meta', { sources: [], model: MODEL, peers: [], quota: session?.role === 'guest' ? guestQuota(session) : null, manage: true });
    send('delta', { text: answer });
    send('final', { text: answer });
    send('done', {});
    res.end();
    return;
  }

  if (Array.from(query.replace(/\s/g, '')).length > 8000) {
    return sendJson(res, 400, { error: '单次输入不能超过 8000 字（不计空格）' });
  }
  if (Array.isArray(lastUser?.images) && lastUser.images.length > 5) {
    return sendJson(res, 400, { error: '一次最多发送 5 张图片' });
  }
  {
    const fileList = Array.isArray(body.files) ? body.files : (body.file ? [body.file] : []);
    const fileBytes = fileList.reduce((sum, f) => {
      const size = Number(f?.size);
      if (Number.isFinite(size) && size > 0) return sum + size;
      if (typeof f?.data === 'string') return sum + Math.floor(f.data.length * 0.75);
      return sum;
    }, 0);
    if (fileBytes > 100 * 1024 * 1024) {
      return sendJson(res, 400, { error: '文件类问题不能超过 100MB' });
    }
  }

  if (session?.role === 'guest' && !guestCodes.has(session.code)) {
    return sendJson(res, 403, { error: '这个 6 位密码的额度已用完并立即作废，请输入站长新生成的 6 位密码' });
  }

  if (session?.role === 'guest' && isQuotaRestoreRequest(query)) {
    const rec = guestCodes.get(session.code);
    if (!rec || rec.activeSid !== session.id) {
      return sendJson(res, 401, { error: '该密码已在另一台设备登录，本设备已退出' });
    }
    if (Number(rec.remaining) <= 0) {
      return sendJson(res, 403, { error: '这个密码的答疑次数已用完' });
    }
    // 直接拒绝，不扣次数，也不进入模型/缓存。
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const send = (event, data) => {
      if (res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const text = '抱歉，无法完成该操作';
    send('meta', { sources: [], model: MODEL, peers: [], quota: guestQuota(session) });
    send('delta', { text });
    send('final', { text });
    send('done', {});
    res.end();
    return;
  }

  let auth = authHeaders(req, session);
  if (!auth) {
    const rec = session?.role === 'guest' ? guestCodes.get(session.code) : null;
    const msg = rec && rec.usesOwnerKey === false
      ? '这个密码需要使用你自己的 DeepSeek API Key，请到右上角设置填写'
      : '站长授权额度不可用，请联系站长或填写自己的 DeepSeek API Key';
    return sendJson(res, 403, { error: msg });
  }
  const hasImages = !!(lastUser?.images?.length);
  const usesUserKey = !!String(req.headers['x-user-api-key'] || '').trim();
  const usagePayer = usesUserKey || (session?.role === 'guest' && guestCodes.get(session.code)?.usesOwnerKey === false) ? 'self' : 'owner';
  const peersCfg = peerConfig(req);
  const peers = hasImages ? [] : peersCfg.list;

  let quota = session?.role === 'guest' ? guestQuota(session) : null;
  let quotaCharged = false;
  let quotaBefore = null;
  let quotaRecord = null;
  if (session?.role === 'guest') {
    const rec = guestCodes.get(session.code);
    if (!rec || rec.activeSid !== session.id) return sendJson(res, 401, { error: '该密码已在另一台设备登录，本设备已退出' });
    if (Number(rec.remaining) <= 0) return sendJson(res, 403, { error: '这个密码的答疑次数已用完' });
    if (CODE_BUDGET > 0 && codeHasBudget(rec) && Number(rec.spent || 0) + CODE_BUDGET_RESERVE > CODE_BUDGET) {
      return sendJson(res, 403, { error: 'sorry' });
    }
    const skip = String(req.headers['x-quota-skip'] || '') === '1';
    if (!skip) {
      quotaCharged = true;
      quotaBefore = Number(rec.remaining);
      quotaRecord = { ...rec };
      rec.remaining = Math.max(0, Number(rec.remaining) - 1);
      quota = rec.remaining;
      if (rec.remaining <= 0) {
        guestCodes.delete(session.code);
        await saveGuestCodes();
      } else {
        guestCodes.set(session.code, rec);
        await saveGuestCodes();
      }
    }
  }

  // 图片题先做一次“只识别题目”的预检，再拿识别文本去检索教材，最后才作答。
  const vision = hasImages ? await extractImageQuestion(auth, lastUser.images) : { text: '', usage: null };
  if (vision.usage) recordUsage(session?.role || 'guest', usagePayer, vision.usage, session?.role === 'guest' ? session.code : '');
  const visionText = vision.text;
  const effectiveQuery = query || visionText;
  const searchable = (visionText || query)
    .replace(/这张图|图片|图中|如图|上图|下图|主要|讲了什么|说的是什么|是什么|这道题|选什么|怎么做|请分析|分析一下/g, ' ')
    .replace(/[\s，。！？、；：]/g, '')
    .trim();
  const prevUsers = history.filter((m) => m.role === 'user').slice(0, -1).map((m) => String(m.content || '')).filter(Boolean);
  const isFollowUp = !hasImages && (/这|那|它|其|上述|刚才|继续|接着|再|为什么|怎么|如何|该案|此案|本案|还有|如果|换成|改成|确定|真的|不对|为什么/.test(effectiveQuery) || effectiveQuery.length < 16);
  const isNewTopic = /换个话题|换个问题|另外问|新问题|下一个问题|不谈这个|重新开始/.test(effectiveQuery);
  const retrievalQuery = !isNewTopic && isFollowUp && prevUsers.length
    ? [...prevUsers.slice(-2), effectiveQuery].join(' ')
    : effectiveQuery;
  const isMnemonic = /口诀|记忆|背诵|带背|视频|课程|逻辑|方法/.test(effectiveQuery);
  const isCaseLookup = /指导性案例|类似|相似|案例|案号|检例/.test(effectiveQuery);
  const isSubjectSpecific = !!subject && subject !== '全部';
  const isComplex = mode === 'detail' || isMnemonic || isCaseLookup || effectiveQuery.length > 60 ||
    /比较|分析|论述|评价|为什么|如何|区别|联系|观点|案例|计算|推理|判断顺序|展开|详细|教材|法硕|司法解释|指导性/.test(effectiveQuery);
  const sourceLimit = mode === 'detail' ? 8 : (isMnemonic || isCaseLookup) ? 8 : isSubjectSpecific ? 6 : isComplex ? 6 : 4;
  const searchQuery = isMnemonic ? `${retrievalQuery} 口诀 速记 背诵逻辑` : retrievalQuery;
  const sources = searchQuery && (visionText || !hasImages || searchable.length >= 8) ? search(searchQuery, subject, sourceLimit, owner) : [];
  const contextBrief = buildContextBrief(history, query || (visionText ? '（图片中的题目，已识别为上方题干）' : ''));
  const system = buildSystemPrompt({
    subject, mode,
    query: retrievalQuery || effectiveQuery,
    sources: sources.slice(0, mode === 'detail' ? 10 : (isMnemonic || isCaseLookup) ? 8 : isSubjectSpecific ? 6 : isComplex ? 6 : 4),
    contextBrief,
    sourceChars: mode === 'detail' ? 1400 : isMnemonic ? 1200 : isCaseLookup ? 1100 : isSubjectSpecific ? 850 : isComplex ? 900 : 700,
  });
  const messages = buildMessages(history.slice(-12));
  if (!messages.length) return sendJson(res, 400, { error: '没有可发送的消息' });
  if (visionText) {
    const last = messages[messages.length - 1];
    if (last && last.role === 'user' && Array.isArray(last.content)) {
      last.content.unshift({
        type: 'text',
        text: `【图片识别出的题目（以这段文字为准，逐字核对后再作答）】\n${visionText}\n\n如果图片与这段文字冲突，以图片中清楚可见的内容为准；看不清的字不要猜。`,
      });
    }
  } else if (hasImages) {
    const last = messages[messages.length - 1];
    if (last && last.role === 'user' && Array.isArray(last.content)) {
      last.content.unshift({
        type: 'text',
        text: '【图片 OCR 没有返回可用文字】请直接看图片作答；看不清就明确说“图片看不清”，不要猜。',
      });
    }
  }

  const payload = {
    model: MODEL,
    max_tokens: 8192,
    system,
    messages,
    temperature: 0.2,
    output_config: { effort: isComplex ? 'high' : 'medium' },
    stream: true,
  };

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const send = (event, data) => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const cacheLookup = !hasImages && !!query;
  const cacheKey = cacheLookup ? `${subject}|${mode}|${canonicalQuestion(query)}` : '';
  const cacheStore = cacheLookup && history.length <= 1 && sources.length > 0 && !docs.some((d) => d.uploaded && (d.owner || '') === owner);
  let cached = cacheKey ? answerCache.get(cacheKey) : null;
  if (cached && Date.now() - cached.at > ANSWER_CACHE_TTL) {
    answerCache.delete(cacheKey);
    cached = null;
  }
  send('meta', { sources: [], model: MODEL, peers: cached ? [] : peers.map((p) => ({ id: p.id, label: p.label, status: 'pending' })), quota });
  if (cached) {
    send('delta', { text: cached.text });
    send('final', { text: cached.text });
    send('done', { usage: null });
    res.end();
    return;
  }

  const refundQuota = async () => {
    if (!quotaCharged || !session || session.role !== 'guest' || quotaBefore == null) return;
    const rec = guestCodes.get(session.code) || { ...(quotaRecord || {}), activeSid: session.id };
    rec.remaining = quotaBefore;
    rec.activeSid = session.id;
    guestCodes.set(session.code, rec);
    await saveGuestCodes();
    quota = quotaBefore;
    send('quota', { quota });
  };

  const peerDone = new Set();
  const peerTasks = peers.map((peer) => (async () => {
    try {
      const answer = await askPeer(peer, { system, messages });
      peerDone.add(peer.id);
      send('peer', { id: peer.id, label: peer.label, status: 'done', text: answer });
      return answer;
    } catch (e) {
      peerDone.add(peer.id);
      send('peer', { id: peer.id, label: peer.label, status: 'error', error: e.name === 'TimeoutError' ? '协作超时' : '调用失败' });
      return '';
    }
  })());

  const ac = new AbortController();
  let closed = false;
  req.on('close', () => { closed = true; ac.abort(); });
  res.on('close', () => { closed = true; ac.abort(); });

  let upstream;
  try {
    upstream = await fetch(`${API_BASE.replace(/\/$/, '')}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        accept: 'text/event-stream',
        ...auth,
      },
      body: JSON.stringify(payload),
      signal: ac.signal,
    });
  } catch (e) {
    await refundQuota();
    if (!closed) send('error', { message: '连接 DeepSeek 失败，本次不扣次数，请稍后重试。' });
    res.end();
    return;
  }

  if (!upstream.ok) {
    let detail = '';
    try { detail = await upstream.text(); } catch {}
    await refundQuota();
    let msg = `DeepSeek 返回 ${upstream.status}`;
    if (upstream.status === 401) msg = 'DeepSeek 凭据失效，请在右上角“设置”中填写 API Key。';
    else if (upstream.status === 402) msg = 'DeepSeek 账户额度不足。';
    else if (upstream.status === 429) msg = '请求太频繁，请稍后再试。';
    else if (detail) { try { const j = JSON.parse(detail); msg += '：' + (j.error?.message || j.message || ''); } catch {} }
    if (!closed) send('error', { message: msg });
    res.end();
    return;
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let streamUsage = null;
  let fullText = '';
  let thinkingChars = 0;
  let thinkingSent = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let event = 'message';
        const datas = [];
        for (const line of raw.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) datas.push(line.slice(5).trim());
        }
        if (!datas.length) continue;
        let data;
        try { data = JSON.parse(datas.join('\n')); } catch { continue; }
        if (event === 'content_block_delta' && data.delta?.type === 'text_delta' && data.delta.text) {
          fullText += data.delta.text;
          send('delta', { text: data.delta.text });
        } else if (event === 'content_block_delta' && data.delta?.type === 'thinking_delta' && data.delta.thinking) {
          thinkingChars += String(data.delta.thinking).length;
          if (thinkingChars - thinkingSent >= 40) {
            thinkingSent = thinkingChars;
            send('thinking', { chars: thinkingChars });
          }
        } else if (event === 'message_delta' && data.usage) {
          streamUsage = data.usage;
        } else if (event === 'error') {
          send('error', { message: data.error?.message || '生成中断' });
        }
      }
    }
  } catch (e) {
    await refundQuota();
    if (!closed) send('error', { message: '生成中断，本次不扣次数，请重试。' });
  }
  if (!closed) {
    let checked = fullText
      .replace(/〔资料\s*\d+〕/g, '')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
    if (!checked) {
      if (streamUsage) {
        recordUsage(session?.role || 'guest', usagePayer, streamUsage, session?.role === 'guest' ? session.code : '');
      }
      const firstOutput = Number(streamUsage?.output_tokens) || 0;
      if (firstOutput >= 7800) {
        await refundQuota();
        send('error', { message: '这道题思考占满了输出额度，没有生成正文；本次不扣次数，也没有再重试。请把题目拆成两问再发。' });
        res.end();
        return;
      }
      const retried = await retryForEmpty({ system, messages, auth });
      if (retried?.text) {
        checked = retried.text.trim();
        if (retried.usage) recordUsage(session?.role || 'guest', usagePayer, retried.usage, session?.role === 'guest' ? session.code : '');
      }
    }
    if (!checked) {
      await refundQuota();
      send('error', { message: '这次没有生成有效回答，本次不扣次数，请点“重试”；如果反复出现，把题目拆成两问再发。' });
      res.end();
      return;
    }
    if (contextBrief && looksLikeContextRefusal(checked)) {
      const retried = await retryForContext({ system, messages, auth, contextBrief });
      if (retried) checked = retried;
    }
    if (!/来源|出处|原文|根据什么|依据什么|哪本书|哪个文件|引用哪里|参考哪里/.test(effectiveQuery)) {
      checked = stripMetaAttribution(checked);
    }
    send('final', { text: checked });
    if (peerTasks.length) {
      await Promise.race([
        Promise.allSettled(peerTasks),
        new Promise((resolve) => setTimeout(resolve, 15000)),
      ]);
      for (const p of peers) {
        if (!peerDone.has(p.id)) send('peer', { id: p.id, label: p.label, status: 'error', error: '协作超时' });
      }
    }
    rememberTurn(convId, lastUser?.id, query, `srv-ai-${Date.now()}`, checked || fullText);
    if (cacheStore && checked) {
      if (sources.some((s) => s.uploaded)) {
        // 不使用用户上传资料生成跨用户缓存，避免串资料
      } else {
        answerCache.set(cacheKey, { text: checked, at: Date.now() });
        if (answerCache.size > ANSWER_CACHE_MAX) {
          const first = answerCache.keys().next().value;
          if (first) answerCache.delete(first);
        }
      }
    }
    recordUsage(session?.role || 'guest', usagePayer, streamUsage, session?.role === 'guest' ? session.code : '');
    send('done', { usage: streamUsage });
  }
  res.end();
}

async function handleUpload(req, res, owner = '') {
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: '请求格式错误' }); }
  const name = String(body.name || '').trim().slice(0, 120);
  const subject = SUBJECTS.includes(body.subject) ? body.subject : '其他';
  const pages = Array.isArray(body.pages) ? body.pages : [];
  if (!name || !pages.length) return sendJson(res, 400, { error: '缺少文件内容' });
  if (pages.length > 3000) return sendJson(res, 400, { error: '文件页数过多（上限 3000 页）' });
  const old = readJsonl(UPLOAD_FILE).filter((d) => !(d.source === name && d.subject === subject && (d.owner || '') === owner));
  let chars = 0;
  const added = [];
  for (let i = 0; i < pages.length; i++) {
    const raw = String(pages[i]?.text || '').replace(/\u0000/g, '').trim();
    if (raw.length < 20) continue;
    chars += raw.length;
    added.push({ subject, source: name, book: name, owner, page: Number(pages[i]?.page) || i + 1, text: raw.slice(0, 20000), uploaded: true });
  }
  if (!added.length) return sendJson(res, 400, { error: '没有提取到可用文字（可能是扫描版 PDF）' });
  await fsp.writeFile(UPLOAD_FILE, [...old, ...added].map((d) => JSON.stringify(d)).join('\n') + '\n', 'utf8');
  rebuildIndex();
  sendJson(res, 200, { ok: true, pages: added.length, chars, uploads: listUploads(owner) });
}

async function handleDeleteUpload(req, res, name, subject, owner = '') {
  const all = readJsonl(UPLOAD_FILE);
  const left = all.filter((d) => !(d.source === name && d.subject === subject && (d.owner || '') === owner));
  if (left.length === all.length) return sendJson(res, 404, { error: '未找到该资料' });
  await fsp.writeFile(UPLOAD_FILE, left.map((d) => JSON.stringify(d)).join('\n') + (left.length ? '\n' : ''), 'utf8');
  rebuildIndex();
  sendJson(res, 200, { ok: true, uploads: listUploads() });
}

// ---------- server ----------
function applySecurityHeaders(res) {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('permissions-policy', 'camera=(), microphone=(self), geolocation=()');
  res.setHeader('cross-origin-opener-policy', 'same-origin');
  res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
  res.setHeader('content-security-policy', "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; worker-src 'self' blob:; font-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
}

function adminPage() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>管理面板 · Sage 答疑服务</title><style>
  :root{--ink:#22303f;--muted:#72849a;--line:#d7e1eb;--sage:#3f5f82}
  *{box-sizing:border-box}body{margin:0;background:#eef3f8;color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;padding:28px}
  .wrap{max-width:880px;margin:0 auto}.top{display:flex;align-items:center;gap:12px;margin-bottom:18px}.top img{width:44px;height:44px;object-fit:contain}
  h1{font-family:Georgia,"Songti SC",serif;font-size:24px;margin:0}.sub{font-size:12px;color:var(--muted);margin-top:4px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px}.card{background:#fff;border:1px solid var(--line);border-radius:12px;padding:14px}
  .card b{display:block;font-size:22px;font-family:Georgia,serif;margin-top:4px}.card span{font-size:11px;color:var(--muted)}
  .panel{background:#fff;border:1px solid var(--line);border-radius:12px;padding:16px;margin-top:12px;font-size:12.5px;line-height:1.9}
  .panel h2{font-size:13px;margin:0 0 8px;color:var(--sage)}a{color:var(--sage)}code{background:#eef3f8;padding:1px 5px;border-radius:4px;font-size:11px}
  .pill{display:inline-block;font-size:10px;background:#e8f0f8;color:var(--sage);border-radius:99px;padding:2px 8px;margin-left:6px}
  </style></head><body><div class="wrap"><div class="top"><img src="/logo.png" alt=""><div><h1>管理面板</h1><div class="sub">Sage 答疑服务 · 仅访问密码持有者可见</div></div></div>
  <div class="grid" id="cards"></div>
  <div class="panel"><h2>服务控制</h2>
  <div>公网入口：<code>https://sage-qa.onrender.com</code>（HTTPS 443）</div>
  <div>Render 内部端口：<code>PORT</code> 环境变量（默认 10000），不对公网开放；本机开发端口 <code>8787</code></div>
  <div>云端控制台：<a href="https://dashboard.render.com/web/srv-dbb0s2m7bikc73baj2h0" target="_blank" rel="noopener">Render Dashboard</a> · <a href="https://github.com/sage035101/sage035101" target="_blank" rel="noopener">GitHub 源码仓库</a></div>
  <div>修改环境变量或重启：Render 服务页 → Environment / Manual Deploy。</div>
  </div>
  <div class="panel"><h2>当前安全开关</h2><div id="flags">加载中…</div></div>
  <div class="panel"><h2>会话</h2><button onclick="fetch('/api/logout',{method:'POST'}).then(()=>location.href='/login')" style="border:1px solid var(--line);background:#fff;border-radius:8px;padding:8px 14px;cursor:pointer">退出访问</button></div>
  </div><script>
  fetch('/api/admin/status').then(r=>r.json()).then(j=>{
    const cards=[['知识库',j.docs,'条'],['去重页数',j.pages,'页'],['我的上传',j.uploads,'个'],['运行时长',Math.round(j.uptime/60),'分钟']];
    document.querySelector('#cards').innerHTML=cards.map(c=>'<div class="card"><span>'+c[0]+'</span><b>'+c[1]+'</b><span>'+c[2]+'</span></div>').join('');
    document.querySelector('#flags').innerHTML='<div>访问密码：'+(j.accessGate?'<b style="color:#3f5f82">已开启</b>':'未开启')+'</div><div>强制自带 DeepSeek Key：'+(j.requireUserKey?'<b style="color:#3f5f82">已开启</b>':'未开启')+'</div><div>模型：<code>'+j.model+'</code> · 当前会话：<code>'+(j.owner||'—')+'</code></div><div>Node：<code>'+j.node+'</code> · 环境：<code>'+j.env+'</code></div>';
  }).catch(()=>{document.querySelector('#flags').textContent='无法读取状态'});
  </script></body></html>`;
}

const server = http.createServer(async (req, res) => {
  applySecurityHeaders(res);
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = u.pathname;
  try {
    if (p === '/login') {
      if (!ACCESS_PASSWORD || sessionInfo(req)) return redirect(res, '/');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(loginPage());
    }
    if (p === '/api/login' && req.method === 'POST') {
      if (!rateLimit('login:' + clientIp(req), 10, 600000)) return sendJson(res, 429, { error: '尝试次数过多，请稍后再试' });
      if (!ACCESS_PASSWORD) return sendJson(res, 400, { error: '未设置访问密码' });
      let body;
      try { body = JSON.parse(await readBody(req, 4096)); } catch { return sendJson(res, 400, { error: '请求格式错误' }); }
      const input = String(body.password || '').trim();
      if (passwordOk(input)) {
        trimMasterSessions(5);
        createSession(req, res, { role: 'master' });
        return sendJson(res, 200, { ok: true, role: 'master', quota: null });
      }
      if (/^\d{6}$/.test(input) && guestCodes.has(input)) {
        const rec = guestCodes.get(input);
        if (!rec || Number(rec.remaining) <= 0) return sendJson(res, 403, { error: '这个密码的答疑次数已用完' });
        if (rec.activeSid) sessions.delete(rec.activeSid);
        const created = createSession(req, res, { role: 'guest', code: input, usesOwnerKey: rec.usesOwnerKey !== false });
        rec.activeSid = created.sid;
        rec.lastLogin = nowMs();
        guestCodes.set(input, rec);
        await saveGuestCodes();
        return sendJson(res, 200, { ok: true, role: 'guest', quota: Number(rec.remaining), usesOwnerKey: rec.usesOwnerKey !== false });
      }
      return sendJson(res, 401, { error: '密码不正确' });
    }
    if (p === '/api/logout' && req.method === 'POST') {
      const cur = sessionInfo(req);
      if (cur) {
        sessions.delete(cur.id);
        if (cur.role === 'guest' && cur.code) {
          const rec = guestCodes.get(cur.code);
          if (rec && rec.activeSid === cur.id) {
            rec.activeSid = null;
            guestCodes.set(cur.code, rec);
            await saveGuestCodes();
          }
        }
        void saveSessions();
      }
      clearSession(res);
      return sendJson(res, 200, { ok: true });
    }
    if (p === '/api/renew' && req.method === 'POST') {
      if (!rateLimit('renew:' + clientIp(req), 10, 600000)) return sendJson(res, 429, { error: '尝试次数过多，请稍后再试' });
      const cur = sessionInfo(req);
      if (!cur || cur.role !== 'guest') return sendJson(res, 403, { error: '只有答疑密码登录后才能续用' });
      let body;
      try { body = JSON.parse(await readBody(req, 4096)); } catch { return sendJson(res, 400, { error: '请求格式错误' }); }
      const code = String(body.code || '').trim();
      if (!/^\d{6}$/.test(code) || !guestCodes.has(code)) return sendJson(res, 401, { error: '新的 6 位密码不正确' });
      const rec = guestCodes.get(code);
      if (Number(rec.remaining) <= 0) return sendJson(res, 403, { error: '这个密码的答疑次数也已用完' });
      const old = guestCodes.get(cur.code);
      if (old && old.activeSid === cur.id) { old.activeSid = null; guestCodes.set(cur.code, old); }
      sessions.delete(cur.id);
      if (rec.activeSid) sessions.delete(rec.activeSid);
      const created = createSession(req, res, { role: 'guest', code, usesOwnerKey: rec.usesOwnerKey !== false });
      rec.activeSid = created.sid;
      rec.lastLogin = nowMs();
      guestCodes.set(code, rec);
      await saveGuestCodes();
      return sendJson(res, 200, {
        ok: true, role: 'guest', quota: Number(rec.remaining),
        usesOwnerKey: rec.usesOwnerKey !== false,
      });
    }
    if (p === '/api/health') {
      const session = sessionInfo(req);
      const auth = authHeaders(req, session);
      const pages = new Set(docs.map((d) => `${d.source}|${d.page}`)).size;
      return sendJson(res, 200, {
        ok: !!auth, docs: docs.length, pages, model: MODEL,
        requireUserKey: false, accessGate: !!ACCESS_PASSWORD,
        role: session?.role || null,
        quota: session?.role === 'guest' ? guestQuota(session) : null,
        usesOwnerKey: session?.role === 'guest' ? (guestCodes.get(session.code)?.usesOwnerKey ?? session.usesOwnerKey ?? true) : null,
        subjects: SUBJECTS.reduce((a, s) => (a[s] = docs.filter((d) => d.subject === s).length, a), {}),
        uploads: listUploads('').length,
      });
    }

    if (p === '/api/session' && req.method === 'GET') {
      const session = sessionInfo(req);
      if (!session) return sendJson(res, 401, { error: '需要登录' });
      return sendJson(res, 200, {
        ok: true, role: session.role, quota: session.role === 'guest' ? guestQuota(session) : null,
        usesOwnerKey: session.role === 'guest' ? (guestCodes.get(session.code)?.usesOwnerKey ?? session.usesOwnerKey ?? true) : null,
      });
    }

    const info = sessionInfo(req);
    if (ACCESS_PASSWORD && !info) {
      if (p === '/logo.png' || p === '/logo-mark.png' || p === '/favicon.ico') {
        return await serveStatic(req, res, p);
      }
      if (p.startsWith('/api/')) return sendJson(res, 401, { error: '需要访问密码' });
      return redirect(res, '/login');
    }
    const clientId = clientInfo(req, res).id;
    const owner = info?.role === 'master'
      ? `m:${clientId}`
      : info?.role === 'guest'
        ? `g:${info.code}:${clientId}`
        : `a:${clientId}`;

    if (p === '/admin') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(adminPage());
    }
    if (p === '/api/admin/status') {
      const pages = new Set(docs.map((d) => `${d.source}|${d.page}`)).size;
      return sendJson(res, 200, {
        ok: true, docs: docs.length, pages, model: MODEL,
        uploads: listUploads(owner).length, accessGate: !!ACCESS_PASSWORD,
        requireUserKey: false, role: info?.role || null,
        quota: info?.role === 'guest' ? guestQuota(info) : null,
        codes: guestCodes.size, store: REMOTE_CODES ? 'upstash' : 'file',
        owner: owner ? owner.slice(0, 8) + '…' : '',
        uptime: Math.round(process.uptime()), node: process.version, env: process.env.NODE_ENV || 'production',
      });
    }
    if (p === '/api/chat' && req.method === 'POST') {
      if (!rateLimit('chat:' + clientIp(req), 300, 600000)) return sendJson(res, 429, { error: '当前提问较多，请稍等几分钟再试' });
      return await handleChat(req, res, owner, info);
    }
    if (p === '/api/uploads' && req.method === 'GET') return sendJson(res, 200, { uploads: listUploads(owner) });
    if (p === '/api/uploads' && req.method === 'POST') {
      if (!rateLimit('upload:' + clientIp(req), 20, 3600000)) return sendJson(res, 429, { error: '上传过于频繁，请稍后再试' });
      return await handleUpload(req, res, owner);
    }
    if (p === '/api/uploads' && req.method === 'DELETE') return await handleDeleteUpload(req, res, u.searchParams.get('name') || '', u.searchParams.get('subject') || '', owner);
    if (p.startsWith('/api/')) return sendJson(res, 404, { error: 'not found' });
    return await serveStatic(req, res, p);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendJson(res, 500, { error: '服务器错误' });
    else res.end();
  }
});

rebuildIndex();
await initGuestCodes();
await initSessions();
await initUsage();
server.listen(PORT, HOST, () => {
  console.log(`Sage法硕答疑 running at http://127.0.0.1:${PORT}`);
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) console.log(`LAN (${name}): http://${a.address}:${PORT}`);
    }
  }
});
