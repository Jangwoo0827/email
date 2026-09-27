// 전체 메일 목록 (읽은 메일 포함, OAuth 없이)
// Atom 피드는 안 읽은 메일만 주므로, Gmail을 백그라운드 탭으로 잠깐 열어 목록을 읽어온 뒤 닫음
// (새 창을 열면 포커스가 옮겨가 확장 팝업이 닫히므로 반드시 현재 창의 비활성 탭 사용)
// Gmail 화면 구조가 바뀌면 실패할 수 있음

import { gmailWebUrl } from './shared.js';

// folder: 'inbox' | 'all' | 'sent' | 'starred', page: 1부터
export async function listAllMail(account, { folder = 'inbox', page = 1 } = {}) {
  const hash = `#${folder}${page > 1 ? `/p${page}` : ''}`;
  const tab = await chrome.tabs.create({ url: gmailWebUrl(account, '', hash), active: false });
  const tabId = tab.id;
  try {
    await waitForLoad(tabId);
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: scrapeMailList });
    const r = res?.result;
    if (!r) throw new Error('Gmail 목록을 읽지 못했습니다.');
    if (r.error) throw new Error(r.error);
    return r;
  } finally {
    chrome.tabs.remove(tabId).catch(() => {});
  }
}

function waitForLoad(tabId) {
  return new Promise((resolve) => {
    const done = () => {
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') done();
    };
    const timer = setTimeout(done, 20000);
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// ---- 아래 함수는 Gmail 페이지 안에서 실행됨 (외부 변수 사용 불가) ----
async function scrapeMailList() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const end = Date.now() + 15000;
  let rows = [];
  while (Date.now() < end) {
    // 현재 보이는 목록(메인 영역)의 행만: 숨겨진 이전 화면의 행은 제외
    rows = [...document.querySelectorAll('div[role="main"] tr.zA')];
    if (rows.length) break;
    if (document.querySelector('div[role="main"] td.TC')) return { mails: [], hasMore: false };
    if (/accounts\.google\.com/.test(location.host)) return { error: 'Gmail에 로그인되어 있지 않습니다.' };
    await sleep(300);
  }
  if (!rows.length) return { error: 'Gmail 메일 목록을 찾지 못했습니다.' };
  await sleep(300);

  const mails = rows.map((tr) => {
    const threadEl = tr.querySelector('[data-legacy-thread-id]');
    const msgEl = tr.querySelector('[data-legacy-last-message-id]');
    const senderEl = tr.querySelector('.yW [email], .zF, .yP');
    const dateEl = tr.querySelector('td.xW span[title], td.xW [title]');
    return {
      hex: msgEl?.getAttribute('data-legacy-last-message-id') || threadEl?.getAttribute('data-legacy-thread-id') || '',
      threadHex: threadEl?.getAttribute('data-legacy-thread-id') || '',
      from: senderEl?.getAttribute('name') || senderEl?.textContent.trim() || '',
      fromEmail: senderEl?.getAttribute('email') || '',
      subject: tr.querySelector('.bog')?.textContent.trim() || '(제목 없음)',
      snippet: (tr.querySelector('.y2')?.textContent || '').replace(/^\s*[-–]\s*/, '').trim(),
      date: tr.querySelector('td.xW')?.textContent.trim() || '',
      dateFull: dateEl?.getAttribute('title') || '',
      unread: tr.classList.contains('zE'),
    };
  });

  // "다음 페이지" 버튼이 활성화되어 있으면 더 있음
  const next = document.querySelector('div[role="button"][data-tooltip*="다음"], div[role="button"][data-tooltip*="Older"], div[role="button"][aria-label*="다음"], div[role="button"][aria-label*="Older"]');
  const hasMore = !!next && next.getAttribute('aria-disabled') !== 'true';
  return { mails, hasMore };
}
