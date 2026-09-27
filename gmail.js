// Gmail API (공식) — 메일 본문 읽기, 읽음 처리, 익스텐션 안에서 바로 보내기
// 인증: chrome.identity.launchWebAuthFlow + OAuth 클라이언트 ID(설정 페이지에서 입력)
// 토큰은 1시간짜리 access token만 chrome.storage.session에 보관 (브라우저 종료 시 삭제)

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
// gmail.modify = 읽기 + 읽음 표시 + 보내기 (영구 삭제는 불가)
const SCOPES = 'https://www.googleapis.com/auth/gmail.modify openid email';

const key = (email) => String(email).toLowerCase();

export const redirectUrl = () => chrome.identity.getRedirectURL();

async function clientId() {
  const { oauthClientId = '' } = await chrome.storage.sync.get('oauthClientId');
  if (!oauthClientId) throw new Error('설정에서 Google OAuth 클라이언트 ID를 먼저 입력하세요.');
  return oauthClientId;
}

// interactive=true면 Google 로그인/동의 창을 띄움 (팝업에서 호출하면 팝업이 닫히므로 background에서 호출)
export async function authorize(email, interactive) {
  const p = new URLSearchParams({
    client_id: await clientId(),
    response_type: 'token',
    redirect_uri: redirectUrl(),
    scope: SCOPES,
    include_granted_scopes: 'true',
  });
  if (email) p.set('login_hint', email);
  else p.set('prompt', 'select_account');
  const url = await chrome.identity.launchWebAuthFlow({
    url: `https://accounts.google.com/o/oauth2/v2/auth?${p}`,
    interactive,
  });
  const h = new URLSearchParams(new URL(url).hash.slice(1));
  if (h.get('error')) throw new Error(`Google 인증 실패: ${h.get('error')}`);
  const token = h.get('access_token');
  if (!token) throw new Error('Google 인증 실패: 토큰 없음');

  const info = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${token}` },
  }).then((r) => r.json());
  const addr = key(info.email || email);

  const { tokens = {} } = await chrome.storage.session.get('tokens');
  tokens[addr] = { token, exp: Date.now() + (Number(h.get('expires_in') || 3600) - 60) * 1000 };
  await chrome.storage.session.set({ tokens });
  const { connected = [] } = await chrome.storage.local.get('connected');
  if (!connected.includes(addr)) await chrome.storage.local.set({ connected: [...connected, addr] });
  return addr;
}

export async function isConnected(email) {
  const { connected = [] } = await chrome.storage.local.get('connected');
  return connected.includes(key(email));
}

export async function disconnect(email) {
  const addr = key(email);
  const { connected = [] } = await chrome.storage.local.get('connected');
  const { tokens = {} } = await chrome.storage.session.get('tokens');
  const t = tokens[addr]?.token;
  delete tokens[addr];
  await chrome.storage.session.set({ tokens });
  await chrome.storage.local.set({ connected: connected.filter((x) => x !== addr) });
  if (t) fetch(`https://oauth2.googleapis.com/revoke?token=${t}`, { method: 'POST' }).catch(() => {});
}

async function getToken(email, force = false) {
  const addr = key(email);
  const { tokens = {} } = await chrome.storage.session.get('tokens');
  if (!force && tokens[addr] && tokens[addr].exp > Date.now()) return tokens[addr].token;
  // 이미 동의한 계정은 창 없이 새 토큰 발급
  try {
    await authorize(addr, false);
  } catch {
    throw new Error('Gmail 연결이 만료되었습니다. "계정 연결"을 다시 눌러주세요.');
  }
  const { tokens: t2 = {} } = await chrome.storage.session.get('tokens');
  return t2[addr].token;
}

