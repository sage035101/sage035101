import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const KB_FILE = path.join(DATA, 'kb.jsonl');
const UPLOAD_FILE = path.join(DATA, 'uploads.jsonl');
const CRED_FILE = 'C:/Users/39713/.dsh/.credentials.yaml';
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const API_BASE = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/anthropic';
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-flash';

const SOURCE_TITLES = {  '27法硕精讲一本通-刑法学-车润海.pdf': '《法硕精讲一本通·刑法学》车润海',
  '27法硕精讲一本通-民法学-岳业鹏.pdf': '《法硕精讲一本通·民法》岳业鹏',
  '27法硕精讲一本通-法理学-杜洪波.pdf': '《法硕精讲一本通·法理学》杜洪波',
  '27法硕精讲一本通-宪法学-马峰_1.pdf': '《法硕精讲一本通·宪法学》马峰',
  '27法硕精讲一本通-法制史-龚成思_1.pdf': '《法硕精讲一本通·法制史》龚成思',
  '刑法学（95）0001.pdf': '《刑法学讲义》',
  '27年刑法母子题合集（解析版）.pdf': '《27刑法母子题·解析》于越',
  '帮信罪、诈骗共犯、掩隐罪区分解题思路及其案例分析训练(1).pdf': '《帮信罪·诈骗共犯·掩隐罪区分专题》',
  '母子题试题册_文字版.pdf': '《民法母子题·试题册》',
  '母子题解析册_文字版.pdf': '《民法母子题·解析册》',
  '法理五连鞭通用@一头大番茄(1).pdf': '《法理五连鞭·论述模板》',
};
const titleOf = (doc) => SOURCE_TITLES[doc.source] || doc.book || doc.source.replace(/\.pdf$/i, '');

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
    .replace(/下列|哪一|哪项|哪个|说法|表述|选项|正确的是|错误的是|不正确的是|关于|请|问一下|如何理解|怎么理解|是什么|有哪些/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const SYNONYMS = {
  '帮信': ['帮助信息网络犯罪活动罪', '明知', '支付结算', '情节严重'],
  '掩隐': ['掩饰、隐瞒犯罪所得', '犯罪所得', '转移', '收购'],
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

function sourceWeight(doc, query) {
  let w = 1;
  if (doc.source.includes('精讲一本通')) w += 0.12;
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

function search(query, subject = '全部', limit = 8) {
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
      if (subject && subject !== '全部' && docs[id].subject !== subject) continue;
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
      const chunks = docs.filter((d) => d.source === p.source && d.page === page);
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

function authHeaders(req) {
  const userKey = String(req.headers['x-user-api-key'] || '').trim();
  if (userKey) return { 'x-api-key': userKey };
  const envKey = String(process.env.DEEPSEEK_API_KEY || '').trim();
  if (envKey) return { 'x-api-key': envKey };
  const token = readAccountToken();
  if (!token) return null;
  return { 'x-dsh-auth-token': token };
}

function buildMessages(history) {
  const out = [];
  for (const m of history) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const text = String(m.content || '').trim();
    const imgs = Array.isArray(m.images) ? m.images.filter(Boolean).slice(0, 3) : [];
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
function buildSystemPrompt({ subject, mode, sources, contextBrief }) {
  const eff = subject && subject !== '全部' ? subject : '自动判断';
  const detail = mode === 'detail'
    ? '详细模式：可以展开到 1000—1600 字，但仍须句句有用。'
    : '简洁模式：总长 350—700 字，能一句说清就不写三句。';
  const material = sources.length
    ? sources.map((s) => `〔资料${s.n}〕${s.title}｜PDF第${s.page}页\n${s.text}`).join('\n\n')
    : '（本轮没有检索到直接相关的资料。不要因此拒答：先用你自己的法律分析搭框架，再说明哪些属于通行理解。）';

  return `你是「Sage」，一位有经验的法硕辅导老师。你不是教材复读机，而是能把问题想透、讲透，并带着学生迁移到新题的人。当前科目倾向：${eff}。

${contextBrief || ''}

【先思考，再回答】
1. 先判断用户真正问什么，尤其是追问里的“那、这、它、上述、继续”指代什么。结合对话历史理解意图，不要把每一问都当成孤立新题。
2. 先自己搭分析框架：争点是什么 → 规则/要件 → 本案涵摄 → 结论 → 易混与迁移。教材用于校准术语、观点和边界，不是逐字照抄的台词。
3. 允许你推理、比较、举例、反问、总结口诀、指出出题陷阱；鼓励把教材逻辑迁移到新案例，而不是只复述书上的原句。
4. 用户问“为什么”“如果改成……”时，要正面回应假设，展示推理过程，不要用“教材如此规定”搪塞。
5. 若用户明显开启新话题（“换个问题”“另外”），按新问题处理；否则默认承接上文，不重复已讲过的内容。

【教材与观点】
1. 刑法、民法涉及构成要件、观点取舍、判断顺序时，以【参考材料】中的法硕教材口径为校准；可以换自己的话，但不能把教材结论改掉，也不能混入法考独有观点。
2. 教材存在多种观点时，先给主线，再用一小段说明争议与应试取舍。
3. 材料没有直接覆盖的，不要动辄说“教材未涉及”。先按刑法/民法原理推导，明确区分“教材观点”与“你的解释”，再补现行法和有效司法解释。
4. 教材与现行法冲突时，以教材备考口径为主，并提示冲突。
5. 观点题、学说题按“教材主线 → 其他观点 → 法硕答题采哪一观点”三层写；不要把少数说写成通说，也不要把法考观点混进来。
6. 刑法按车润海教材的犯罪构成、共同犯罪、财产犯罪表述；民法按岳业鹏教材的法律行为、物权变动、合同、侵权表述。教材内部有差异时按教材呈现，不自行“统一”。

【准确性红线】
1. 不得编造法条、司法解释、案例、页码、真题年份。记不清条文号时，只写规范名称，不写条号。
2. 司法解释仅限现行有效的最高人民法院、最高人民检察院解释，写全称；已废止的不得引用。
3. 案例只可引用最高人民法院、最高人民检察院指导性案例、公报案例或二者公开发布的典型案例；引用具体案件时必须写出指导性案例编号（如“检例第47号”）或公报案例年份期号。写不出编号就不要写案名，改用“类似案件的处理”。不得引用基层法院、普通媒体或虚构案例。
4. 回答正文不要出现“〔资料n〕”“参考来源”“参考依据”“第x页”或任何来源列表；直接作答。只有用户明确追问“你依据什么 / 参考哪里 / 原文怎么说”时，才用一段教材或法条原文回应，并说明出处；不要把来源附在每次回答后面。
5. 不确定就明说，宁可少答，不可错答。

【表达】
1. 结论先行，再依据、要件、涵摄、易混。选择题说明正确项理由，必要时逐项排除。
2. 观点题用“结论 → 教材主线 → 理由/要件 → 其他观点 → 法硕取舍 → 易混点”的结构；没有观点分歧就不要硬造分歧。
3. 用户发图片时，你会收到一段“图片识别出的题目”。先用一行复述题干和问题（选择题连选项一起核对），确认题号、数字、年份、主体、行为、结果和否定词，再作答；多题按题号逐题回答。图片与识别文字冲突时，以图片中清楚可见的内容为准；看不清就写“看不清”，不要猜题。
4. 与法硕考试无关的问题，礼貌拒绝并拉回。
5. ${detail}
6. 使用 Markdown，小标题用 **加粗**，不要用一级标题；多用短句、分点、对比。
7. 当前备考周期为 2027 法硕；法律依据以现行有效规范为准。真题只有确有把握时才写明年份题号。

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
function listUploads() {
  const map = new Map();
  for (const d of readJsonl(UPLOAD_FILE)) {
    const k = `${d.subject}\u0000${d.source}`;
    if (!map.has(k)) map.set(k, { name: d.source, subject: d.subject, pages: 0, chars: 0, uploaded: true });
    const item = map.get(k);
    item.pages++;
    item.chars += (d.text || '').length;
  }
  return [...map.values()];
}

async function extractImageQuestion(auth, images) {
  if (!Array.isArray(images) || !images.length) return '';
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
  for (const dataUrl of images.slice(0, 3)) {
    const mm = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl));
    if (!mm) continue;
    blocks.push({ type: 'image', source: { type: 'base64', media_type: mm[1], data: mm[2] } });
  }
  if (blocks.length === 1) return '';
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 30000);
  try {
    const r = await fetch(`${API_BASE.replace(/\/$/, '')}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...auth },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1600,
        temperature: 0,
        system: '你是题目识别器，只做逐字转录，不回答问题。',
        messages: [{ role: 'user', content: blocks }],
        output_config: { effort: 'low' },
        stream: false,
      }),
      signal: ac.signal,
    });
    if (!r.ok) return '';
    const j = await r.json();
    const text = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    return text.length > 8 ? text.slice(0, 5000) : '';
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

// ---------- chat ----------
async function handleChat(req, res) {
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
  const hasImages = !!(lastUser?.images?.length);
  let auth = authHeaders(req);
  if (!auth) return sendJson(res, 401, { error: '未找到 DeepSeek 凭据，请在设置中填写 API Key' });

  // 图片题先做一次“只识别题目”的预检，再拿识别文本去检索教材，最后才作答。
  const visionText = hasImages ? await extractImageQuestion(auth, lastUser.images) : '';
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
  const sources = retrievalQuery && (visionText || !hasImages || searchable.length >= 8) ? search(retrievalQuery, subject, 8) : [];
  const contextBrief = buildContextBrief(history, query || (visionText ? '（图片中的题目，已识别为上方题干）' : ''));
  const system = buildSystemPrompt({ subject, mode, sources, contextBrief });
  const messages = buildMessages(history);
  if (!messages.length) return sendJson(res, 400, { error: '没有可发送的消息' });
  if (visionText) {
    const last = messages[messages.length - 1];
    if (last && last.role === 'user' && Array.isArray(last.content)) {
      last.content.unshift({
        type: 'text',
        text: `【图片识别出的题目（以这段文字为准，逐字核对后再作答）】\n${visionText}\n\n如果图片与这段文字冲突，以图片中清楚可见的内容为准；看不清的字不要猜。`,
      });
    }
  }

  const payload = {
    model: MODEL,
    max_tokens: mode === 'detail' ? 24576 : 12288,
    system,
    messages,
    temperature: 0.3,
    output_config: { effort: 'max' },
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
  send('meta', { sources: [], model: MODEL });

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
    if (!closed) send('error', { message: '连接 DeepSeek 失败，请稍后重试。' });
    res.end();
    return;
  }

  if (!upstream.ok) {
    let detail = '';
    try { detail = await upstream.text(); } catch {}
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
  let usage = null;
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
          usage = data.usage;
        } else if (event === 'error') {
          send('error', { message: data.error?.message || '生成中断' });
        }
      }
    }
  } catch (e) {
    if (!closed) send('error', { message: '生成中断，请重试。' });
  }
  if (!closed) {
    let checked = fullText
      .replace(/〔资料\s*\d+〕/g, '')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
    if (contextBrief && looksLikeContextRefusal(checked)) {
      const retried = await retryForContext({ system, messages, auth, contextBrief });
      if (retried) checked = retried;
    }
    if (checked !== fullText) send('final', { text: checked });
    rememberTurn(convId, lastUser?.id, query, `srv-ai-${Date.now()}`, checked || fullText);
    send('done', { usage });
  }
  res.end();
}

