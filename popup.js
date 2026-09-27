import { inboxUrl, fetchMessageBody } from './inbox.js';
import { loadSettings, buildMail, isValidEmail, saveSettings, buildComposeUrl, gmailWebUrl } from './shared.js';

const $ = (id) => document.getElementById(id);
const AVATAR_COLORS = ['#2563eb', '#16a34a', '#db2777', '#ea580c', '#7c3aed'];

let settings;
let accounts = []; // [{ index, email, name, photo, count, entries, checkedAt, error }]
let inboxError = null;
let current = 0; // 선택된 계정 (u/N 순번 또는 이메일)
let activeTabId;
let openMsg = null; // 읽고 있는 메일
const folderCache = {}; // `${계정}|${폴더}` → { mails, page, hasMore }
let folderSeq = 0; // 늦게 도착한 응답 무시용
let folderPending = ''; // 불러오는 중인 목록 (중복 요청 방지)

const currentAccount = () => accounts.find((a) => a.index === current);

// ---------- 공통 ----------
function msg(text) {
  const d = document.createElement('div');
  d.className = 'msg';
  d.textContent = text;
  return d;
}

function setStatus(text, kind = '') {
  $('status').textContent = text;
  $('status').className = 'status ' + kind;
}

function showView(id) {
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.view === id);
  for (const v of ['sendView', 'inboxView']) $(v).hidden = v !== id;
  try { localStorage.setItem('qes-view', id); } catch { /* 무시 */ }
}

function timeAgo(v) {
  const t = typeof v === 'number' ? v : Date.parse(v);
  if (!t) return typeof v === 'string' ? v : '';
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return '방금';
  if (m < 60) return `${m}분 전`;
  if (m < 60 * 24) return `${Math.round(m / 60)}시간 전`;
  return new Date(t).toLocaleDateString();
}

function mailRow({ from, fromEmail, time, subject, summary, unread }) {
  const el = document.createElement('div');
  el.className = 'mail' + (unread ? ' unread' : '');
  el.title = fromEmail || '';
  el.innerHTML =
    '<div class="head"><span class="from"></span><span class="time"></span></div><div class="subj"></div><div class="sum"></div>';
  el.querySelector('.from').textContent = from;
  el.querySelector('.time').textContent = timeAgo(time);
  el.querySelector('.subj').textContent = subject;
  el.querySelector('.sum').textContent = summary;
  return el;
}

// ---------- 왼쪽: 계정 ----------
function renderAccounts() {
  const box = $('accountList');
  box.textContent = '';
  if (!settings.inboxCheck) {
    box.append(Object.assign(document.createElement('div'), { className: 'aside-msg', textContent: '받은편지함 확인이 꺼져 있습니다. 설정에서 켜세요.' }));
  } else if (!accounts.length) {
    box.append(Object.assign(document.createElement('div'), {
      className: 'aside-msg',
      textContent: inboxError ? 'Chrome에서 Gmail에 로그인하세요.' : '계정 찾는 중…',
    }));
  }
  accounts.forEach((a, pos) => {
    const b = document.createElement('button');
    b.className = 'acct' + (a.index === current ? ' active' : '');
    b.title = a.email;
    b.innerHTML = '<span class="avatar"></span><span class="info"><span class="email"></span><span class="hint"></span></span><span class="badge"></span>';
    const av = b.querySelector('.avatar');
    if (a.photo) {
      const img = document.createElement('img');
      img.src = a.photo;
      img.alt = '';
      img.onerror = () => { img.remove(); av.textContent = (a.name || a.email)[0].toUpperCase(); };
      av.append(img);
    } else {
      av.textContent = (a.name || a.email)[0].toUpperCase();
    }
    av.style.background = AVATAR_COLORS[pos % AVATAR_COLORS.length];
    b.querySelector('.email').textContent = a.name || a.email.split('@')[0];
    const hint = b.querySelector('.hint');
    hint.textContent = a.error ? '다시 로그인 필요' : a.email;
    hint.classList.toggle('err', !!a.error);
    b.querySelector('.badge').textContent = a.count ? (a.count > 999 ? '999+' : String(a.count)) : '';
    b.addEventListener('click', () => selectAccount(a.index));
    box.append(b);
  });
}

