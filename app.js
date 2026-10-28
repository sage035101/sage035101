import * as pdfjsLib from './vendor/pdf.min.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', import.meta.url).href;

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];

const SUBJECTS = ['全部', '刑法', '民法', '法理', '宪法', '法制史'];
const SUBJECT_NAMES = { 全部: '全部', 刑法: '刑法', 民法: '民法', 法理: '法理学', 宪法: '宪法学', 法制史: '法制史' };

const STORE_KEY = 'sage_conversations_v2';
const state = {
  subject: '全部',
  mode: localStorage.getItem('sage_mode') || 'brief',
  apiKey: localStorage.getItem('sage_key') || '',
  doubaoKey: localStorage.getItem('sage_doubao_key') || '',
  qwenKey: localStorage.getItem('sage_qwen_key') || '',
  doubaoModel: localStorage.getItem('sage_doubao_model') || 'doubao-seed-1-6-250615',
  qwenModel: localStorage.getItem('sage_qwen_model') || 'qwen-plus',
  multi: localStorage.getItem('sage_multi') !== '0',
  role: null,
  quota: null,
  usesOwnerKey: null,
  selfKeyNotice: false,
  conversations: [],
  currentId: null,
  messages: [],
  pending: [],
  streaming: false,
  abort: null,
  liveEl: null,
  liveMsg: null,
  view: 'all',
  search: '',
  mergeMode: false,
  mergeIds: new Set(),
  histMenuId: null,
  renameId: null,
  editId: null,
};

function uid() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36); }
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 2200);
}
function closeSidebar() {
  $('#sidebar').classList.remove('open');
  $('#sidebarMask').classList.remove('show');
}

/* ---------------- store ---------------- */
function newConversationObj(title = '新对话') {
  return { id: uid(), title, createdAt: Date.now(), updatedAt: Date.now(), archived: false, messages: [] };
}
function normalizeConversation(c) {
  return {
    id: c.id || uid(),
    title: c.title || '新对话',
    createdAt: Number(c.createdAt) || Date.now(),
    updatedAt: Number(c.updatedAt) || Date.now(),
    archived: !!c.archived,
    messages: Array.isArray(c.messages) ? c.messages : [],
  };
}
function titleFromMessages(messages) {
  const u = messages.find((m) => m.role === 'user' && String(m.text || '').trim());
  if (!u) return messages.some((m) => m.role === 'user' && m.thumbs?.length) ? '图片提问' : '新对话';
  let t = String(u.text).replace(/\s+/g, ' ').trim();
  return t.length > 26 ? t.slice(0, 26) + '…' : t;
}
function currentConversation() {
  let c = state.conversations.find((x) => x.id === state.currentId);
  if (!c) {
    c = newConversationObj();
    state.conversations.unshift(c);
    state.currentId = c.id;
    state.messages = c.messages;
  }
  return c;
}
function loadStore() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch {}
  if (saved && Array.isArray(saved.conversations) && saved.conversations.length) {
    state.conversations = saved.conversations.map(normalizeConversation);
    state.currentId = state.conversations.some((c) => c.id === saved.currentId) ? saved.currentId : state.conversations[0].id;
  } else {
    let old = [];
    try {
      const v1 = JSON.parse(localStorage.getItem('sage_messages_v1') || '[]');
      if (Array.isArray(v1)) old = v1;
    } catch {}
    const c = newConversationObj();
    c.messages = old;
    c.title = titleFromMessages(old);
    state.conversations = [c];
    state.currentId = c.id;
    if (old.length) localStorage.removeItem('sage_messages_v1');
  }
  state.messages = currentConversation().messages;
}
function snapshot(stripHeavy = false) {
  return state.conversations.slice(0, 50).map((c) => {
    const total = c.messages.length;
    const messages = c.messages.slice(-60).map((m, i) => ({
      id: m.id, role: m.role, text: m.text,
      sources: stripHeavy ? [] : (i >= total - 8 ? (m.sources || []).slice(0, 10) : []),
      thumbs: stripHeavy ? [] : (i >= total - 4 ? (m.thumbs || []) : []),
      imageText: m.imageText || '',
      error: !!m.error, stopped: !!m.stopped, ts: m.ts,
    }));
    return { id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt, archived: c.archived, messages };
  });
}
function persistStore() {
  const write = (data) => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(data)); return true; } catch { return false; }
  };
  const base = { version: 2, currentId: state.currentId, conversations: snapshot(false) };
  if (write(base)) return;
  const lean = { version: 2, currentId: state.currentId, conversations: snapshot(true) };
  if (write(lean)) return;
  lean.conversations = lean.conversations.slice(0, 25);
  write(lean);
}
function saveState() {
  const c = currentConversation();
  if (c) {
    c.updatedAt = Date.now();
    if ((!c.title || c.title === '新对话') && c.messages.length) c.title = titleFromMessages(c.messages);
  }
  persistStore();
}
function setCurrent(id) {
  const c = state.conversations.find((x) => x.id === id);
  if (!c) return;
  stopVoice();
  persistStore();
  state.currentId = id;
  state.messages = c.messages;
  state.pending = [];
  renderAttachments();
  renderMessages();
  renderHistory();
  closeSidebar();
}

/* ---------------- markdown ---------------- */
function inlineMd(s, sources) {
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+?)\*/g, '$1<em>$2</em>');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  s = s.replace(/〔资料\s*(\d+)〕/g, '');
  return s;
}

