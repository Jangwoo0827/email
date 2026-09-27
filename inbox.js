import { gmailWebUrl } from './shared.js';

// Gmail 받은편지함 확인 (Atom 피드 — 브라우저의 Gmail 로그인 세션을 그대로 사용, OAuth 불필요)
// service worker에는 DOMParser가 없으므로 정규식으로 파싱

const decode = (s = '') =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
    .replace(/&amp;/g, '&')
    .trim();

const tag = (xml, name) => decode((new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(xml) || [])[1]);

export function inboxUrl(account = 0) {
  return gmailWebUrl(account, '', '#inbox');
}

export async function fetchInbox(account = 0) {
  const res = await fetch(`https://mail.google.com/mail/u/${u(account)}/feed/atom`, {
    credentials: 'include',
    cache: 'no-store',
  });
  if (res.status === 401 || res.status === 403) throw new Error('Gmail에 로그인되어 있지 않습니다.');
  if (!res.ok) throw new Error(`Gmail 확인 실패 (HTTP ${res.status})`);
  const xml = await res.text();
  if (!xml.includes('<feed')) throw new Error('Gmail에 로그인되어 있지 않습니다.');

  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, e]) => {
    const author = (/<author>([\s\S]*?)<\/author>/.exec(e) || [])[1] || '';
    return {
      id: tag(e, 'id'),
      title: tag(e, 'title') || '(제목 없음)',
      summary: tag(e, 'summary'),
      link: decode((/<link[^>]*href="([^"]+)"/.exec(e) || [])[1]) || inboxUrl(account),
      issued: tag(e, 'issued') || tag(e, 'modified'),
      from: tag(author, 'name') || tag(author, 'email'),
      fromEmail: tag(author, 'email'),
    };
  });
  const count = parseInt(tag(xml, 'fullcount'), 10);
  return {
    account: tag(xml, 'title').replace(/^Gmail - Inbox for /i, ''),
    count: Number.isFinite(count) ? count : entries.length,
    entries,
    checkedAt: Date.now(),
  };
}

// account: 순번(0,1,…) 또는 이메일 주소 — Gmail은 /mail/u/<이메일>/ 형식도 지원
const u = (account) => encodeURIComponent(String(account));

// 이메일 경로로 먼저, 안 되면 순번으로
async function fetchFor(email, index) {
  try {
    const inbox = await fetchInbox(email);
    if (!inbox.account || inbox.account.toLowerCase() === email.toLowerCase()) return { key: email, inbox };
  } catch { /* 순번으로 재시도 */ }
  if (index != null) {
    const inbox = await fetchInbox(index);
    if (inbox.account.toLowerCase() === email.toLowerCase()) return { key: index, inbox };
    throw new Error('이 계정의 Gmail 세션을 찾을 수 없습니다.');
  }
  throw new Error('Gmail에 로그인되어 있지 않습니다.');
}

async function checkOne(acc, index) {
  try {
    const { key, inbox } = await fetchFor(acc.email, index);
    return { ...acc, ...inbox, index: key, email: acc.email, error: null };
  } catch (e) {
    return { ...acc, index: acc.email, count: 0, entries: [], checkedAt: Date.now(), error: e.message };
  }
}

// 로그인된 모든 계정의 받은편지함 확인. 실패한 계정도 목록에 남기고 error로 표시
// extraEmails: 설정에서 직접 추가한 계정
export async function fetchAllAccounts(extraEmails = []) {
  let accounts;
  {
    // 목록을 못 읽으면 u/0 … u/9 를 시도 (없는 번호는 u/0으로 돌아와 중복 → 건너뜀)
    accounts = [];
    let misses = 0;
    for (let i = 0; i < 10 && misses < 3; i++) {
      try {
        const inbox = await fetchInbox(i);
        if (accounts.some((a) => a.email === inbox.account)) {
          misses++;
          continue;
        }
        accounts.push({ ...inbox, index: i, email: inbox.account, name: '', photo: '', error: null });
      } catch {
        misses++;
      }
    }
  }
  const have = new Set(accounts.map((a) => a.email.toLowerCase()));
  for (const email of extraEmails) {
    if (!email || have.has(email.toLowerCase())) continue;
    have.add(email.toLowerCase());
    accounts.push(await checkOne({ email, name: '', photo: '' }, null));
  }
  if (!accounts.length) throw new Error('Gmail에 로그인되어 있지 않습니다.');
  return accounts;
}

