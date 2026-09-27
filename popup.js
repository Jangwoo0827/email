import { inboxUrl } from './inbox.js';
import { loadSettings, saveSettings, buildMail, isValidEmail, COMPOSE_MODES } from './shared.js';

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
let accounts = []; // [{ index, email, count, entries, checkedAt }]
let inboxError = null;
let current = 0; // 선택된 계정의 Gmail 순번 (u/N)
let activeTabId;

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
  for (const a of accounts) {
    const b = document.createElement('button');
    b.className = 'acct' + (a.index === current ? ' active' : '');
    b.title = a.email;
    b.innerHTML = '<span class="avatar"></span><span class="info"><div class="email"></div><div class="hint"></div></span><span class="badge"></span>';
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
    av.style.background = AVATAR_COLORS[a.index % AVATAR_COLORS.length];
    b.querySelector('.email').textContent = a.name || a.email.split('@')[0];
    const hint = b.querySelector('.hint');
    hint.textContent = a.error ? '다시 로그인 필요' : a.email;
    hint.classList.toggle('err', !!a.error);
    b.querySelector('.badge').textContent = a.count ? String(a.count) : '';
    b.addEventListener('click', () => selectAccount(a.index));
    box.append(b);
  }
}

function selectAccount(index) {
  current = index;
  saveSettings({ gmailAccount: index }); // 보내기(Gmail 작성창)와 받은편지함 모두 이 계정 사용
  renderAccounts();
  renderInbox();
  renderFromLine();
}

// ---------- 받은편지함 ----------
function timeAgo(iso) {
  const t = Date.parse(iso);
  if (!t) return '';
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return '방금';
  if (m < 60) return `${m}분 전`;
  if (m < 60 * 24) return `${Math.round(m / 60)}시간 전`;
  return new Date(t).toLocaleDateString();
}

function renderInbox() {
  const list = $('mailList');
  list.textContent = '';
  const a = currentAccount();
  $('unread').textContent = a?.count ? String(a.count) : '';
  if (!settings.inboxCheck) {
    $('inboxInfo').textContent = '';
    list.append(msg('받은편지함 확인이 꺼져 있습니다. 설정에서 켜세요.'));
    return;
  }
  if (!a) {
    $('inboxInfo').textContent = inboxError ? `⚠ ${inboxError}` : '';
    list.append(msg(inboxError ? 'Chrome에서 Gmail에 로그인한 뒤 새로고침하세요.' : '확인 중…'));
    return;
  }
  if (a.error) {
    $('inboxInfo').textContent = `${a.email} · ⚠ ${a.error}`;
    list.append(msg('이 계정의 Gmail 세션을 읽을 수 없습니다. "Gmail 열기"로 이 계정에 다시 로그인한 뒤 새로고침하세요.'));
    return;
  }
  const when = a.checkedAt ? new Date(a.checkedAt).toLocaleTimeString() : '';
  $('inboxInfo').textContent = `${a.email} · 안 읽음 ${a.count} · ${when}${inboxError ? ' ⚠' : ''}`;
  if (!a.entries.length) {
    list.append(msg('안 읽은 메일이 없습니다 🎉'));
    return;
  }
  for (const e of a.entries) {
    const el = document.createElement('a');
    el.className = 'mail';
    el.href = e.link;
    el.target = '_blank';
    el.title = e.fromEmail;
    el.innerHTML =
      '<div class="head"><span class="from"></span><span class="time"></span></div><div class="subj"></div><div class="sum"></div>';
    el.querySelector('.from').textContent = e.from;
    el.querySelector('.time').textContent = timeAgo(e.issued);
    el.querySelector('.subj').textContent = e.title;
    el.querySelector('.sum').textContent = e.summary;
    list.append(el);
  }
}

async function loadAccounts() {
  const s = await chrome.storage.local.get(['accounts', 'inboxError']);
  accounts = s.accounts || [];
  inboxError = s.inboxError || null;
  // 선택했던 계정이 로그아웃되었으면 첫 계정으로
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
  if (settings.sendMode === 'gmail') {
    line.append('보내는 계정: ');
    const b = document.createElement('b');
    b.textContent = a ? a.email : `Gmail u/${current}`;
    line.append(b, ' (왼쪽에서 변경)');
  } else if (['resend', 'sendgrid', 'webhook'].includes(settings.sendMode)) {
    line.append(`보내는 주소: ${settings.fromEmail || '(설정 필요)'} — API 전송은 설정의 발신자 주소를 사용합니다`);
  } else {
    line.append(`${MODE_LABEL[settings.sendMode]}의 기본 계정으로 보냅니다 (Gmail 작성창 모드에서 계정 선택 가능)`);
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
}

async function initSend() {
  $('mode').textContent = MODE_LABEL[settings.sendMode] || settings.sendMode;
  $('send').textContent = COMPOSE_MODES.includes(settings.sendMode) ? '작성창 열기' : '바로 전송';
  fillSuggestions();

  const ctx = await getPageContext();
  const { subject, body } = buildMail(settings, ctx);
  $('subject').value = subject;
  $('body').value = body;

  $('to').addEventListener('input', () => {
    $('to').style.borderColor = '';
    setStatus('');
  });

  $('send').addEventListener('click', async () => {
    const to = splitEmails($('to').value);
    const bad = to.filter((e) => !isValidEmail(e));
    if (!to.length || bad.length) {
      $('to').style.borderColor = 'var(--danger)';
      $('to').focus();
      setStatus(!to.length ? '받는 사람 이메일을 입력하세요.' : `잘못된 주소: ${bad.join(', ')}`, 'err');
      return;
    }
    $('send').disabled = true;
    setStatus('전송 중…');
    const res = await chrome.runtime.sendMessage({
      type: 'SEND_EMAIL',
      payload: { to, subject: $('subject').value, body: $('body').value, tabId: activeTabId, account: current },
    });
    if (res?.ok) {
      await rememberRecipients(to);
      setStatus('완료', 'ok');
      setTimeout(() => window.close(), 600);
    } else {
      setStatus(res?.error || '실패', 'err');
      $('send').disabled = false;
    }
  });

  // Ctrl/Cmd+Enter로 전송
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !$('sendView').hidden) $('send').click();
  });
}

// ---------- 시작 ----------
async function init() {
  settings = await loadSettings();
  current = settings.gmailAccount || 0;

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
  $('openGmail').addEventListener('click', () => chrome.tabs.create({ url: inboxUrl(current) }));
  $('refresh').addEventListener('click', refresh);

  await loadAccounts(); // 캐시 먼저 표시
  refresh();
  initSend();
}

init();