function mdToHtml(src, sources = []) {
  if (!src) return '';
  let text = String(src).replace(/\r\n?/g, '\n');
  const codeBlocks = [];
  text = text.replace(/```[^\n]*\n([\s\S]*?)```/g, (_, code) => {
    codeBlocks.push(code);
    return `\u0000CODE${codeBlocks.length - 1}\u0000`;
  });
  const lines = text.split('\n');
  const out = [];
  let i = 0;
  const isSpecial = (l) => /^\s*(#{1,4}\s|>\s?|[-*•]\s+|\d+[.、]\s+|\||\u0000CODE\d+\u0000\s*$)/.test(l) || /^\s*---+\s*$/.test(l);
  const renderLines = (arr) => arr.map((x) => inlineMd(esc(x), sources)).join('<br>');

  while (i < lines.length) {
    const line = lines[i];
    const trim = line.trim();
    if (!trim) { i++; continue; }
    let m;
    if ((m = /^\u0000CODE(\d+)\u0000$/.exec(trim))) {
      out.push(`<pre><code>${esc(codeBlocks[Number(m[1])] || '').replace(/\n$/, '')}</code></pre>`);
      i++; continue;
    }
    if ((m = /^(#{1,4})\s+(.*)$/.exec(trim))) {
      const level = Math.min(m[1].length + 1, 4);
      out.push(`<h${level}>${inlineMd(esc(m[2]), sources)}</h${level}>`);
      i++; continue;
    }
    if (/^---+$/.test(trim)) { out.push('<hr>'); i++; continue; }
    if (/^>\s?/.test(trim)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i].trim())) { buf.push(lines[i].trim().replace(/^>\s?/, '')); i++; }
      out.push(`<blockquote>${renderLines(buf)}</blockquote>`);
      continue;
    }
    if (/^[-*•]\s+/.test(trim)) {
      const buf = [];
      while (i < lines.length && /^[-*•]\s+/.test(lines[i].trim())) { buf.push(lines[i].trim().replace(/^[-*•]\s+/, '')); i++; }
      out.push(`<ul>${buf.map((x) => `<li>${inlineMd(esc(x), sources)}</li>`).join('')}</ul>`);
      continue;
    }
    if (/^\d+[.、]\s+/.test(trim)) {
      const buf = [];
      while (i < lines.length && /^\d+[.、]\s+/.test(lines[i].trim())) { buf.push(lines[i].trim().replace(/^\d+[.、]\s+/, '')); i++; }
      out.push(`<ol>${buf.map((x) => `<li>${inlineMd(esc(x), sources)}</li>`).join('')}</ol>`);
      continue;
    }
    if (/^\|.*\|$/.test(trim) && i + 1 < lines.length && /^\|?[\s:|-]+\|?$/.test(lines[i + 1].trim())) {
      const rows = [];
      while (i < lines.length && /^\|.*\|$/.test(lines[i].trim())) {
        rows.push(lines[i].trim().replace(/^\||\|$/g, '').split('|').map((x) => x.trim()));
        i++;
      }
      if (rows.length >= 2) {
        const head = rows[0];
        const body = rows.slice(2);
        out.push(`<table><thead><tr>${head.map((x) => `<th>${inlineMd(esc(x), sources)}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((x) => `<td>${inlineMd(esc(x), sources)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
        continue;
      }
    }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !isSpecial(lines[i])) { buf.push(lines[i]); i++; }
    if (buf.length) out.push(`<p>${renderLines(buf)}</p>`);
    else i++;
  }
  return out.join('');
}

/* ---------------- message render ---------------- */
function sourcesHtml(sources) {
  return '';
}

function peersHtml(peers) {
  if (!Array.isArray(peers) || !peers.length) return '';
  const cards = peers.map((p) => {
    const status = p.status === 'pending' ? '协作中…' : p.status === 'error' ? '调用失败' : '已完成';
    const body = p.text
      ? mdToHtml(p.text, [])
      : `<p class="peer-empty">${esc(p.error || '等待该模型返回…')}</p>`;
    const open = p.status === 'done' ? '' : ' open';
    return `<details class="peer-card ${p.status || 'pending'}"${open}>
      <summary><span class="peer-name">${esc(p.label || p.id)}</span><span class="peer-state">${status}</span></summary>
      <div class="peer-body">${body}</div>
    </details>`;
  }).join('');
  return `<div class="peers"><div class="peers-title">多模型协作</div>${cards}</div>`;
}

function messageHtml(m) {
  if (m.role === 'user') {
    const srcs = m.fulls && m.fulls.length ? m.fulls : (m.thumbs || []);
    const imgs = (m.thumbs || []).map((t, i) => `<img src="${t}" data-full="${srcs[i] || t}" class="zoomable" alt="上传的题目图片" title="点击查看大图">`).join('');
    return `<article class="msg user" data-id="${m.id}">
      <div class="avatar">你</div>
      <div class="msg-body">
        <div class="msg-meta">你</div>
        <div class="bubble">${imgs ? `<div class="user-imgs">${imgs}</div>` : ''}${esc(m.text || '')}</div>
      </div>
    </article>`;
  }
  const body = m.error
    ? `<p>${esc(m.text || '出错了，请稍后重试。')}</p><button class="retry-btn" data-retry="${m.id}">重试</button>`
    : `<div class="markdown">${mdToHtml(m.text || '', m.sources || [])}</div>${sourcesHtml(m.sources)}`;
  return `<article class="msg ai ${m.error ? 'error' : ''}" data-id="${m.id}">
    <div class="avatar">法</div>
    <div class="msg-body">
      <div class="msg-meta">Sage <span class="tag">深度思考</span>${m.context ? '<span class="tag context">承接上文</span>' : ''}${m.stopped ? '<span>· 已停止</span>' : ''}</div>
      <div class="bubble">${body}${peersHtml(m.peers)}</div>
      ${m.error ? '' : `<div class="msg-tools"><button data-copy="${m.id}">复制</button><button data-newtopic="1">新话题</button></div>`}
    </div>
  </article>`;
}

function renderMessages() {
  $('#messages').innerHTML = state.messages.map(messageHtml).join('');
  $('#welcome').style.display = state.messages.length ? 'none' : '';
  scrollBottom();
}
function openLightbox(src) {
  const box = $('#lightbox');
  if (!box || !src) return;
  $('#lightboxImg').src = src;
  box.hidden = false;
  document.body.classList.add('lightbox-open');
}
function closeLightbox() {
  const box = $('#lightbox');
  if (!box) return;
  box.hidden = true;
  $('#lightboxImg').removeAttribute('src');
  document.body.classList.remove('lightbox-open');
}
$('#lightbox')?.addEventListener('click', (e) => {
  if (e.target.id === 'lightbox' || e.target.id === 'lightboxClose') closeLightbox();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeLightbox();
});
$('#messages')?.addEventListener('click', (e) => {
  const img = e.target.closest('.user-imgs img.zoomable');
  if (!img) return;
  openLightbox(img.dataset.full || img.src);
});
function setSubject(s) {
  if (!SUBJECTS.includes(s)) return;
  state.subject = s;
  $$('#subjectBar button').forEach((b) => b.classList.toggle('active', b.dataset.subject === s));
  if (state.messages.length) toast(`已切换到${SUBJECT_NAMES[s]}`);
}
function setMode(mode) {
  state.mode = mode === 'detail' ? 'detail' : 'brief';
  localStorage.setItem('sage_mode', state.mode);
  $$('#modeSeg button').forEach((b) => b.classList.toggle('active', b.dataset.mode === state.mode));
  $('#modePill').textContent = state.mode === 'detail' ? '详细' : '简洁';
}

/* ---------------- history ---------------- */
function dateGroup(ts) {
  const d = new Date(ts), now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((start - day) / 86400000);
  if (diff <= 0) return '今天';
  if (diff === 1) return '昨天';
  if (diff <= 7) return '7 天内';
  if (diff <= 30) return '30 天内';
  return '更早';
}
function timeLabel(ts) {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    : `${d.getMonth() + 1}-${d.getDate()}`;
}
function historySub(c, q) {
  if (!q) return timeLabel(c.updatedAt);
  const hit = c.messages.find((m) => String(m.text || '').toLowerCase().includes(q));
  if (!hit) return timeLabel(c.updatedAt);
  const text = String(hit.text).replace(/\s+/g, ' ');
  const at = text.toLowerCase().indexOf(q);
  const start = Math.max(0, at - 10);
  return text.slice(start, start + 34) + (start + 34 < text.length ? '…' : '');
}
function filteredConversations() {
  const q = state.search.trim().toLowerCase();
  let list = state.conversations.filter((c) => state.view === 'archived' ? c.archived : !c.archived);
  if (q) list = list.filter((c) => c.title.toLowerCase().includes(q) || c.messages.some((m) => String(m.text || '').toLowerCase().includes(q)));
  return list.sort((a, b) => b.updatedAt - a.updatedAt);
}
function renderHistory() {
  const list = filteredConversations();
  const box = $('#historyList');
  if (!list.length) {
    box.innerHTML = `<div class="hist-empty">${state.search ? '没有找到相关对话' : (state.view === 'archived' ? '没有已归档的对话' : '还没有对话<br>问一个问题开始吧')}</div>`;
    updateMergeBar();
    return;
  }
  const groups = new Map();
  for (const c of list) {
    const key = state.search.trim() ? '搜索结果' : dateGroup(c.updatedAt);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  box.innerHTML = [...groups.entries()].map(([label, items]) => `
    <div class="hist-group">${esc(label)}</div>
    ${items.map((c) => {
      const selected = state.mergeIds.has(c.id);
      return `<div class="hist-item ${c.id === state.currentId ? 'active' : ''} ${selected ? 'selected' : ''}" data-id="${c.id}">
        ${state.mergeMode ? `<input class="hist-check" type="checkbox" data-check="${c.id}" ${selected ? 'checked' : ''}>` : ''}
        <div class="hist-main">
          <div class="h-title">${esc(c.title || '新对话')}</div>
          <span class="h-sub">${esc(historySub(c, state.search.trim().toLowerCase()))}</span>
        </div>
        ${state.mergeMode ? '' : `<button class="hist-more" data-more="${c.id}" title="更多">⋯</button>`}
      </div>`;
    }).join('')}
  `).join('');
  updateMergeBar();
}
function updateMergeBar() {
  const bar = $('#mergeBar');
  bar.hidden = !state.mergeMode;
  if (!state.mergeMode) return;
  $('#mergeCount').textContent = `已选 ${state.mergeIds.size} 项`;
  $('#btnMergeGo').disabled = state.mergeIds.size < 2;
}
function enterMergeMode(id) {
  state.mergeMode = true;
  state.mergeIds = new Set(id ? [id] : []);
  $('#btnMergeMode').classList.add('on');
  $('#btnMergeMode').textContent = '完成';
  renderHistory();
}
function exitMergeMode() {
  state.mergeMode = false;
  state.mergeIds.clear();
  $('#btnMergeMode').classList.remove('on');
  $('#btnMergeMode').textContent = '整理';
  renderHistory();
}
function toggleMerge(id) {
  if (state.mergeIds.has(id)) state.mergeIds.delete(id); else state.mergeIds.add(id);
  renderHistory();
}
function mergeSelected() {
  const chosen = state.conversations.filter((c) => state.mergeIds.has(c.id));
  if (chosen.length < 2) return toast('至少选择两段对话');
  if (!confirm(`把选中的 ${chosen.length} 段对话合并为一段？`)) return;
  chosen.sort((a, b) => b.updatedAt - a.updatedAt);
  const target = chosen[0];
  const all = chosen.flatMap((c) => c.messages).sort((a, b) => (a.ts || 0) - (b.ts || 0));
  const seen = new Set();
  target.messages = all.filter((m) => { if (seen.has(m.id)) return false; seen.add(m.id); return true; });
  if (!target.title || target.title === '新对话') target.title = titleFromMessages(target.messages);
  target.updatedAt = Date.now();
  target.archived = false;
  const remove = new Set(chosen.slice(1).map((c) => c.id));
  state.conversations = state.conversations.filter((c) => !remove.has(c.id));
  state.currentId = target.id;
  state.messages = target.messages;
  exitMergeMode();
  saveState();
  renderMessages();
  renderHistory();
  toast('已合并');
}
function deleteConversation(id) {
  if (state.streaming) return toast('请先停止当前回答');
  const c = state.conversations.find((x) => x.id === id);
  if (!c) return;
  if (!confirm(`删除「${c.title || '新对话'}」？删除后不可恢复。`)) return;
  state.conversations = state.conversations.filter((x) => x.id !== id);
  if (state.currentId === id) {
    const next = state.conversations.find((x) => !x.archived) || state.conversations[0];
    if (next) {
      state.currentId = next.id;
      state.messages = next.messages;
    } else {
      const fresh = newConversationObj();
      state.conversations.unshift(fresh);
      state.currentId = fresh.id;
      state.messages = fresh.messages;
    }
  }
  persistStore();
  renderMessages();
  renderHistory();
}
function archiveConversation(id) {
  const c = state.conversations.find((x) => x.id === id);
  if (!c) return;
  c.archived = !c.archived;
  c.updatedAt = Date.now();
  if (c.id === state.currentId && c.archived && state.view === 'all') {
    const next = state.conversations.find((x) => x.id !== c.id && !x.archived);
    if (next) {
      state.currentId = next.id;
      state.messages = next.messages;
      renderMessages();
    }
  }
  persistStore();
  renderHistory();
  toast(c.archived ? '已归档' : '已取消归档');
}
function openRename(c) {
  state.renameId = c.id;
  $('#renameInput').value = c.title || '新对话';
  $('#renameDialog').showModal();
  setTimeout(() => { $('#renameInput').focus(); $('#renameInput').select(); }, 60);
}
function openHistMenu(id, anchor) {
  const c = state.conversations.find((x) => x.id === id);
  if (!c) return;
  state.histMenuId = id;
  const menu = $('#histMenu');
  menu.querySelector('[data-act="archive"]').textContent = c.archived ? '取消归档' : '归档';
  menu.hidden = false;
  const r = anchor.getBoundingClientRect();
  const w = 132, h = 172;
  menu.style.left = Math.min(window.innerWidth - w - 8, Math.max(8, r.right - w)) + 'px';
  menu.style.top = Math.min(window.innerHeight - h - 8, r.bottom + 4) + 'px';
}
function closeHistMenu() {
  $('#histMenu').hidden = true;
  state.histMenuId = null;
}
function newConversation() {
  if (state.streaming) return toast('请先停止当前回答');
  stopVoice();
  hideVoiceHelp();
  const cur = currentConversation();
  closeHistMenu();
  if (cur && cur.messages.length === 0) {
    closeSidebar();
    input.focus();
    return;
  }
  const c = newConversationObj();
  state.conversations.unshift(c);
  state.currentId = c.id;
  state.messages = c.messages;
  state.pending = [];
  renderAttachments();
  renderMessages();
  renderHistory();
  closeSidebar();
  input.focus();
}

/* ---------------- input / images ---------------- */
const input = $('#input');
function autoResize() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 170) + 'px';
}
input.addEventListener('input', autoResize);

function renderAttachments() {
  const box = $('#attachments');
  box.classList.toggle('show', state.pending.length > 0);
  box.innerHTML = state.pending.map((p) => `<div class="att" data-id="${p.id}"><img src="${p.thumb}" data-full="${p.full}" class="zoomable" alt="待发送图片" title="点击预览"><button data-rm="${p.id}" title="移除">×</button></div>`).join('');
}
$('#attachments').addEventListener('click', (e) => {
  const b = e.target.closest('[data-rm]');
  if (b) {
    state.pending = state.pending.filter((p) => p.id !== b.dataset.rm);
    renderAttachments();
    return;
  }
  const img = e.target.closest('.att img');
  if (img) openLightbox(img.dataset.full || img.src);
});

/* Crop before adding. Files are queued so multiple selection still works. */
const cropQueue = [];
let cropBusy = false;
let cropCtx = null;

function pumpCropQueue() {
  if (cropBusy || !cropQueue.length) return;
  cropBusy = true;
  const file = cropQueue.shift();
  openCrop(file).catch(() => {
    cropBusy = false;
    finishAdd(file, null).finally(pumpCropQueue);
  });
}

function closeCropDialog() {
  const d = $('#cropDialog');
  if (d?.open) d.close();
  if (cropCtx?.url) URL.revokeObjectURL(cropCtx.url);
  cropCtx = null;
}

async function openCrop(file) {
  if (state.pending.length >= 5) {
    toast('一次最多发送 5 张图片');
    cropBusy = false;
    pumpCropQueue();
    return;
  }
  const dialog = $('#cropDialog');
  const img = $('#cropImg');
  if (!dialog || !img || typeof dialog.showModal !== 'function') {
    cropBusy = false;
    await finishAdd(file, null);
    pumpCropQueue();
    return;
  }
  const url = URL.createObjectURL(file);
  img.src = url;
  try { await img.decode(); } catch { await new Promise((r) => { img.onload = r; }); }
  const maxW = Math.min(window.innerWidth - 70, 700);
  const maxH = Math.max(220, Math.min(window.innerHeight * 0.52, 460));
  const scale = Math.min(1, maxW / img.naturalWidth, maxH / img.naturalHeight);
  const dw = Math.max(1, Math.round(img.naturalWidth * scale));
  const dh = Math.max(1, Math.round(img.naturalHeight * scale));
  $('#cropStage').style.width = dw + 'px';
  $('#cropStage').style.height = dh + 'px';
  img.style.width = dw + 'px';
  img.style.height = dh + 'px';
  const bw = Math.round(dw * 0.8), bh = Math.round(dh * 0.8);
  cropCtx = {
    file, url, img, scale,
    stageW: dw, stageH: dh,
    box: { x: Math.round((dw - bw) / 2), y: Math.round((dh - bh) / 2), w: bw, h: bh },
    done: false,
  };
  $('#cropBox').style.cssText = `left:${cropCtx.box.x}px;top:${cropCtx.box.y}px;width:${cropCtx.box.w}px;height:${cropCtx.box.h}px`;
  dialog.showModal();
}

function cropBoxStyle() {
  if (!cropCtx) return;
  const b = cropCtx.box;
  $('#cropBox').style.cssText = `left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px`;
}

function cropSourceRegion() {
  if (!cropCtx) return null;
  const b = cropCtx.box, s = cropCtx.scale;
  const x = Math.max(0, Math.min(cropCtx.img.naturalWidth - 1, Math.round(b.x / s)));
  const y = Math.max(0, Math.min(cropCtx.img.naturalHeight - 1, Math.round(b.y / s)));
  const w = Math.max(8, Math.min(cropCtx.img.naturalWidth - x, Math.round(b.w / s)));
  const h = Math.max(8, Math.min(cropCtx.img.naturalHeight - y, Math.round(b.h / s)));
  return { x, y, w, h, sx: cropCtx.img.naturalWidth, sy: cropCtx.img.naturalHeight };
}

function finishCrop(region) {
  if (!cropCtx || cropCtx.done) return;
  cropCtx.done = true;
  const file = cropCtx.file;
  closeCropDialog();
  finishAdd(file, region).finally(() => {
    cropBusy = false;
    pumpCropQueue();
  });
}

function skipCrop() {
  if (cropCtx) cropCtx.done = true;
  closeCropDialog();
  cropBusy = false;
  pumpCropQueue();
}

/* drag / resize crop box */
let cropDrag = null;
function onCropPointerDown(e) {
  if (!cropCtx) return;
  e.preventDefault();
  const handle = e.target.closest('#cropHandle');
  cropDrag = {
    mode: handle ? 'resize' : 'move',
    startX: e.clientX, startY: e.clientY,
    box: { ...cropCtx.box },
  };
  document.addEventListener('pointermove', onCropPointerMove);
  document.addEventListener('pointerup', onCropPointerUp, { once: true });
}
function onCropPointerMove(e) {
  if (!cropCtx || !cropDrag) return;
  e.preventDefault();
  const dx = e.clientX - cropDrag.startX, dy = e.clientY - cropDrag.startY;
  const b = cropCtx.box;
  const orig = cropDrag.box;
  if (cropDrag.mode === 'move') {
    b.x = Math.max(0, Math.min(cropCtx.stageW - b.w, orig.x + dx));
    b.y = Math.max(0, Math.min(cropCtx.stageH - b.h, orig.y + dy));
  } else {
    b.w = Math.max(32, Math.min(cropCtx.stageW - b.x, orig.w + dx));
    b.h = Math.max(32, Math.min(cropCtx.stageH - b.y, orig.h + dy));
  }
  cropBoxStyle();
}
function onCropPointerUp() {
  cropDrag = null;
  document.removeEventListener('pointermove', onCropPointerMove);
}
$('#cropBox')?.addEventListener('pointerdown', onCropPointerDown);
$('#btnCropApply')?.addEventListener('click', () => finishCrop(cropSourceRegion()));
$('#btnCropFull')?.addEventListener('click', () => finishCrop(null));
$('#btnCropCancel')?.addEventListener('click', skipCrop);
$('#btnCropClose')?.addEventListener('click', skipCrop);
$('#cropDialog')?.addEventListener('cancel', (e) => { e.preventDefault(); skipCrop(); });

async function finishAdd(file, region) {
  if (state.pending.length >= 5) return toast('一次最多发送 5 张图片');
  try {
    const bmp = await createImageBitmap(file);
    const sx = region ? region.x : 0;
    const sy = region ? region.y : 0;
    const sw = region ? region.w : bmp.width;
    const sh = region ? region.h : bmp.height;
    const max = 2200;
    const scale = Math.min(1, max / Math.max(sw, sh));
    const w = Math.max(1, Math.round(sw * scale));
    const h = Math.max(1, Math.round(sh * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(bmp, sx, sy, sw, sh, 0, 0, w, h);
    const full = canvas.toDataURL('image/jpeg', 0.9);
    const tScale = Math.min(1, 340 / Math.max(w, h));
    const tc = document.createElement('canvas');
    tc.width = Math.max(1, Math.round(w * tScale));
    tc.height = Math.max(1, Math.round(h * tScale));
    tc.getContext('2d').drawImage(canvas, 0, 0, tc.width, tc.height);
    const thumb = tc.toDataURL('image/jpeg', 0.72);
    state.pending.push({ id: uid(), full, thumb });
    renderAttachments();
    bmp.close?.();
  } catch { toast('图片读取失败，请换一张试试'); }
}

function addFile(file) {
  if (!file || !file.type.startsWith('image/')) return;
  if (file.size > 12 * 1024 * 1024) return toast('图片超过 12MB，请压缩后再试');
  if (state.pending.length + cropQueue.length >= 5) return toast('一次最多发送 5 张图片');
  cropQueue.push(file);
  pumpCropQueue();
}

$('#btnAttach').addEventListener('click', () => {
  const f = document.createElement('input');
  f.type = 'file'; f.accept = 'image/*'; f.multiple = true;
  f.onchange = () => [...f.files].forEach(addFile);
  f.click();
});
document.addEventListener('paste', (e) => {
  const imgs = [...(e.clipboardData?.items || [])].filter((i) => i.type.startsWith('image/'));
  if (imgs.length) {
    e.preventDefault();
    imgs.slice(0, 5).forEach((i) => addFile(i.getAsFile()));
  }
});
['dragover', 'drop'].forEach((ev) => {
  document.addEventListener(ev, (e) => {
    if (ev === 'dragover') { e.preventDefault(); return; }
    const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (files.length) { e.preventDefault(); files.slice(0, 5).forEach(addFile); }
  });
});

/* ---------------- voice input ---------------- */
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
let recognition = null;
let voiceActive = false;
let voiceBase = '';
let voiceManual = false;
let voiceError = false;
let voiceGotFinal = false;
let voiceHelpSeen = false;

function showVoiceHelp() {
  const el = $('#voiceHelp');
  if (el) el.hidden = false;
}
function hideVoiceHelp() {
  const el = $('#voiceHelp');
  if (el) el.hidden = true;
}

function appendVoice(a, b) {
  a = String(a || '').trim();
  b = String(b || '').trim();
  if (!a) return b;
  if (!b) return a;
  const needsSpace = /[A-Za-z0-9]$/.test(a) && /^[A-Za-z0-9]/.test(b);
  return a + (needsSpace ? ' ' : '') + b;
}
function stopVoice(manual = true) {
  voiceManual = manual;
  if (recognition) {
    try { recognition.stop(); } catch {}
  }
  voiceActive = false;
  $('#btnMic').classList.remove('recording');
}
function startVoice(force = false) {
  if (state.streaming) return toast('请先停止当前回答');
  if (isIOS && !voiceHelpSeen && !force) {
    showVoiceHelp();
    return;
  }
  if (!SpeechRec) {
    if (isIOS) showVoiceHelp();
    else toast('当前浏览器不支持语音输入，请用 Chrome / Edge / 安卓浏览器');
    return;
  }
  if (!window.isSecureContext) return toast('语音输入需要 HTTPS 或 localhost，请用公网 HTTPS 链接');
  stopVoice(false);
  try {
    recognition = new SpeechRec();
    recognition.lang = 'zh-CN';
    recognition.interimResults = true;
    // iOS / Android 的 Web Speech 对 continuous 支持不稳定，移动端用单次识别。
    recognition.continuous = !(isIOS || /Android/i.test(navigator.userAgent));
    recognition.maxAlternatives = 1;
    voiceBase = input.value.trim();
    voiceManual = false;
    voiceError = false;
    voiceGotFinal = false;
    recognition.onstart = () => {
      voiceActive = true;
      $('#btnMic').classList.add('recording');
      toast('正在听，请讲…再点麦克风结束');
    };
    recognition.onresult = (event) => {
      let finalText = '';
      let interimText = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const t = event.results[i][0]?.transcript || '';
        if (event.results[i].isFinal) finalText += t;
        else interimText += t;
      }
      if (finalText) {
        voiceGotFinal = true;
        voiceBase = appendVoice(voiceBase, finalText);
      }
      input.value = appendVoice(voiceBase, interimText);
      autoResize();
    };
    recognition.onerror = (event) => {
      voiceError = true;
      const code = event.error || '';
      if (voiceManual) return;
      if (code === 'aborted') {
        if (isIOS) { toast('iPhone 网页语音被系统中断，请改用键盘上的麦克风听写'); showVoiceHelp(); }
        return;
      }
      if (code === 'not-allowed' || code === 'service-not-allowed') {
        toast(isIOS ? '麦克风被系统限制。请到“设置 → Safari → 麦克风”允许，或直接用键盘上的麦克风听写' : '麦克风权限被拒绝，请在浏览器设置中允许');
        if (isIOS) showVoiceHelp();
      } else if (code === 'audio-capture') {
        toast('没有找到麦克风');
      } else if (code === 'network') {
        toast(isIOS ? '语音服务网络异常。iPhone 可改用键盘上的麦克风听写' : '语音识别网络异常，请稍后重试');
        if (isIOS) showVoiceHelp();
      } else if (code === 'no-speech') {
        toast('没有听到声音，请再点麦克风说一次');
      } else if (code === 'language-not-supported') {
        toast('当前浏览器不支持中文语音识别');
      } else {
        toast(isIOS ? 'iPhone 网页语音被中断，请改用键盘上的麦克风听写' : '语音输入中断，请再点麦克风重试');
        if (isIOS) showVoiceHelp();
      }
    };
    recognition.onnomatch = () => { voiceError = true; toast('没有听清，请再说一次'); };
    recognition.onend = () => {
      const wasActive = voiceActive;
      voiceActive = false;
      $('#btnMic').classList.remove('recording');
      if (wasActive && !voiceManual && !voiceError && !voiceGotFinal) {
        toast(isIOS ? '没有识别到语音。iPhone 建议用键盘上的麦克风听写' : '没有识别到语音，请再点麦克风说一次');
        if (isIOS) showVoiceHelp();
      }
    };
    recognition.start();
  } catch {
    voiceError = true;
    toast(isIOS ? 'iPhone 网页语音启动失败，请改用键盘上的麦克风听写' : '语音输入启动失败，请检查麦克风权限');
    if (isIOS) showVoiceHelp();
  }
}
$('#btnMic').addEventListener('click', () => {
  if (voiceActive) stopVoice(true);
  else startVoice();
});
$('#voiceTry').addEventListener('click', () => {
  voiceHelpSeen = true;
  hideVoiceHelp();
  startVoice(true);
});
$('#voiceClose').addEventListener('click', () => {
  voiceHelpSeen = true;
  hideVoiceHelp();
  input.focus();
  toast('点输入框后，用键盘上的麦克风听写');
});
document.addEventListener('visibilitychange', () => { if (document.hidden) stopVoice(true); });

/* ---------------- chat ---------------- */
function scrollBottom(force = false) {
  const chat = $('#chat');
  if (force || chat.scrollHeight - chat.scrollTop - chat.clientHeight < 160) chat.scrollTop = chat.scrollHeight;
}

async function send(opts = {}) {
  if (state.streaming) return;
  stopVoice();
  hideVoiceHelp();
  const editMsg = opts.editMsg || null;
  const reuseMsg = opts.reuseMsg || null;
  const text = editMsg ? String(editMsg.text || '').trim() : reuseMsg ? String(reuseMsg.text || '').trim() : input.value.trim();
  if (Array.from(text.replace(/\s/g, '')).length > 8000) {
    toast(`单次输入不能超过 8000 字（不计空格），当前 ${Array.from(text.replace(/\s/g, '')).length} 字`);
    return;
  }
  if (!text && !state.pending.length) { input.focus(); return; }
  const hasContext = state.messages.some((m) => m.role === 'assistant' && String(m.text || '').trim() && m !== reuseMsg);
  const imgs = editMsg || reuseMsg ? [] : state.pending.map((p) => p.full);
  const thumbs = editMsg ? (editMsg.thumbs || []) : reuseMsg ? (reuseMsg.thumbs || []) : state.pending.map((p) => p.thumb);
  let userMsg;
  if (editMsg) {
    userMsg = editMsg;
    userMsg.text = text;
    renderMessages();
    saveState();
  } else if (reuseMsg) {
    userMsg = reuseMsg;
    renderMessages();
  } else {
    userMsg = { id: uid(), role: 'user', text, thumbs, fulls: imgs, ts: Date.now() };
    state.messages.push(userMsg);
    const cur = currentConversation();
    if (!cur.title || cur.title === '新对话') cur.title = titleFromMessages(state.messages);
    state.pending = [];
    renderAttachments();
    input.value = '';
    autoResize();
    renderMessages();
    scrollBottom(true);
    saveState();
    renderHistory();
  }

  const aiMsg = { id: uid(), role: 'assistant', text: '', sources: [], peers: [], context: hasContext, ts: Date.now() };
  state.messages.push(aiMsg);
  const aiEl = document.createElement('article');
  aiEl.className = 'msg ai';
  aiEl.dataset.id = aiMsg.id;
  const thinkingLabel = hasContext ? '正在结合上文思考…' : '深度思考中…';
  aiEl.innerHTML = `<div class="avatar">法</div><div class="msg-body"><div class="msg-meta">Sage <span class="tag">深度思考</span>${hasContext ? '<span class="tag context">承接上文</span>' : ''}</div><div class="bubble streaming"><div class="markdown"><p class="thinking">${thinkingLabel}</p></div><div class="live-peers"></div></div></div>`;
  $('#messages').appendChild(aiEl);
  scrollBottom(true);

  const mdEl = $('.markdown', aiEl);
  state.liveEl = mdEl;
  state.liveMsg = aiMsg;
  setStreaming(true);

  const payload = {
    conversationId: state.currentId,
    subject: state.subject,
    mode: state.mode,
    messages: state.messages
      .filter((m) => m.id !== aiMsg.id && !m.error && (m.role === 'user' || m.text))
      .map((m) => ({ id: m.id, role: m.role, content: m.imageText ? `${m.text || ''}\n【上文图片识别】${m.imageText}` : m.text, images: m.id === userMsg.id ? imgs : [] })),
  };

  const ac = new AbortController();
  state.abort = ac;
  let renderPending = false;
  const scheduleRender = () => {
    if (renderPending) return;
    renderPending = true;
    requestAnimationFrame(() => {
      renderPending = false;
      if (!state.liveEl) return;
      state.liveEl.innerHTML = mdToHtml(aiMsg.text, aiMsg.sources) || `<p class="thinking">${hasContext ? '正在结合上文思考…' : '深度思考中…'}</p>`;
      scrollBottom();
    });
  };

  try {
    const headers = { 'content-type': 'application/json' };
    if (state.apiKey) headers['x-user-api-key'] = state.apiKey;
    if (state.doubaoKey) { headers['x-doubao-key'] = state.doubaoKey; headers['x-doubao-model'] = state.doubaoModel; }
    if (state.qwenKey) { headers['x-qwen-key'] = state.qwenKey; headers['x-qwen-model'] = state.qwenModel; }
    if (state.multi) headers['x-multi'] = '1';
    if (editMsg) headers['x-quota-skip'] = '1';
    let res;
    for (let attempt = 0; attempt < 20; attempt++) {
      res = await fetch('/api/chat', { method: 'POST', headers, body: JSON.stringify(payload), signal: ac.signal });
      if (res.status !== 502 && res.status !== 503 && res.status !== 504) break;
      const tip = state.liveEl?.querySelector('.thinking');
      if (tip) tip.textContent = `服务正在唤醒（${attempt + 1}/20，约 1 分钟），请稍等…`;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 3000);
        ac.signal.addEventListener('abort', () => { clearTimeout(timer); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
      });
    }
    if (!res.ok) {
      if (res.status === 502 || res.status === 503 || res.status === 504) throw new Error('服务正在唤醒，请等 10 秒再点“重试”。');
      const j = await res.json().catch(() => ({}));
      if (res.status === 401) { location.href = '/login?kicked=1'; }
      if (res.status === 403 && typeof j.error === 'string' && /次数|额度|作废/.test(j.error)) {
        state.quota = 0;
        renderQuota();
        openRenew();
      }
      throw new Error(j.error || `请求失败（${res.status}）`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let done = false;
    while (!done) {
      const { done: d, value } = await reader.read();
      if (d) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, idx); buf = buf.slice(idx + 2);
        let ev = 'message'; const datas = [];
        for (const line of raw.split('\n')) {
          if (line.startsWith('event:')) ev = line.slice(6).trim();
          else if (line.startsWith('data:')) datas.push(line.slice(5).trim());
        }
        if (!datas.length) continue;
        let data; try { data = JSON.parse(datas.join('\n')); } catch { continue; }
        if (ev === 'meta') {
          aiMsg.sources = data.sources || [];
          aiMsg.peers = Array.isArray(data.peers) ? data.peers : [];
          if (data.imageText) {
            userMsg.imageText = String(data.imageText || '');
            saveState();
          }
          if (Object.prototype.hasOwnProperty.call(data, 'quota')) {
            state.quota = data.quota;
            renderQuota();
          }
          const lp = aiEl.querySelector('.live-peers');
          if (lp) lp.innerHTML = peersHtml(aiMsg.peers);
          continue;
        }
        if (ev === 'quota') {
          if (typeof data.quota === 'number') { state.quota = data.quota; renderQuota(); }
          continue;
        }
        if (ev === 'peer') {
          const p = aiMsg.peers.find((x) => x.id === data.id);
          if (p) {
            p.status = data.status || 'done';
            p.text = data.text || '';
            p.error = data.error || '';
          } else {
            aiMsg.peers.push({ id: data.id, label: data.label, status: data.status || 'done', text: data.text || '', error: data.error || '' });
          }
          const lp = aiEl.querySelector('.live-peers');
          if (lp) lp.innerHTML = peersHtml(aiMsg.peers);
          scrollBottom();
          continue;
        }
        if (ev === 'thinking') {
          const p = aiEl.querySelector('.thinking');
          if (p) p.textContent = `${hasContext ? '结合上文' : '深度思考'}中 · 已推理 ${Math.max(100, Math.round((data.chars || 0) / 100) * 100)} 字`;
          continue;
        }
        if (ev === 'delta') {
          aiMsg.text += data.text || '';
          scheduleRender();
          continue;
        }
        if (ev === 'final' && typeof data.text === 'string') {
          aiMsg.text = data.text;
          scheduleRender();
          continue;
        }
        if (ev === 'error') throw new Error(data.message || '生成中断');
        if (ev === 'done') { done = true; break; }
      }
    }
  } catch (e) {
    if (e.name === 'AbortError') {
      aiMsg.stopped = true;
      if (!aiMsg.text) aiMsg.text = '已停止生成。';
    } else {
      aiMsg.error = true;
      aiMsg.text = e.message || '网络异常，请重试。';
    }
  } finally {
    setStreaming(false);
    state.abort = null;
    state.liveEl = null;
    state.liveMsg = null;
    const finalEl = $(`[data-id="${aiMsg.id}"]`);
    if (finalEl) finalEl.outerHTML = messageHtml(aiMsg);
    if (!aiMsg.text && !aiMsg.error) {
      aiMsg.error = true;
      aiMsg.text = '没有收到回答，请重试。';
      const el = $(`[data-id="${aiMsg.id}"]`);
      if (el) el.outerHTML = messageHtml(aiMsg);
    }
    saveState();
    renderHistory();
    scrollBottom();
    if (state.role === 'guest' && state.quota === 0) setTimeout(openRenew, 350);
  }
}

function setStreaming(on) {
  state.streaming = on;
  if (on) stopVoice();
  $('#btnSend').hidden = on;
  $('#btnStop').hidden = !on;
  input.disabled = on;
}

$('#btnSend').addEventListener('click', send);
$('#btnStop').addEventListener('click', () => {
  state.abort?.abort();
  toast('已停止生成');
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  }
});

$('#messages').addEventListener('click', (e) => {
  const cite = e.target.closest('[data-cite]');
  if (cite) {
    const article = cite.closest('.msg.ai');
    const det = article?.querySelector(`details[data-src="${cite.dataset.cite}"]`);
    if (det) { det.open = true; det.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
    return;
  }
  const copy = e.target.closest('[data-copy]');
  if (copy) {
    const m = state.messages.find((x) => x.id === copy.dataset.copy);
    if (!m) return;
    navigator.clipboard.writeText(m.text || '').then(() => toast('已复制')).catch(() => toast('复制失败'));
    return;
  }
  if (e.target.closest('[data-newtopic]')) newConversation();
});

/* ---------------- history events ---------------- */
$('#btnNew').addEventListener('click', newConversation);
$('#btnSideNew').addEventListener('click', newConversation);
$('#btnMenu').addEventListener('click', () => {
  const open = !$('#sidebar').classList.contains('open');
  $('#sidebar').classList.toggle('open', open);
  $('#sidebarMask').classList.toggle('show', open);
});
$('#sidebarMask').addEventListener('click', closeSidebar);
$('#historySearch').addEventListener('input', (e) => {
  state.search = e.target.value;
  renderHistory();
});
$$('.hist-tabs [data-view]').forEach((b) => b.addEventListener('click', () => {
  state.view = b.dataset.view;
  $$('.hist-tabs [data-view]').forEach((x) => x.classList.toggle('active', x === b));
  renderHistory();
}));
$('#btnMergeMode').addEventListener('click', () => {
  if (state.mergeMode) exitMergeMode(); else enterMergeMode();
});
$('#btnMergeCancel').addEventListener('click', exitMergeMode);
$('#btnMergeGo').addEventListener('click', mergeSelected);
$('#historyList').addEventListener('click', (e) => {
  const check = e.target.closest('[data-check]');
  if (check) { toggleMerge(check.dataset.check); return; }
  const more = e.target.closest('[data-more]');
  if (more) { e.stopPropagation(); openHistMenu(more.dataset.more, more); return; }
  const item = e.target.closest('.hist-item');
  if (!item) return;
  if (state.mergeMode) { toggleMerge(item.dataset.id); return; }
  if (state.streaming) return toast('请先停止当前回答');
  if (item.dataset.id !== state.currentId) setCurrent(item.dataset.id);
  else closeSidebar();
});
$('#histMenu').addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const id = state.histMenuId;
  closeHistMenu();
  if (!id) return;
  const c = state.conversations.find((x) => x.id === id);
  if (!c) return;
  if (b.dataset.act === 'rename') openRename(c);
  else if (b.dataset.act === 'archive') archiveConversation(id);
  else if (b.dataset.act === 'merge') enterMergeMode(id);
  else if (b.dataset.act === 'delete') deleteConversation(id);
});
document.addEventListener('click', (e) => {
  if (!$('#histMenu').hidden && !e.target.closest('#histMenu') && !e.target.closest('[data-more]')) closeHistMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeHistMenu(); closeSidebar(); }
});
$('#renameForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const c = state.conversations.find((x) => x.id === state.renameId);
  if (c) {
    const t = $('#renameInput').value.trim();
    if (t) c.title = t.slice(0, 40);
    c.updatedAt = Date.now();
    persistStore();
    renderHistory();
  }
  $('#renameDialog').close();
});
$('#btnRenameClose').addEventListener('click', () => $('#renameDialog').close());
$('#renameDialog').addEventListener('click', (e) => { if (e.target === $('#renameDialog')) $('#renameDialog').close(); });

function lastUserMessage() {
  return [...state.messages].reverse().find((m) => m.role === 'user');
}
function openEdit(id) {
  if (state.streaming) { toast('正在回答，稍后再修改'); return; }
  const msg = state.messages.find((m) => m.id === id && m.role === 'user');
  if (!msg) return;
  if (msg !== lastUserMessage()) { toast('只能修改最近一条问题'); return; }
  if (msg.edited) { toast('这条问题已经修改过一次了'); return; }
  state.editId = id;
  $('#editText').value = msg.text || '';
  $('#editDialog').showModal();
  setTimeout(() => $('#editText').focus(), 80);
}
$('#btnEditSave').addEventListener('click', () => {
  const msg = state.messages.find((m) => m.id === state.editId && m.role === 'user');
  const text = $('#editText').value.trim();
  if (!msg || !text) return;
  if (text === msg.text) { $('#editDialog').close(); return; }
  const idx = state.messages.indexOf(msg);
  if (state.messages[idx + 1]?.role === 'assistant') state.messages.splice(idx + 1, 1);
  msg.text = text.slice(0, 4000);
  msg.edited = true;
  state.editId = null;
  $('#editDialog').close();
  renderMessages();
  saveState();
  send({ editMsg: msg });
});
$('#btnEditClose').addEventListener('click', () => { state.editId = null; $('#editDialog').close(); });
$('#editDialog').addEventListener('click', (e) => { if (e.target === $('#editDialog')) { state.editId = null; $('#editDialog').close(); } });

let editPressTimer = null;
function clearEditPress() { if (editPressTimer) { clearTimeout(editPressTimer); editPressTimer = null; } }
$('#messages').addEventListener('pointerdown', (e) => {
  const bubble = e.target.closest('.msg.user .bubble');
  if (!bubble) return;
  const id = bubble.closest('.msg')?.dataset.id;
  clearEditPress();
  editPressTimer = setTimeout(() => { editPressTimer = null; openEdit(id); }, 550);
});
['pointerup', 'pointermove', 'pointercancel', 'scroll'].forEach((evt) => {
  $('#messages').addEventListener(evt, clearEditPress, { passive: true });
});
$('#messages').addEventListener('contextmenu', (e) => {
  const bubble = e.target.closest('.msg.user .bubble');
  if (!bubble) return;
  e.preventDefault();
  openEdit(bubble.closest('.msg')?.dataset.id);
});
$('#messages').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-retry]');
  if (!btn || state.streaming) return;
  const ai = state.messages.find((m) => m.id === btn.dataset.retry && m.role === 'assistant');
  const idx = ai ? state.messages.indexOf(ai) : -1;
  const user = idx > 0 ? state.messages[idx - 1] : null;
  if (!ai || !user || user.role !== 'user') return;
  state.messages.splice(idx, 1);
  renderMessages();
  saveState();
  send({ reuseMsg: user });
});

function openRenew() {
  if (state.role !== 'guest') return;
  if ($('#renewDialog').open) return;
  $('#renewCode').value = '';
  $('#renewDialog').showModal();
  setTimeout(() => $('#renewCode').focus(), 80);
}
$('#quotaPill').addEventListener('click', () => {
  if (state.role !== 'guest') return;
  if (Number(state.quota) > 0) {
    toast(`当前还有 ${state.quota} 次，余额没有用完`);
    return;
  }
  openRenew();
});
$('#btnRenewSave').addEventListener('click', async () => {
  const code = $('#renewCode').value.trim();
  if (!/^\d{6}$/.test(code)) { toast('请输入 6 位数字密码'); return; }
  try {
    const r = await fetch('/api/renew', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || '续用失败');
    state.role = j.role;
    state.quota = j.quota;
    state.usesOwnerKey = j.usesOwnerKey;
    state.selfKeyNotice = false;
    $('#renewDialog').close();
    renderQuota();
    checkHealth();
    toast(`已续用，余${j.quota}次`);
    if (j.usesOwnerKey === false && !state.apiKey) toast('这个密码需要填写自己的 DeepSeek API Key');
  } catch (e) {
    toast(e.message || '续用失败');
  }
});
$('#btnRenewClose').addEventListener('click', () => $('#renewDialog').close());
$('#renewDialog').addEventListener('click', (e) => { if (e.target === $('#renewDialog')) $('#renewDialog').close(); });

/* ---------------- subject ---------------- */
$('#subjectBar').addEventListener('click', (e) => {
  const b = e.target.closest('[data-subject]');
  if (b) setSubject(b.dataset.subject);
});

/* ---------------- health / settings ---------------- */
function renderQuota() {
  const el = $('#quotaPill');
  if (!el) return;
  if (state.role === 'guest' && state.quota !== null) {
    el.hidden = false;
    el.textContent = `余${state.quota}`;
    el.title = '剩余答疑次数';
  } else {
    el.hidden = true;
  }
}
async function loadSession() {
  try {
    const r = await fetch('/api/session');
    if (r.status === 401) { location.href = '/login?kicked=1'; return; }
    const j = await r.json();
    state.role = j.role || null;
    state.quota = j.quota;
    state.usesOwnerKey = j.usesOwnerKey;
    if (state.role === 'guest' && j.usesOwnerKey === false && !state.apiKey && !state.selfKeyNotice) {
      state.selfKeyNotice = true;
      toast('这个密码需要填写自己的 DeepSeek API Key');
    }
    renderQuota();
  } catch { /* network error: leave UI as-is */ }
}
async function checkHealth() {  const status = $('#status');
  const txt = $('#statusText');
  const box = $('#settingsStatus');
  try {
    const headers = state.apiKey ? { 'x-user-api-key': state.apiKey } : {};
    const r = await fetch('/api/health', { headers });
    const j = await r.json();
    if (j.requireUserKey && !state.apiKey) {
      status.classList.add('offline');
      txt.textContent = '需填写自己的 DeepSeek Key';
      box.innerHTML = `<span class="pulse"></span><span>本站已关闭公共额度：请在上方填写自己的 DeepSeek API Key</span>`;
      return;
    }
    if (j.usesOwnerKey === false && !state.apiKey) {
      status.classList.add('offline');
      txt.textContent = '需填自己的 DeepSeek Key';
      box.innerHTML = `<span class="pulse"></span><span>这个 6 位密码不能使用站长额度，请填自己的 DeepSeek API Key</span>`;
      return;
    }
    if (j.ok) {
      status.classList.remove('offline');
      txt.textContent = 'DeepSeek 在线';
      box.innerHTML = `<span class="pulse"></span><span>已连接 · ${esc(j.model)}</span>`;
    } else {
      status.classList.add('offline');
      txt.textContent = '未连接 DeepSeek';
      box.innerHTML = `<span class="pulse"></span><span>未找到可用凭据，请填写自己的 DeepSeek API Key</span>`;
    }
  } catch {
    status.classList.add('offline');
    txt.textContent = '服务未启动';
    box.innerHTML = `<span class="pulse"></span><span>服务未响应，请刷新页面</span>`;
  }
}

const settings = $('#settingsDialog');
function openSettings() {
  $('#apiKey').value = state.apiKey;
  $('#doubaoKey').value = state.doubaoKey;
  $('#qwenKey').value = state.qwenKey;
  $('#doubaoModel').value = state.doubaoModel;
  $('#qwenModel').value = state.qwenModel;
  $('#multiToggle').checked = state.multi;
  setMode(state.mode);
  checkHealth();
  settings.showModal();
}
$('#btnSettings').addEventListener('click', openSettings);
$('#sideSettings').addEventListener('click', () => { closeSidebar(); openSettings(); });
$('#btnSaveSettings').addEventListener('click', () => {
  state.apiKey = $('#apiKey').value.trim();
  state.doubaoKey = $('#doubaoKey').value.trim();
  state.qwenKey = $('#qwenKey').value.trim();
  state.doubaoModel = $('#doubaoModel').value.trim() || 'doubao-seed-1-6-250615';
  state.qwenModel = $('#qwenModel').value.trim() || 'qwen-plus';
  state.multi = $('#multiToggle').checked;
  localStorage.setItem('sage_key', state.apiKey);
  localStorage.setItem('sage_doubao_key', state.doubaoKey);
  localStorage.setItem('sage_qwen_key', state.qwenKey);
  localStorage.setItem('sage_doubao_model', state.doubaoModel);
  localStorage.setItem('sage_qwen_model', state.qwenModel);
  localStorage.setItem('sage_multi', state.multi ? '1' : '0');
  settings.close();
  checkHealth();
  toast('设置已保存');
});
$('#btnClear').addEventListener('click', () => {
  if (!confirm('清除本机保存的全部对话？此操作不可恢复。')) return;
  state.conversations = [];
  state.currentId = null;
  const c = newConversationObj();
  state.conversations.push(c);
  state.currentId = c.id;
  state.messages = c.messages;
  persistStore();
  renderMessages();
  renderHistory();
  settings.close();
  toast('已清除');
});
$('#modeSeg').addEventListener('click', (e) => {
  const b = e.target.closest('[data-mode]');
  if (b) setMode(b.dataset.mode);
});
settings.addEventListener('click', (e) => { if (e.target === settings) settings.close(); });

/* ---------------- library ---------------- */
const lib = $('#libraryDialog');
$('#btnLibrary').addEventListener('click', async () => { lib.showModal(); await refreshLibrary(); });
$('#sideLibrary').addEventListener('click', async () => { closeSidebar(); lib.showModal(); await refreshLibrary(); });
$('#btnCloseLibrary').addEventListener('click', () => lib.close());
lib.addEventListener('click', (e) => { if (e.target === lib) lib.close(); });

async function refreshLibrary() {
  try {
    const u = await fetch('/api/uploads').then((r) => r.json());
    const ups = u.uploads || [];
    $('#uploadList').innerHTML = ups.length ? ups.map((x) => `
      <div class="upload-item">
        <span class="u-ic">${esc((x.subject || '资')[0])}</span>
        <div class="u-main"><b>${esc(x.name)}</b><span>${esc(x.subject)} · ${x.pages} 页</span></div>
        <button data-del="${esc(x.name)}" data-sub="${esc(x.subject)}">删除</button>
      </div>`).join('') : '<p class="empty">还没有上传资料。</p>';
  } catch {
    $('#uploadList').innerHTML = '<p class="empty">服务未连接</p>';
  }
}
$('#uploadList').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-del]');
  if (!b) return;
  if (!confirm(`删除资料「${b.dataset.del}」？其内容将从答疑知识库移除。`)) return;
  await fetch(`/api/uploads?name=${encodeURIComponent(b.dataset.del)}&subject=${encodeURIComponent(b.dataset.sub)}`, { method: 'DELETE' });
  toast('已删除');
  refreshLibrary();
});
const dropZone = $('#dropZone');
['dragenter', 'dragover'].forEach((ev) => dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.add('drag'); }));
['dragleave', 'drop'].forEach((ev) => dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.remove('drag'); }));
dropZone.addEventListener('drop', (e) => {
  const files = [...(e.dataTransfer?.files || [])];
  if (files.length) handleFiles(files);
});
$('#fileInput').addEventListener('change', (e) => handleFiles([...e.target.files]));

const progress = $('#uploadProgress');
function setProgress(text) {
  if (!text) { progress.hidden = true; return; }
  progress.hidden = false;
  progress.querySelector('span').textContent = text;
}
async function parsePdf(file, onPage) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const pages = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    const text = tc.items.map((it) => it.str + (it.hasEOL ? '\n' : '')).join('')
      .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    pages.push({ page: p, text });
    onPage?.(p, pdf.numPages);
  }
  return pages;
}
async function handleFiles(files) {
  if (!files.length) return;
  const subject = $('#uploadSubject').value;
  for (const file of files) {
    try {
      let pages = [];
      if (file.name.toLowerCase().endsWith('.pdf') || file.type === 'application/pdf') {
        setProgress(`解析 ${file.name}…`);
        pages = await parsePdf(file, (p, n) => setProgress(`解析 ${file.name}：${p}/${n} 页`));
        if (!pages.some((p) => p.text.length > 20)) throw new Error('未提取到文字，可能是扫描版 PDF。扫描版请直接发图片提问，或先用 OCR 转成文字版。');
      } else {
        const text = await file.text();
        const chunks = [];
        for (let i = 0; i < text.length; i += 6000) chunks.push({ page: chunks.length + 1, text: text.slice(i, i + 6000) });
        pages = chunks;
      }
      if (pages.length > 3000) throw new Error('文件超过 3000 页，请拆分后再上传');
      setProgress(`上传 ${file.name}…`);
      const r = await fetch('/api/uploads', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: file.name, subject, pages }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || '上传失败');
      toast(`已学习「${file.name}」：${j.pages} 页`);
    } catch (e) {
      toast(e.message || '上传失败');
    }
  }
  setProgress('');
  $('#fileInput').value = '';
  refreshLibrary();
  checkHealth();
}

/* ---------------- viewport / keyboard ---------------- */
function syncViewport() {
  const vv = window.visualViewport;
  const h = vv ? vv.height : window.innerHeight;
  document.documentElement.style.setProperty('--app-height', `${Math.round(h)}px`);
  if (vv && vv.offsetTop > 0) window.scrollTo(0, 0);
}
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', syncViewport);
  window.visualViewport.addEventListener('scroll', syncViewport);
}
window.addEventListener('resize', syncViewport);
window.addEventListener('orientationchange', () => setTimeout(syncViewport, 250));
input.addEventListener('focus', () => setTimeout(syncViewport, 350));
input.addEventListener('blur', () => setTimeout(syncViewport, 150));
syncViewport();

function prewarmServer() {
  let n = 0;
  const tick = async () => {
    try {
      const r = await fetch('/api/health', { cache: 'no-store' });
      if (r.ok) return;
    } catch {}
    if (++n < 20) setTimeout(tick, 3000);
  };
  setTimeout(tick, 300);
}

/* ---------------- init ---------------- */
loadStore();
renderHistory();
setMode(state.mode);
renderMessages();
renderAttachments();
$$('#subjectBar button').forEach((b) => b.classList.toggle('active', b.dataset.subject === state.subject));
if (!state.messages.length) setTimeout(() => input.focus(), 200);
prewarmServer();
loadSession();
checkHealth();
setInterval(checkHealth, 60000);
setInterval(loadSession, 60000);