// ---------- OAuth 없이 본문 읽기 (비공식: Gmail 로그인 세션 + "인쇄 보기" 페이지) ----------
// Gmail 구조가 바뀌면 동작하지 않을 수 있음 → 실패하면 호출한 쪽에서 Gmail 탭으로 안내

const ikCache = {};

// Gmail 페이지에 들어 있는 계정 키(ik). 인쇄 보기 요청에 필요
async function getIk(account) {
  if (ikCache[account]) return ikCache[account];
  const res = await fetch(gmailWebUrl(account), { credentials: 'include', cache: 'no-store' });
  const html = await res.text();
  const m =
    /GLOBALS=\[(?:[^,\]]*,){9}"([0-9a-f]{6,16})"/.exec(html) ||
    /[?&]ik=([0-9a-f]{6,16})/.exec(html) ||
    /"ik"\s*:\s*"([0-9a-f]{6,16})"/.exec(html);
  if (!m) throw new Error('Gmail 계정 키를 찾지 못했습니다.');
  ikCache[account] = m[1];
  return m[1];
}

// entry: fetchInbox()의 메일 항목 ({ id: 'tag:gmail.google.com,2004:<10진수>', link: '...message_id=<16진수>...' })
export async function fetchMessageBody(account, entry) {
  const hex =
    entry.hex ||
    (/message_id=([0-9a-f]+)/i.exec(entry.link || '') || [])[1] ||
    ((/:(\d+)$/.exec(entry.id || '') || [])[1] ? BigInt(/:(\d+)$/.exec(entry.id)[1]).toString(16) : '');
  const dec = (/:(\d+)$/.exec(entry.id || '') || [])[1] || (hex ? BigInt(`0x${hex}`).toString() : '');
  if (!dec && !hex) throw new Error('메일 ID를 알 수 없습니다.');

  let ik = '';
  try {
    ik = await getIk(account);
  } catch { /* ik 없이도 한 번 시도 */ }
  const ikq = ik ? `ik=${ik}&` : '';
  const candidates = [
    dec && `${ikq}view=pt&search=all&permmsgid=msg-f:${dec}`,
    hex && `${ikq}view=pt&search=all&th=${hex}`,
    hex && `${ikq}view=pt&search=all&msg=${hex}`,
  ].filter(Boolean);

  const tried = [];
  for (const q of candidates) {
    try {
      const res = await fetch(gmailWebUrl(account, q), { credentials: 'include', cache: 'no-store' });
      if (!res.ok) {
        tried.push(`HTTP ${res.status}`);
        continue;
      }
      const html = await res.text();
      const parsed = parsePrintView(html);
      if (parsed.ok) return parsed;
      tried.push(parsed.reason);
    } catch (e) {
      tried.push(e.message);
    }
  }
  delete ikCache[account]; // 키가 바뀌었을 수 있으니 다음엔 다시 가져옴
  throw new Error(`본문을 불러오지 못했습니다${ik ? '' : ' (계정 키 없음)'}: ${tried.join(' / ')}`);
}

// 인쇄 보기 HTML에서 본문 추출 (대화 전체가 오면 가장 최근 메시지)
// 실패하면 { ok: false, reason } — 받은 페이지가 무엇이었는지 알려주기 위함
export function parsePrintView(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const title = (doc.title || '').trim().slice(0, 40) || '제목 없음';
  // 인쇄 보기 페이지는 bodycontainer/maincontent 구조. Gmail 앱 화면이나 로그인 페이지면 여기서 거름
  const container = doc.querySelector('.bodycontainer, .maincontent');
  if (!container) return { ok: false, reason: `인쇄 페이지 아님("${title}", ${html.length}자)` };
  doc.querySelectorAll('script, noscript').forEach((el) => el.remove());

  const messages = [...container.querySelectorAll('table.message')];
  const target = messages.length ? messages[messages.length - 1] : container;
  const candidates = [
    ...target.querySelectorAll('div[style*="overflow"]'),
    target.querySelector(':scope > tbody > tr:last-child > td'),
    target,
  ].filter(Boolean);
  for (const el of candidates) {
    const text = el.textContent.replace(/\s+/g, ' ').trim();
    if (text.length > 0 || el.querySelector('img')) {
      return { ok: true, html: el.innerHTML, text: el.innerText || el.textContent.trim() };
    }
  }
  return { ok: false, reason: `본문 비어 있음("${title}")` };
}
