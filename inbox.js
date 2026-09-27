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
  return `https://mail.google.com/mail/u/${account}/#inbox`;
}

export async function fetchInbox(account = 0) {
  const res = await fetch(`https://mail.google.com/mail/u/${account}/feed/atom`, {
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

// Chrome(브라우저)에 로그인된 Google 계정 목록 — Google 계정 전환 메뉴와 같은 순서(= /mail/u/N 순번)
async function listGoogleAccounts() {
  try {
    const res = await fetch('https://accounts.google.com/ListAccounts?gpsia=1&source=ChromiumBrowser&json=standard', {
      credentials: 'include',
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const data = JSON.parse(await res.text());
    const rows = Array.isArray(data?.[1]) ? data[1] : [];
    const list = rows
      .map((r) => ({
        email: r.find((v) => typeof v === 'string' && /^[^\s@]+@[^\s@]+$/.test(v)),
        name: typeof r[2] === 'string' ? r[2] : '',
        photo: typeof r[4] === 'string' && r[4].startsWith('http') ? r[4] : '',
      }))
      .filter((a) => a.email);
    return list.length ? list : null;
  } catch {
    return null;
  }
}

// 로그인된 모든 계정의 받은편지함 확인. 한 계정이 실패해도 목록에서 빠지지 않고 error로 표시
export async function fetchAllAccounts(max = 10) {
  const known = await listGoogleAccounts();
  if (known) {
    return Promise.all(
      known.slice(0, max).map(async (acc, index) => {
        try {
          const inbox = await fetchInbox(index);
          return { index, ...acc, ...inbox, email: acc.email, error: null };
        } catch (e) {
          return { index, ...acc, count: 0, entries: [], checkedAt: Date.now(), error: e.message };
        }
      }),
    );
  }

  // 계정 목록을 못 가져오면 u/0, u/1 … 을 차례로 시도
  // (없는 번호는 Gmail이 u/0으로 돌려보내므로 이메일이 중복되면 건너뜀)
  const accounts = [];
  let failures = 0;
  for (let i = 0; i < 6 && failures < 2; i++) {
    try {
      const inbox = await fetchInbox(i);
      if (accounts.some((a) => a.email === inbox.account)) continue;
      accounts.push({ index: i, email: inbox.account, ...inbox, error: null });
    } catch (e) {
      failures++;
    }
  }
  if (!accounts.length) throw new Error('Gmail에 로그인되어 있지 않습니다.');
  return accounts;
}
