import { loadSettings, buildMail, buildComposeUrl, COMPOSE_MODES, sendViaApi, isValidEmail } from './shared.js';

const MENU_ROOT = 'qes-root';
const MENU_OPTIONS = 'qes-options';

// ---------- 컨텍스트 메뉴 ----------
let rebuilding = Promise.resolve();

function rebuildMenus() {
  // 연속 호출 시 중복 ID 오류 방지를 위해 직렬화
  rebuilding = rebuilding.then(async () => {
    await chrome.contextMenus.removeAll();
    const s = await loadSettings();
    if (!s.contextMenu) return;

    const contexts = ['selection', 'link', 'page', 'image'];
    chrome.contextMenus.create({ id: MENU_ROOT, title: '이메일로 보내기', contexts });

    const list = s.recipients.filter((r) => isValidEmail(r.email));
    list.forEach((r, i) => {
      chrome.contextMenus.create({
        id: `qes-to-${i}`,
        parentId: MENU_ROOT,
        title: r.name ? `${r.name} <${r.email}>` : r.email,
        contexts,
      });
    });
    if (list.length > 1) {
      chrome.contextMenus.create({ id: 'qes-to-all', parentId: MENU_ROOT, title: '모두에게', contexts });
    }
    if (list.length) chrome.contextMenus.create({ id: 'qes-sep', parentId: MENU_ROOT, type: 'separator', contexts });
    chrome.contextMenus.create({
      id: MENU_OPTIONS,
      parentId: MENU_ROOT,
      title: list.length ? '설정…' : '수신자 등록하기…',
      contexts,
    });
  }).catch((e) => console.error('menu rebuild failed', e));
  return rebuilding;
}

chrome.runtime.onInstalled.addListener(async (details) => {
  await rebuildMenus();
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(rebuildMenus);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && (changes.recipients || changes.contextMenu)) rebuildMenus();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === MENU_OPTIONS) return chrome.runtime.openOptionsPage();
  const m = /^qes-to-(\d+|all)$/.exec(String(info.menuItemId));
  if (!m) return;

  const s = await loadSettings();
  const list = s.recipients.filter((r) => isValidEmail(r.email));
  const to = m[1] === 'all' ? list.map((r) => r.email) : [list[Number(m[1])]?.email].filter(Boolean);
  if (!to.length) return;

  const ctx = {
    pageTitle: tab?.title || '',
    pageUrl: info.pageUrl || tab?.url || '',
    linkUrl: info.linkUrl || info.srcUrl || '',
    // 선택 텍스트가 없으면 링크/이미지 URL을 본문 텍스트로 사용
    selectedText: info.selectionText || info.linkUrl || info.srcUrl || '',
  };
  const { subject, body } = buildMail(s, ctx);
  await sendEmail({ to, subject, body, tabId: tab?.id }, s);
});

// ---------- 전송 ----------
// to: 이메일 배열, tabId: mailto를 띄울 현재 탭
async function sendEmail({ to, subject, body, tabId }, settings) {
  const s = settings || (await loadSettings());
  to = (Array.isArray(to) ? to : [to]).filter(isValidEmail);
  const who = to.join(', ');
  try {
    if (!to.length) throw new Error('받는 사람을 한 명 이상 선택하세요.');
    if (COMPOSE_MODES.includes(s.sendMode)) {
      await openCompose(buildComposeUrl(s.sendMode, to, subject, body), tabId);
      notify(s, '메일 작성창을 열었습니다', `받는 사람: ${who}`);
    } else {
      await sendViaApi(s, { to, subject, body });
      notify(s, '전송 완료', `${who} 에게 "${subject}" 전송됨`);
    }
    return { ok: true };
  } catch (e) {
    console.error(e);
    notify({ notify: true }, '전송 실패', e.message || String(e)); // 실패는 항상 알림
    return { ok: false, error: e.message || String(e) };
  }
}

async function openCompose(url, tabId) {
  if (!url.startsWith('mailto:')) {
    await chrome.tabs.create({ url }); // Gmail/Outlook 웹 작성창
    return;
  }
  // mailto는 현재 탭에서 열어야 외부 메일 앱이 확실히 실행되고, 빈 탭도 남지 않음
  // (페이지는 이동하지 않음). 탭이 없으면 새 탭으로.
  if (tabId) {
    try {
      await chrome.tabs.update(tabId, { url });
      return;
    } catch { /* 아래로 */ }
  }
  await chrome.tabs.create({ url });
}

function notify(s, title, message) {
  if (!s.notify) return;
  chrome.notifications.create({
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title,
    message: message.slice(0, 250),
  });
}

// popup → background 메시지
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'SEND_EMAIL') {
    sendEmail(msg.payload).then(sendResponse);
    return true; // 비동기 응답
  }
});
