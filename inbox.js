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
  return `https://mail.google.com/mail/u/${u(account)}/#inbox`;
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