async function handleUpload(req, res) {
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: '请求格式错误' }); }
  const name = String(body.name || '').trim().slice(0, 120);
  const subject = SUBJECTS.includes(body.subject) ? body.subject : '其他';
  const pages = Array.isArray(body.pages) ? body.pages : [];
  if (!name || !pages.length) return sendJson(res, 400, { error: '缺少文件内容' });
  if (pages.length > 3000) return sendJson(res, 400, { error: '文件页数过多（上限 3000 页）' });
  const old = readJsonl(UPLOAD_FILE).filter((d) => !(d.source === name && d.subject === subject));
  let chars = 0;
  const added = [];
  for (let i = 0; i < pages.length; i++) {
    const raw = String(pages[i]?.text || '').replace(/\u0000/g, '').trim();
    if (raw.length < 20) continue;
    chars += raw.length;
    added.push({ subject, source: name, book: name, page: Number(pages[i]?.page) || i + 1, text: raw.slice(0, 20000), uploaded: true });
  }
  if (!added.length) return sendJson(res, 400, { error: '没有提取到可用文字（可能是扫描版 PDF）' });
  await fsp.writeFile(UPLOAD_FILE, [...old, ...added].map((d) => JSON.stringify(d)).join('\n') + '\n', 'utf8');
  rebuildIndex();
  sendJson(res, 200, { ok: true, pages: added.length, chars, uploads: listUploads() });
}

