import { inboxUrl } from './inbox.js';
import { listMessages, getMessage, markRead, sendMessage } from './gmail.js';
import { loadSettings, buildMail, isValidEmail, saveSettings, COMPOSE_MODES } from './shared.js';

const $ = (id) => document.getElementById(id);
const MODE_LABEL = {
  gmail: 'Gmail 작성창',
  outlook: 'Outlook 작성창',
  mailto: '메일 앱',
  resend: 'Resend 자동전송',
  sendgrid: 'SendGrid 자동전송',
  webhook: 'Webhook 자동전송',
};
const AVATAR_COLORS = ['#2563eb', '#16a34a', '#db2777', '#ea580c', '#7c3aed'];

let settings;
let accounts = []; // [{ index, email, name, photo, count, entries, checkedAt, error }]
let inboxError = null;
let connected = new Set(); // Gmail API로 연결된 계정 (소문자 이메일)
let current = 0; // 선택된 계정 (u/N 순번 또는 이메일)
let activeTabId;
let listSeq = 0; // 늦게 도착한 목록 응답 무시용
const apiCache = {}; // `${email}|${filter}` → 메일 목록
let openMsg = null; // 읽고 있는 메일
let replyCtx = null; // 답장 중이면 { threadId, inReplyTo, references }

const currentAccount = () => accounts.find((a) => a.index === current);
// 이 계정은 Gmail API로 본문 보기/바로 보내기 가능?
const isApi = (a) => !!(a && settings.oauthClientId && connected.has(a.email.toLowerCase()));

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
  if (!t) return '';
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
    b.title = a.email + (isApi(a) ? ' (연결됨)' : '');
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
    b.querySelector('.email').textContent = (isApi(a) ? '✓ ' : '') + (a.name || a.email.split('@')[0]);
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
function renderBanner(a) {
  const show = !!a && !a.error && !isApi(a);
  $('connectBanner').hidden = !show;
  if (!show) return;
  if (settings.oauthClientId) {
    $('connectText').textContent = `${a.email}을(를) 연결하면 메일 본문을 여기서 읽고, 여기서 바로 보낼 수 있습니다.`;
    $('connectBtn').textContent = '계정 연결';
  } else {
    $('connectText').textContent = '메일 본문 보기·익스텐션에서 바로 보내기를 쓰려면 설정에서 Gmail 연결(처음 1회)을 하세요.';
    $('connectBtn').textContent = '설정 열기';
  }
}

function renderInbox() {
  const list = $('mailList');
  const a = currentAccount();
  $('unread').textContent = a?.count ? String(a.count) : '';
  renderBanner(a);
  $('filter').hidden = !isApi(a);
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
  if (isApi(a)) {
    if (!openMsg) renderApiList(a);
    return;
  }
  list.textContent = '';
  if (a.error) {
    $('inboxInfo').textContent = `${a.email} · ⚠ ${a.error}`;
    list.append(msg('이 계정의 Gmail 세션을 읽을 수 없습니다. "Gmail 열기"로 이 계정에 다시 로그인한 뒤 새로고침하세요.'));
    return;
  }
  const when = a.checkedAt ? new Date(a.checkedAt).toLocaleTimeString() : '';
  $('inboxInfo').textContent = `${a.email} · 안 읽음 ${a.count} · ${when}`;
  if (!a.entries.length) {
    list.append(msg('안 읽은 메일이 없습니다 🎉'));
    return;
  }
  // 연결 전: 미리보기만 가능, 클릭하면 Gmail 탭으로
  for (const e of a.entries) {
    const el = mailRow({ from: e.from, fromEmail: e.fromEmail, time: e.issued, subject: e.title, summary: e.summary, unread: true });
    el.addEventListener('click', () => chrome.tabs.create({ url: e.link }));
    list.append(el);
  }
}