function selectAccount(index) {
  current = index;
  saveSettings({ gmailAccount: index }); // 보내기와 받은편지함 모두 이 계정 사용
  closeReader(false);
  renderAccounts();
  renderInbox();
  renderFromLine();
}

// ---------- 받은편지함 ----------
function renderInbox() {
  const list = $('mailList');
  const a = currentAccount();
  $('unread').textContent = a?.count ? String(a.count) : '';
  $('markAll').hidden = !a || !!a.error || !a.count;
  if (!settings.inboxCheck) {
    list.textContent = '';
    $('inboxInfo').textContent = '';
    list.append(msg('받은편지함 확인이 꺼져 있습니다. 설정에서 켜세요.'));
    return;
  }
  if (!a) {
    list.textContent = '';
    $('inboxInfo').textContent = inboxError ? `⚠ ${inboxError}` : '';
    list.append(msg(inboxError ? 'Chrome에서 Gmail에 로그인한 뒤 새로고침하세요.' : '확인 중…'));
    return;
  }
  list.textContent = '';
  if (a.error) {
    $('inboxInfo').textContent = `${a.email} · ⚠ ${a.error}`;
    list.append(msg('이 계정의 Gmail 세션을 읽을 수 없습니다. "Gmail 열기"로 이 계정에 다시 로그인한 뒤 새로고침하세요.'));
    return;
  }
  if ($('folder').value !== 'unread') {
    renderFolder(a);
    return;
  }
  $('moreRow').hidden = true;
  const when = a.checkedAt ? new Date(a.checkedAt).toLocaleTimeString() : '';
  $('inboxInfo').textContent = `${a.email} · 안 읽음 ${a.count} · ${when}`;
  if (!a.entries.length) {
    list.append(msg('안 읽은 메일이 없습니다 🎉'));
    return;
  }
  // 로그인 세션으로 본문 읽기 (비공식)
  for (const e of a.entries) {
    const el = mailRow({ from: e.from, fromEmail: e.fromEmail, time: e.issued, subject: e.title, summary: e.summary, unread: true });
    el.addEventListener('click', () => openSessionReader(a, e));
    list.append(el);
  }
}

// ---------- 메일 읽기 ----------
const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// 메일 HTML 정리: 스크립트·폼·임베드·이벤트 핸들러·javascript: 링크 제거
function sanitize(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script, iframe, frame, object, embed, form, input, button, textarea, select, meta, link[rel="import"], base').forEach((el) => el.remove());
  for (const el of doc.querySelectorAll('*')) {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      const val = attr.value.trim().toLowerCase();
      if (name.startsWith('on')) el.removeAttribute(attr.name);
      else if (['href', 'src', 'action', 'xlink:href', 'formaction'].includes(name) && val.startsWith('javascript:')) el.removeAttribute(attr.name);
    }
    if (el.tagName === 'A') {
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noopener noreferrer');
    }
  }
  // <head>의 <style>도 살려서 본문 앞에 붙임
  const styles = [...doc.querySelectorAll('style')].map((s) => s.outerHTML).join('');
  doc.querySelectorAll('body style').forEach((s) => s.remove());
  return styles + doc.body.innerHTML;
}

