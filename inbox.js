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

// Chrome에 로그인된 Gmail 계정을 u/0, u/1 … 순서로 모두 확인
// (없는 번호는 Gmail이 u/0으로 돌려보내므로 이메일이 중복되면 중단)
export async function fetchAllAccounts(max = 5) {
  const accounts = [];
  for (let i = 0; i < max; i++) {
    let inbox;
    try {
      inbox = await fetchInbox(i);
    } catch (e) {
      if (i === 0) throw e;
      break;
    }
    if (accounts.some((a) => a.email === inbox.account)) break;
    accounts.push({ index: i, email: inbox.account, ...inbox });
  }
  return accounts;
}