async function renderApiList(a) {
  const filter = $('filter').value;
  const cacheKey = `${a.email}|${filter}`;
  const seq = ++listSeq;
  if (apiCache[cacheKey]) {
    drawApiList(a, apiCache[cacheKey]); // 새로고침 버튼을 누르면 캐시가 비워져 다시 불러옴
    return;
  } else {
    $('mailList').textContent = '';
    $('mailList').append(msg('불러오는 중…'));
  }
  try {
    const items = await listMessages(a.email, { q: filter });
    if (seq !== listSeq) return;
    apiCache[cacheKey] = items;
    drawApiList(a, items);
  } catch (e) {
    if (seq !== listSeq) return;
    $('mailList').textContent = '';
    $('mailList').append(msg(`⚠ ${e.message}`));
  }
}

function drawApiList(a, items) {
  const list = $('mailList');
  list.textContent = '';
  $('inboxInfo').textContent = `${a.email} · 안 읽음 ${a.count}`;
  if (!items.length) {
    list.append(msg($('filter').value.includes('is:unread') ? '안 읽은 메일이 없습니다 🎉' : '메일이 없습니다.'));
    return;
  }
  for (const it of items) {
    const el = mailRow({ from: it.from, fromEmail: it.fromEmail, time: it.date, subject: it.subject, summary: it.snippet, unread: it.unread });
    el.addEventListener('click', () => openReader(a, it));
    list.append(el);
  }
}

// ---------- 메일 읽기 ----------
const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function mailDoc(m) {
  const style =
    '<style>body{font:14px/1.5 system-ui,"Malgun Gothic",sans-serif;margin:10px;color:#111;background:#fff;word-break:break-word}img{max-width:100%;height:auto}pre{white-space:pre-wrap;font:inherit}</style>';
  const body = m.html || `<pre>${escapeHtml(m.text || '(본문 없음)')}</pre>`;
  // 링크는 새 탭으로. sandbox라 메일 안의 스크립트는 실행되지 않음
  return `<!doctype html><meta charset="utf-8"><base target="_blank">${style}${body}`;
}

async function openReader(a, it) {
  $('listPane').hidden = true;
  $('readerPane').hidden = false;
  $('rSubject').textContent = it.subject;
  $('rMeta').textContent = '불러오는 중…';
  $('rAttach').textContent = '';
  $('rBody').srcdoc = '';
  openMsg = { ...it, account: a.email };
  try {
    const m = await getMessage(a.email, it.id);
    if (openMsg?.id !== it.id) return;
    openMsg = { ...m, account: a.email };
    $('rSubject').textContent = m.subject;
    $('rMeta').textContent = `${m.from} → ${m.to}${m.cc ? ` · 참조 ${m.cc}` : ''} · ${new Date(m.date).toLocaleString()}`;
    $('rAttach').textContent = m.attachments.length ? `📎 첨부 ${m.attachments.map((x) => x.name).join(', ')} (Gmail에서 열기)` : '';
    $('rBody').srcdoc = mailDoc(m);
    if (m.unread) {
      await markRead(a.email, m.id);
      it.unread = false;
      a.count = Math.max(0, (a.count || 0) - 1);
      renderAccounts();
      $('unread').textContent = a.count ? String(a.count) : '';
      chrome.runtime.sendMessage({ type: 'CHECK_INBOX' }); // 배지 갱신
    }
  } catch (e) {
    $('rMeta').textContent = `⚠ ${e.message}`;
  }
}

function closeReader(redraw = true) {
  openMsg = null;
  $('readerPane').hidden = true;
  $('listPane').hidden = false;
  $('rBody').srcdoc = '';
  if (redraw) renderInbox();
}

function htmlToText(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return (doc.body?.innerText || doc.body?.textContent || '').trim();
}