// Shadow DOM에 그려서 메일 스타일이 팝업 UI를 망가뜨리지 않게 함
function renderMailBody(m) {
  const host = $('rBody');
  const root = host.shadowRoot || host.attachShadow({ mode: 'open' });
  const base =
    '<style>:host{display:block}.wrap{font:14px/1.5 system-ui,"Malgun Gothic",sans-serif;padding:12px;color:#111;background:#fff;word-break:break-word;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}pre{white-space:pre-wrap;font:inherit;margin:0}a{color:#1a56db}</style>';
  const body = m.html ? sanitize(m.html) : `<pre>${escapeHtml(m.text || '(본문 없음)')}</pre>`;
  root.innerHTML = `${base}<div class="wrap">${body}</div>`;
  // HTML이 보이는 글자 없이 그려지면(숨김 스타일 등) 텍스트로 대체해 흰 화면 방지
  const wrap = root.querySelector('.wrap');
  if (m.html && !wrap.innerText.trim() && !wrap.querySelector('img')) {
    wrap.innerHTML = `<pre>${escapeHtml(m.text || '(본문을 표시할 수 없습니다. "Gmail에서 열기"를 누르세요.)')}</pre>`;
  }
}

function clearMailBody() {
  const root = $('rBody').shadowRoot;
  if (root) root.innerHTML = '';
}

const FOLDER_LABEL = { inbox: '받은편지함', all: '모든 메일', sent: '보낸 메일', starred: '별표' };

async function renderFolder(a, { more = false, force = false } = {}) {
  const folder = $('folder').value;
  const key = `${a.email}|${folder}`;
  const list = $('mailList');
  const cached = folderCache[key];
  if (cached && !more && !force) {
    drawFolder(a, folder, cached);
    return;
  }
  if (!more && !force && folderPending === key) return; // 이미 불러오는 중
  const page = more && cached ? cached.page + 1 : 1;
  const seq = ++folderSeq;
  folderPending = key;
  if (more) {
    $('more').disabled = true;
    $('more').textContent = '불러오는 중…';
  } else {
    list.textContent = '';
    $('moreRow').hidden = true;
    list.append(msg('Gmail에서 불러오는 중… (잠깐 최소화된 창이 열렸다 닫힙니다)'));
  }
  const res = await chrome.runtime.sendMessage({ type: 'LIST_ALL_MAIL', account: a.index, folder, page });
  if (seq !== folderSeq) return;
  folderPending = '';
  $('more').disabled = false;
  $('more').textContent = '더 보기';
  if (!res?.ok) {
    if (!more) list.textContent = '';
    list.append(msg(`⚠ ${res?.error || '불러오지 못했습니다.'} — "Gmail 열기"로 확인하세요.`));
    return;
  }
  const data = {
    mails: more && cached ? [...cached.mails, ...res.mails] : res.mails,
    page,
    hasMore: res.hasMore,
  };
  folderCache[key] = data;
  drawFolder(a, folder, data);
}

function drawFolder(a, folder, data) {
  const list = $('mailList');
  list.textContent = '';
  $('inboxInfo').textContent = `${a.email} · ${FOLDER_LABEL[folder]} ${data.mails.length}통${data.hasMore ? '+' : ''}`;
  $('moreRow').hidden = !data.hasMore;
  if (!data.mails.length) {
    list.append(msg('메일이 없습니다.'));
    return;
  }
  for (const m of data.mails) {
    const el = mailRow({ from: m.from, fromEmail: m.fromEmail, time: m.date, subject: m.subject, summary: m.snippet, unread: m.unread });
    el.title = [m.fromEmail, m.dateFull].filter(Boolean).join(' · ');
    el.addEventListener('click', () => {
      m.unread = false;
      openSessionReader(a, {
        id: '',
        hex: m.hex,
        link: gmailWebUrl(a.index, '', `#all/${m.threadHex || m.hex}`),
        title: m.subject,
        from: m.from,
        fromEmail: m.fromEmail,
        dateText: m.dateFull || m.date,
        summary: m.snippet,
      });
    });
    list.append(el);
  }
}

