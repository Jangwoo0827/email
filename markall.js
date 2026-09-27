// 전체 읽음 (OAuth 없이): Gmail에서 "안 읽은 받은편지함" 검색을 열고
// 전체 선택 → 일치하는 대화 모두 선택 → 읽음으로 표시 를 대신 클릭
// Gmail 화면 구조가 바뀌면 자동 클릭은 실패할 수 있음 → 탭은 그대로 두어 사용자가 직접 처리

import { gmailWebUrl } from './shared.js';

const SEARCH = '#search/in%3Ainbox+is%3Aunread';

export async function markAllReadViaGmail(account) {
  const tab = await chrome.tabs.create({ url: gmailWebUrl(account, '', SEARCH), active: true });
  await waitForLoad(tab.id);
  const [res] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: autoMarkAllRead,
  });
  return res?.result || { ok: false, step: '스크립트 실행 실패' };
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
async function autoMarkAllRead() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const visible = (el) => !!el && el.offsetParent !== null;
  const waitFor = async (find, timeout = 15000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const el = find();
      if (el) return el;
      await sleep(250);
    }
    return null;
  };
  // Gmail 버튼은 click만으로는 반응하지 않는 경우가 많아 마우스 이벤트를 순서대로 보냄
  const press = (el) => {
    for (const type of ['mouseover', 'mousedown', 'mouseup', 'click']) {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
  };

  // 검색 결과가 비어 있으면 할 일 없음
  const list = await waitFor(() => {
    const rows = [...document.querySelectorAll('tr.zA')].filter(visible);
    if (rows.length) return rows;
    const empty = [...document.querySelectorAll('td.TC, div.TC')].find(visible);
    return empty ? 'empty' : null;
  });
  if (list === 'empty') return { ok: true, step: '안 읽은 메일 없음', count: 0 };
  if (!list) return { ok: false, step: '메일 목록을 찾지 못함' };
  await sleep(500);

  // 1) 전체 선택 체크박스
  const selectAll = await waitFor(() =>
    [...document.querySelectorAll('div[gh="tm"] div[role="checkbox"], div[gh="tm"] span[role="checkbox"]')].find(visible),
  );
  if (!selectAll) return { ok: false, step: '전체 선택 체크박스를 찾지 못함' };
  if (selectAll.getAttribute('aria-checked') !== 'true') press(selectAll);
  await sleep(600);

  // 2) "검색결과와 일치하는 대화 모두 선택" (메일이 한 페이지보다 많을 때만 나타남)
  const matchAll = [...document.querySelectorAll('span[role="link"], a[role="link"], .ya span')].find(
    (el) => visible(el) && /모든 대화|대화 모두|all\s+[\d,]+\s+conversations|conversations that match/i.test(el.textContent),
  );
  if (matchAll) {
    press(matchAll);
    await sleep(600);
  }

  // 3) 읽음으로 표시 (툴바 act="1")
  const markRead = await waitFor(() => [...document.querySelectorAll('div[gh="tm"] [act="1"]')].find(visible), 5000);
  if (!markRead) return { ok: false, step: '"읽음으로 표시" 버튼을 찾지 못함' };
  press(markRead);

  // 4) 대량 작업 확인창이 뜨면 확인
  const ok = await waitFor(
    () => [...document.querySelectorAll('div[role="alertdialog"] button[name="ok"], div[role="alertdialog"] button')].find(visible),
    3000,
  );
  if (ok) press(ok);
  return { ok: true, step: matchAll ? '일치하는 대화 모두 읽음 처리' : '현재 페이지 메일 읽음 처리' };
}
