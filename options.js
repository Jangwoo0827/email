import { redirectUrl, disconnect } from './gmail.js';
import { loadSettings, saveSettings, isValidEmail, buildMail, MAX_RECIPIENTS } from './shared.js';

const $ = (id) => document.getElementById(id);
const TEXT_FIELDS = ['oauthClientId', 'subjectTemplate', 'bodyTemplate', 'sendMode', 'apiKey', 'fromEmail', 'webhookUrl'];
const CHECK_FIELDS = ['notify', 'contextMenu', 'inboxCheck', 'inboxNotify'];
const NUMBER_FIELDS = ['inboxInterval'];
let recipients = [];

function setStatus(text, kind = '') {
  $('status').textContent = text;
  $('status').className = 'status ' + kind;
}

function renderRecipients() {
  const box = $('recipients');
  box.textContent = '';
  recipients.forEach((r, i) => {
    const row = document.createElement('div');
    row.className = 'recipient';

    const name = document.createElement('input');
    name.type = 'text';
    name.placeholder = '이름/별칭 (예: 나, 회사)';
    name.value = r.name;
    name.addEventListener('input', () => (recipients[i].name = name.value));

    const email = document.createElement('input');
    email.type = 'email';
    email.placeholder = 'name@example.com';
    email.value = r.email;
    email.addEventListener('input', () => {
      recipients[i].email = email.value;
      email.style.borderColor = !email.value || isValidEmail(email.value) ? '' : 'var(--danger)';
    });

    const del = document.createElement('button');
    del.textContent = '삭제';
    del.addEventListener('click', () => {
      recipients.splice(i, 1);
      renderRecipients();
    });

    row.append(name, email, del);
    box.appendChild(row);
  });
  $('addRecipient').disabled = recipients.length >= MAX_RECIPIENTS;
}

function updateModeClass() {
  const mode = $('sendMode').value;
  document.body.classList.toggle('api', !['gmail', 'outlook', 'mailto'].includes(mode));
  document.body.classList.toggle('webhook', mode === 'webhook');
}

function collect() {
  const out = {
    recipients: recipients
      .map((r) => ({ name: r.name.trim(), email: r.email.trim() }))
      .filter((r) => r.name || r.email), // 완전히 빈 줄은 무시
  };
  for (const k of TEXT_FIELDS) out[k] = $(k).value;
  for (const k of ['oauthClientId', 'apiKey', 'fromEmail', 'webhookUrl']) out[k] = out[k].trim();
  for (const k of CHECK_FIELDS) out[k] = $(k).checked;
  for (const k of NUMBER_FIELDS) out[k] = Number($(k).value);
  out.extraAccounts = $('extraAccounts').value.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
  return out;
}

function validate(s) {
  const badAcct = s.extraAccounts.find((e) => !isValidEmail(e));
  if (badAcct) return `잘못된 계정 주소: "${badAcct}"`;
  const bad = s.recipients.find((r) => !isValidEmail(r.email));
  if (bad) return `잘못된 이메일 주소: "${bad.email || '(빈 칸)'}"`;
  if (s.oauthClientId && !/\.apps\.googleusercontent\.com$/.test(s.oauthClientId)) {
    return 'OAuth 클라이언트 ID는 .apps.googleusercontent.com 으로 끝나야 합니다.';
  }
  if (s.sendMode === 'resend' || s.sendMode === 'sendgrid') {
    if (!s.apiKey) return 'API 키를 입력하세요.';
    if (!isValidEmail(s.fromEmail)) return '발신자 이메일을 올바르게 입력하세요.';
  }
  if (s.sendMode === 'webhook') {
    try {
      if (!/^https?:$/.test(new URL(s.webhookUrl).protocol)) throw 0;
    } catch {
      return 'Webhook URL이 올바르지 않습니다.';
    }
  }
  return null;
}

async function save() {
  const s = collect();
  const err = validate(s);
  if (err) {
    setStatus(err, 'err');
    return false;
  }
  if (s.sendMode === 'webhook') {
    // 임의 도메인으로 fetch하려면 해당 origin 권한 필요 (저장 버튼 클릭 = 사용자 제스처)
    const origin = new URL(s.webhookUrl).origin + '/*';
    const granted = await chrome.permissions.request({ origins: [origin] });
    if (!granted) {
      setStatus('Webhook 도메인 접근 권한이 거부되었습니다.', 'err');
      return false;
    }
  }
  await saveSettings(s);
  setStatus('저장됨', 'ok');
  return true;
}

async function renderConnected() {
  const { connected = [] } = await chrome.storage.local.get('connected');
  const box = $('connectedList');
  box.textContent = connected.length ? '' : '없음 — 팝업에서 계정을 고르고 "계정 연결"을 누르세요.';
  for (const email of connected) {
    const row = document.createElement('div');
    row.className = 'row';
    row.style.margin = '4px 0';
    const b = document.createElement('button');
    b.textContent = '연결 해제';
    b.addEventListener('click', async () => {
      await disconnect(email);
      renderConnected();
    });
    row.append(email, b);
    box.append(row);
  }
}

async function init() {
  $('redirectUrl').value = redirectUrl();
  $('copyRedirect').addEventListener('click', async () => {
    await navigator.clipboard.writeText(redirectUrl());
    setStatus('리디렉션 URI 복사됨', 'ok');
  });
  renderConnected();

  const s = await loadSettings();
  recipients = s.recipients.map((r) => ({ name: r.name || '', email: r.email || '' }));
  for (const k of TEXT_FIELDS) $(k).value = s[k] ?? '';
  for (const k of CHECK_FIELDS) $(k).checked = !!s[k];
  for (const k of NUMBER_FIELDS) $(k).value = String(s[k]);
  $('extraAccounts').value = (s.extraAccounts || []).join('\n');
  if (!recipients.length) recipients.push({ name: '', email: '' });
  renderRecipients();
  updateModeClass();

  $('sendMode').addEventListener('change', updateModeClass);
  $('addRecipient').addEventListener('click', () => {
    if (recipients.length < MAX_RECIPIENTS) {
      recipients.push({ name: '', email: '' });
      renderRecipients();
    }
  });
  $('save').addEventListener('click', save);
  $('test').addEventListener('click', async () => {
    if (!(await save())) return;
    const settings = await loadSettings();
    const to = settings.recipients.map((r) => r.email);
    if (!to.length) return setStatus('수신자를 먼저 추가하세요.', 'err');
    setStatus('테스트 전송 중…');
    const { subject, body } = buildMail(settings, {
      pageTitle: '테스트 메일',
      pageUrl: location.href,
      selectedText: 'Quick Email Sender 테스트입니다.',
    });
    const res = await chrome.runtime.sendMessage({ type: 'SEND_EMAIL', payload: { to, subject, body } });
    setStatus(res?.ok ? '테스트 완료' : `실패: ${res?.error}`, res?.ok ? 'ok' : 'err');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      save();
    }
  });
}

init();
