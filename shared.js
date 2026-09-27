// 공통 설정/템플릿/전송 로직 (background, popup, options에서 import)

export const MAX_RECIPIENTS = 5;

// chrome.storage.sync (기기 간 동기화되는 일반 설정)
export const DEFAULT_SETTINGS = {
  recipients: [], // [{ name, email }]
  checkedRecipients: [0], // 팝업에서 체크된 수신자 인덱스(마지막 선택 기억)
  subjectTemplate: '[Quick Note] {{page_title}}',
  bodyTemplate: '선택한 텍스트: {{selected_text}}\n출처 URL: {{page_url}}\n일시: {{timestamp}}',
  notify: true,
  contextMenu: true,
  inboxCheck: true, // Gmail 받은편지함 새 메일 확인
  inboxInterval: 5, // 분
  inboxNotify: true, // 새 메일 알림
  gmailAccount: 0, // 팝업 왼쪽에서 선택한 Gmail 계정 순번 (/mail/u/N) — 보내기/받은편지함 모두 사용
  sendMode: 'gmail', // 'gmail' | 'outlook' | 'mailto' | 'resend' | 'sendgrid' | 'webhook'
};

// chrome.storage.local (API 키 등 민감 정보는 동기화하지 않음)
export const DEFAULT_SECRETS = {
  apiKey: '',
  fromEmail: '',
  webhookUrl: '',
};

export async function loadSettings() {
  const [sync, local] = await Promise.all([
    chrome.storage.sync.get(DEFAULT_SETTINGS),
    chrome.storage.local.get(DEFAULT_SECRETS),
  ]);
  return { ...sync, ...local };
}

export async function saveSettings(all) {
  const sync = {};
  const local = {};
  for (const k of Object.keys(DEFAULT_SETTINGS)) if (k in all) sync[k] = all[k];
  for (const k of Object.keys(DEFAULT_SECRETS)) if (k in all) local[k] = all[k];
  await Promise.all([chrome.storage.sync.set(sync), chrome.storage.local.set(local)]);
}

export function isValidEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s).trim());
}

export function renderTemplate(tpl, ctx) {
  const vars = {
    page_title: ctx.pageTitle || '',
    page_url: ctx.pageUrl || '',
    selected_text: ctx.selectedText || '',
    link_url: ctx.linkUrl || '',
    timestamp: new Date().toLocaleString(),
  };
  return String(tpl || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (m, key) => (key in vars ? vars[key] : m));
}

export function buildMail(settings, ctx) {
  return {
    subject: renderTemplate(settings.subjectTemplate, ctx),
    body: renderTemplate(settings.bodyTemplate, ctx),
  };
}

export const COMPOSE_MODES = ['gmail', 'outlook', 'mailto'];

// 메일 작성창 URL (to: 이메일 배열)
export function buildComposeUrl(mode, to, subject, body, account = 0) {
  // URLSearchParams는 공백을 '+'로 바꾸므로 encodeURIComponent 사용
  const enc = encodeURIComponent;
  const list = to.join(',');
  if (mode === 'gmail') {
    return `https://mail.google.com/mail/u/${account}/?view=cm&fs=1&to=${enc(list)}&su=${enc(subject)}&body=${enc(body)}`;
  }
  if (mode === 'outlook') {
    return `https://outlook.live.com/mail/0/deeplink/compose?to=${enc(list)}&subject=${enc(subject)}&body=${enc(body)}`;
  }
  return `mailto:${to.map(enc).join(',')}?subject=${enc(subject)}&body=${enc(body.replace(/\r?\n/g, '\r\n'))}`;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// Email Service API 전송. 성공 시 resolve, 실패 시 Error throw
export async function sendViaApi(settings, { to, subject, body }) {
  const { sendMode, apiKey, fromEmail, webhookUrl } = settings;
  let res;
  if (sendMode === 'resend') {
    if (!apiKey || !fromEmail) throw new Error('Resend API 키와 발신자 이메일을 설정하세요.');
    res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: fromEmail,
        to,
        subject,
        text: body,
        html: `<pre style="font-family:inherit;white-space:pre-wrap">${escapeHtml(body)}</pre>`,
      }),
    });
  } else if (sendMode === 'sendgrid') {
    if (!apiKey || !fromEmail) throw new Error('SendGrid API 키와 발신자 이메일을 설정하세요.');
    res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: to.map((email) => ({ email })) }],
        from: { email: fromEmail },
        subject,
        content: [{ type: 'text/plain', value: body }],
      }),
    });
  } else if (sendMode === 'webhook') {
    if (!webhookUrl) throw new Error('Webhook URL을 설정하세요.');
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    res = await fetch(webhookUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ to, from: fromEmail || undefined, subject, text: body, sentAt: new Date().toISOString() }),
    });
  } else {
    throw new Error(`알 수 없는 전송 모드: ${sendMode}`);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${detail.slice(0, 200)}`);
  }
}