async function openSessionReader(a, e) {
  $('listPane').hidden = true;
  $('readerPane').hidden = false;
  $('rSubject').textContent = e.title;
  const when = e.dateText || new Date(Date.parse(e.issued) || Date.now()).toLocaleString();
  $('rMeta').textContent = `${e.from}${e.fromEmail ? ` <${e.fromEmail}>` : ''} · ${when}`;
  $('rAttach').textContent = '불러오는 중…';
  clearMailBody();
  openMsg = {
    id: e.id || e.hex,
    link: e.link,
    account: a.index,
    subject: e.title,
    from: e.fromEmail ? `${e.from} <${e.fromEmail}>` : e.from,
    date: Date.parse(e.issued) || Date.now(),
    text: e.summary,
    html: '',
  };
  try {
    const body = await fetchMessageBody(a.index, e);
    if (openMsg?.id !== (e.id || e.hex)) return;
    openMsg.html = body.html;
    openMsg.text = body.text;
    $('rAttach').textContent = '';
    renderMailBody({ html: body.html, text: body.text });
  } catch (err) {
    if (openMsg?.id !== (e.id || e.hex)) return;
    $('rAttach').textContent = `⚠ ${err.message} 미리보기만 표시합니다. 전체 내용은 "Gmail에서 열기"를 누르세요.`;
    renderMailBody({ text: e.summary });
  }
}

function closeReader(redraw = true) {
  openMsg = null;
  $('readerPane').hidden = true;
  $('listPane').hidden = false;
  clearMailBody();
  if (redraw) renderInbox();
}

function htmlToText(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return (doc.body?.innerText || doc.body?.textContent || '').trim();
}