function startReply() {
  const m = openMsg;
  if (!m?.messageId) return;
  const src = m.replyTo || m.from;
  $('to').value = (/<([^>]+)>/.exec(src) || [])[1] || src.trim();
  $('subject').value = /^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`;
  const quoted = (m.text || htmlToText(m.html)).split(/\r?\n/).map((l) => `> ${l}`).join('\n');
  $('body').value = `\n\n${new Date(m.date).toLocaleString()}, ${m.from} 작성:\n${quoted}`;
  replyCtx = { threadId: m.threadId, inReplyTo: m.messageId, references: m.references };
  $('replyText').textContent = `답장: ${m.subject}`;
  $('replyInfo').hidden = false;
  showView('sendView');
  $('body').focus();
  $('body').setSelectionRange(0, 0);
}

function cancelReply() {
  replyCtx = null;
  $('replyInfo').hidden = true;
}

// ---------- 계정 불러오기 ----------
async function loadAccounts() {
  const s = await chrome.storage.local.get(['accounts', 'inboxError', 'connected']);
  accounts = s.accounts || [];
  inboxError = s.inboxError || null;
  connected = new Set(s.connected || []);
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
  if (isApi(a)) {
    b.textContent = a.email;
    line.append('보내는 계정: ', b, ' — 익스텐션에서 바로 보냅니다 (왼쪽에서 변경)');
    $('mode').textContent = 'Gmail API';
    $('send').textContent = '보내기';
    return;
  }
  $('mode').textContent = MODE_LABEL[settings.sendMode] || settings.sendMode;
  $('send').textContent = COMPOSE_MODES.includes(settings.sendMode) ? '작성창 열기' : '바로 전송';
  if (settings.sendMode === 'gmail') {
    b.textContent = a ? a.email : `Gmail u/${current}`;
    line.append('보내는 계정: ', b, ' — Gmail 작성창이 열립니다. 계정을 연결하면 여기서 바로 보낼 수 있습니다.');
  } else if (['resend', 'sendgrid', 'webhook'].includes(settings.sendMode)) {
    line.append(`보내는 주소: ${settings.fromEmail || '(설정 필요)'} — API 전송은 설정의 발신자 주소를 사용합니다`);
  } else {
    line.append(`${MODE_LABEL[settings.sendMode]}의 기본 계정으로 보냅니다`);
  }
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
  const subject = $('subject').value;
  const body = $('body').value;
  const a = currentAccount();
  $('send').disabled = true;
  setStatus('보내는 중…');

  if (isApi(a)) {
    try {
      await sendMessage(a.email, { to, subject, body, ...(replyCtx || {}) });
      await rememberRecipients(to);
      setStatus(`${a.email}에서 보냈습니다 ✓`, 'ok');
      $('to').value = '';
      $('subject').value = '';
      $('body').value = '';
      cancelReply();
    } catch (e) {
      setStatus(e.message, 'err');
    }
    $('send').disabled = false;
    return;
  }

  const res = await chrome.runtime.sendMessage({
    type: 'SEND_EMAIL',
    payload: { to, subject, body, tabId: activeTabId, account: current },
  });
  if (res?.ok) {
    await rememberRecipients(to);
    setStatus('완료', 'ok');
    setTimeout(() => window.close(), 600);
  } else {
    setStatus(res?.error || '실패', 'err');
    $('send').disabled = false;
  }
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

  $('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('openGmail').addEventListener('click', () => chrome.tabs.create({ url: inboxUrl(currentAccount()?.email ?? current) }));
  $('refresh').addEventListener('click', () => {
    for (const k of Object.keys(apiCache)) delete apiCache[k];
    refresh();
  });
  $('filter').addEventListener('change', () => renderInbox());
  $('back').addEventListener('click', () => closeReader());
  $('reply').addEventListener('click', startReply);
  $('openInGmail').addEventListener('click', () => {
    if (openMsg) chrome.tabs.create({ url: `https://mail.google.com/mail/u/${encodeURIComponent(openMsg.account)}/#all/${openMsg.id}` });
  });
  $('connectBtn').addEventListener('click', () => {
    const a = currentAccount();
    if (!settings.oauthClientId) return chrome.runtime.openOptionsPage();
    // 로그인 창이 뜨면 이 팝업은 닫힘 → 연결 후 팝업을 다시 열면 됨
    chrome.runtime.sendMessage({ type: 'CONNECT_ACCOUNT', email: a?.email });
  });

  await loadAccounts(); // 캐시 먼저 표시
  refresh();
  initSend();
}

init();