async function api(email, path, opts = {}, retry = true) {
  const token = await getToken(email);
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (res.status === 401 && retry) {
    await getToken(email, true);
    return api(email, path, opts, false);
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Gmail API 오류 (${res.status}) ${err?.error?.message || ''}`);
  }
  return res.status === 204 ? null : res.json();
}

const header = (headers, name) =>
  (headers || []).find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';

function parseFrom(v) {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>/.exec(v);
  return m ? { name: m[1].trim() || m[2], email: m[2] } : { name: v, email: v };
}

// 받은편지함 목록 (q: Gmail 검색어)
export async function listMessages(email, { q = 'in:inbox', max = 30 } = {}) {
  const list = await api(email, `/messages?maxResults=${max}&q=${encodeURIComponent(q)}`);
  const ids = (list.messages || []).map((m) => m.id);
  const meta = await Promise.all(
    ids.map((id) =>
      api(email, `/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`),
    ),
  );
  return meta.map((m) => {
    const from = parseFrom(header(m.payload?.headers, 'From'));
    return {
      id: m.id,
      threadId: m.threadId,
      from: from.name,
      fromEmail: from.email,
      subject: header(m.payload?.headers, 'Subject') || '(제목 없음)',
      date: Number(m.internalDate),
      snippet: decodeEntities(m.snippet || ''),
      unread: (m.labelIds || []).includes('UNREAD'),
    };
  });
}

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function b64urlToBytes(data) {
  const bin = atob(data.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function decodePart(part) {
  const ct = header(part.headers, 'Content-Type');
  const charset = (/charset="?([^";]+)/i.exec(ct) || [])[1] || 'utf-8';
  const bytes = b64urlToBytes(part.body.data);
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

// 메일 전체 (본문 html/text, 첨부 이름)
export async function getMessage(email, id) {
  const m = await api(email, `/messages/${id}?format=full`);
  let html = '';
  let text = '';
  const attachments = [];
  (function walk(p) {
    if (!p) return;
    if (p.filename && p.body?.attachmentId) attachments.push({ name: p.filename, size: p.body.size });
    else if (p.mimeType === 'text/html' && p.body?.data && !html) html = decodePart(p);
    else if (p.mimeType === 'text/plain' && p.body?.data && !text) text = decodePart(p);
    (p.parts || []).forEach(walk);
  })(m.payload);
  const h = m.payload?.headers;
  return {
    id: m.id,
    threadId: m.threadId,
    from: header(h, 'From'),
    to: header(h, 'To'),
    cc: header(h, 'Cc'),
    replyTo: header(h, 'Reply-To'),
    subject: header(h, 'Subject') || '(제목 없음)',
    date: Number(m.internalDate),
    messageId: header(h, 'Message-ID') || header(h, 'Message-Id'),
    references: header(h, 'References'),
    html,
    text,
    attachments,
    unread: (m.labelIds || []).includes('UNREAD'),
  };
}

export function markRead(email, id) {
  return api(email, `/messages/${id}/modify`, { method: 'POST', body: JSON.stringify({ removeLabelIds: ['UNREAD'] }) });
}

// ---------- 보내기 ----------
function bytesToB64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
const utf8b64 = (s) => bytesToB64(new TextEncoder().encode(s));
const encodeHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${utf8b64(s)}?=`);

// to/cc: 이메일 배열. 답장이면 threadId, inReplyTo, references 전달
export async function sendMessage(email, { to, cc = [], subject, body, threadId, inReplyTo, references }) {
  const lines = [
    `To: ${to.join(', ')}`,
    cc.length ? `Cc: ${cc.join(', ')}` : '',
    `Subject: ${encodeHeader(subject)}`,
    inReplyTo ? `In-Reply-To: ${inReplyTo}` : '',
    inReplyTo ? `References: ${[references, inReplyTo].filter(Boolean).join(' ')}` : '',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  ].filter(Boolean);
  const bodyB64 = utf8b64(body.replace(/\r?\n/g, '\r\n')).replace(/.{76}/g, '$&\r\n');
  const mime = `${lines.join('\r\n')}\r\n\r\n${bodyB64}`;
  const raw = btoa(mime).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return api(email, '/messages/send', { method: 'POST', body: JSON.stringify(threadId ? { raw, threadId } : { raw }) });
}