function startReply() {
  const m = openMsg;
  if (!m) return;
  const src = m.from;
  $('to').value = (/<([^>]+)>/.exec(src) || [])[1] || src.trim();
  $('subject').value = /^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`;
  const quoted = (m.text || htmlToText(m.html)).split(/\r?\n/).map((l) => `> ${l}`).join('\n');
  $('body').value = `\n\n${new Date(m.date).toLocaleString()}, ${m.from} 작성:\n${quoted}`;
  $('replyText').textContent = `답장: ${m.subject}`;
  $('replyInfo').hidden = false;
  showView('sendView');
  $('body').focus();
  $('body').setSelectionRange(0, 0);
}

function cancelReply() {
  $('replyInfo').hidden = true;
}

// ---------- 계정 불러오기 ----------
async function loadAccounts() {
  const s = await chrome.storage.local.get(['accounts', 'inboxError']);
  accounts = s.accounts || [];
  inboxError = s.inboxError || null;
  // 선택했던 계정이 없어졌으면 첫 계정으로
  if (accounts.length && !currentAccount()) current = accounts[0].index;
  renderAccounts();
  renderInbox();
  renderFromLine();
}

async function refresh() {
  if (!settings.inboxCheck) return;
  $('refresh').disabled = true;
  await chrome.runtime.sendMessage({ type: 'CHECK_INBOX' });
  await loadAccounts();
  $('refresh').disabled = false;
}

// ---------- 보내기 ----------
async function getPageContext() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id;
  const base = { pageTitle: tab?.title || '', pageUrl: tab?.url || '', selectedText: '' };
  if (!tab?.id) return base;
  try {
    // content.js가 주입된 페이지
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'GET_SELECTION' });
    return { ...base, ...res };
  } catch {
    // 설치 전에 열린 탭 등: activeTab 권한으로 직접 실행
    try {
      const [r] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => String(window.getSelection() || '').trim(),
      });
      return { ...base, selectedText: r?.result || '' };
    } catch {
      return base; // chrome:// 등 접근 불가 페이지
    }
  }
}

function renderFromLine() {
  const line = $('fromLine');
  line.textContent = '';
  const a = currentAccount();
  const b = document.createElement('b');
  b.textContent = a ? a.email : `Gmail u/${current}`;
  line.append('보내는 계정: ', b, ' — 보내기를 누르면 이 계정의 Gmail 작성창이 내용이 채워진 채로 열립니다 (왼쪽에서 변경)');
}

const splitEmails = (v) => v.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);

// 자동완성: 최근 보낸 주소 + 설정에 저장한 주소
async function fillSuggestions() {
  const { recentTo = [] } = await chrome.storage.local.get('recentTo');
  const saved = settings.recipients.map((r) => r.email).filter(isValidEmail);
  const box = $('toSuggest');
  box.textContent = '';
  for (const email of [...new Set([...recentTo, ...saved])]) {
    const o = document.createElement('option');
    o.value = email;
    const r = settings.recipients.find((x) => x.email === email);
    if (r?.name) o.label = r.name;
    box.append(o);
  }
}

async function rememberRecipients(list) {
  const { recentTo = [] } = await chrome.storage.local.get('recentTo');
  await chrome.storage.local.set({ recentTo: [...new Set([...list, ...recentTo])].slice(0, 20) });
  fillSuggestions();
}

async function send() {
  const to = splitEmails($('to').value);
  const bad = to.filter((e) => !isValidEmail(e));
  if (!to.length || bad.length) {
    $('to').style.borderColor = 'var(--danger)';
    $('to').focus();
    setStatus(!to.length ? '받는 사람 이메일을 입력하세요.' : `잘못된 주소: ${bad.join(', ')}`, 'err');
    return;
  }
  const a = currentAccount();
  const account = a ? a.index : current;
  await rememberRecipients(to);
  // Gmail 작성창을 새 탭으로 열면 팝업은 자동으로 닫힘
  chrome.tabs.create({ url: buildComposeUrl('gmail', to, $('subject').value, $('body').value, account) });
}

async function initSend() {
  fillSuggestions();
  $('to').addEventListener('input', () => {
    $('to').style.borderColor = '';
    setStatus('');
  });
  $('send').addEventListener('click', send);
  $('cancelReply').addEventListener('click', cancelReply);
  // Ctrl/Cmd+Enter로 전송
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !$('sendView').hidden) send();
  });

  // 페이지에서 텍스트를 선택하고 열었을 때만 템플릿으로 미리 채움
  const ctx = await getPageContext();
  if (ctx.selectedText && !$('subject').value && !$('body').value) {
    const { subject, body } = buildMail(settings, ctx);
    $('subject').value = subject;
    $('body').value = body;
    showView('sendView');
  }
}

// ---------- 시작 ----------
async function init() {
  settings = await loadSettings();
  current = settings.gmailAccount ?? 0;

  for (const t of document.querySelectorAll('.tab')) {
    t.addEventListener('click', () => {
      showView(t.dataset.view);
      if (t.dataset.view === 'sendView') $('to').focus();
    });
  }
  let view = 'inboxView';
  try { view = localStorage.getItem('qes-view') || view; } catch { /* 무시 */ }
  showView(view);
  try { $('folder').value = localStorage.getItem('qes-folder') || 'unread'; } catch { /* 무시 */ }
  if (!$('folder').value) $('folder').value = 'unread';

  $('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('openGmail').addEventListener('click', () => chrome.tabs.create({ url: inboxUrl(currentAccount()?.email ?? current) }));
  $('refresh').addEventListener('click', () => {
    const a = currentAccount();
    if (a && $('folder').value !== 'unread') renderFolder(a, { force: true });
    refresh();
  });
  $('folder').addEventListener('change', () => {
    try { localStorage.setItem('qes-folder', $('folder').value); } catch { /* 무시 */ }
    renderInbox();
  });
  $('more').addEventListener('click', () => {
    const a = currentAccount();
    if (a) renderFolder(a, { more: true });
  });
  $('markAll').addEventListener('click', () => {
    const a = currentAccount();
    if (!a || !confirm(`${a.email}의 안 읽은 메일 ${a.count}통을 모두 읽음으로 표시할까요?\n(Gmail 탭이 열리고 자동으로 처리합니다)`)) return;
    chrome.runtime.sendMessage({ type: 'MARK_ALL_READ', account: a.index });
  });
  $('back').addEventListener('click', () => closeReader());
  $('reply').addEventListener('click', startReply);
  $('openInGmail').addEventListener('click', () => {
    if (!openMsg) return;
    chrome.tabs.create({ url: openMsg.link });
  });
  await loadAccounts(); // 캐시 먼저 표시
  refresh();
  initSend();
}

init();