async function handleDeleteUpload(req, res, name, subject) {
  const all = readJsonl(UPLOAD_FILE);
  const left = all.filter((d) => !(d.source === name && d.subject === subject));
  if (left.length === all.length) return sendJson(res, 404, { error: '未找到该资料' });
  await fsp.writeFile(UPLOAD_FILE, left.map((d) => JSON.stringify(d)).join('\n') + (left.length ? '\n' : ''), 'utf8');
  rebuildIndex();
  sendJson(res, 200, { ok: true, uploads: listUploads() });
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (u.pathname === '/api/health') {
      const auth = authHeaders(req);
      const pages = new Set(docs.map((d) => `${d.source}|${d.page}`)).size;
      return sendJson(res, 200, {
        ok: !!auth, docs: docs.length, pages, model: MODEL,
        subjects: SUBJECTS.reduce((a, s) => (a[s] = docs.filter((d) => d.subject === s).length, a), {}),
        uploads: listUploads().length,
      });
    }
    if (u.pathname === '/api/chat' && req.method === 'POST') return await handleChat(req, res);
    if (u.pathname === '/api/uploads' && req.method === 'GET') return sendJson(res, 200, { uploads: listUploads() });
    if (u.pathname === '/api/uploads' && req.method === 'POST') return await handleUpload(req, res);
    if (u.pathname === '/api/uploads' && req.method === 'DELETE') return await handleDeleteUpload(req, res, u.searchParams.get('name') || '', u.searchParams.get('subject') || '');
    if (u.pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'not found' });
    return await serveStatic(req, res, u.pathname);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendJson(res, 500, { error: '服务器错误' });
    else res.end();
  }
});

rebuildIndex();
server.listen(PORT, HOST, () => {
  console.log(`Sage法硕答疑 running at http://127.0.0.1:${PORT}`);
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) console.log(`LAN (${name}): http://${a.address}:${PORT}`);
    }
  }
});
