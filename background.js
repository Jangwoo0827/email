import { fetchAllAccounts, inboxUrl, accountsDiag } from './inbox.js';
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
  await scheduleInbox();
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(() => {
  rebuildMenus();
  scheduleInbox();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  if (changes.recipients || changes.contextMenu) rebuildMenus();
  if (changes.inboxCheck || changes.inboxInterval || changes.extraAccounts) scheduleInbox();
});

// ---------- 받은편지함 확인 ----------
const INBOX_ALARM = 'qes-inbox';

async function scheduleInbox() {
  const s = await loadSettings();
  await chrome.alarms.clear(INBOX_ALARM);
  if (!s.inboxCheck) {
    await chrome.action.setBadgeText({ text: '' });
    await chrome.storage.local.remove(['accounts', 'inboxError']);
    return;
  }
  const minutes = Math.max(1, Number(s.inboxInterval) || 5);
  chrome.alarms.create(INBOX_ALARM, { periodInMinutes: minutes });
  checkInbox();
}

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === INBOX_ALARM) checkInbox();
});

// 로그인된 모든 Gmail 계정 확인 → storage.local.accounts
async function checkInbox() {
  const s = await loadSettings();
  if (!s.inboxCheck) return { ok: false, error: '받은편지함 확인이 꺼져 있습니다.' };
  const { accounts: prev, seenIds = [] } = await chrome.storage.local.get(['accounts', 'seenIds']);
  try {
    const accounts = await fetchAllAccounts(s.extraAccounts);
    const seen = new Set(seenIds);
    for (const a of accounts) {
      const fresh = a.entries.filter((e) => !seen.has(e.id));
      // 처음 발견된 계정은 기존 안 읽은 메일로 알림 폭탄을 보내지 않음
      const known = prev?.some((p) => p.email === a.email);
      if (known && s.inboxNotify && fresh.length) notifyNewMail(fresh, a);
    }
    const allIds = accounts.flatMap((a) => a.entries.map((e) => e.id));
    await chrome.storage.local.set({
      accounts,
      inboxError: null,
      accountsDiag,
      seenIds: [...new Set([...seenIds, ...allIds])].slice(-500),
    });
    const total = accounts.reduce((n, a) => n + a.count, 0);
    await chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
    await chrome.action.setBadgeText({ text: total ? String(total > 999 ? '999+' : total) : '' });
    return { ok: true };
  } catch (e) {
    await chrome.storage.local.set({ inboxError: e.message });
    await chrome.action.setBadgeBackgroundColor({ color: '#6b7280' });
    await chrome.action.setBadgeText({ text: '?' });
    return { ok: false, error: e.message };
  }
}

function notifyNewMail(fresh, account) {
  const id = `qes-mail-${Date.now()}-${account.index}`;
  const one = fresh.length === 1;
  const opts = {
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: one ? `새 메일: ${fresh[0].from}` : `새 메일 ${fresh.length}통`,
    contextMessage: account.email,
    message: one ? `${fresh[0].title}\n${fresh[0].summary}`.slice(0, 250) : '',
    priority: 1,
  };
  if (one) {
    chrome.notifications.create(id, { type: 'basic', ...opts });
  } else {
    chrome.notifications.create(id, {
      type: 'list',
      ...opts,
      items: fresh.slice(0, 5).map((e) => ({ title: e.from, message: e.title })),
    });
  }
  mailLinks.set(id, one ? fresh[0].link : inboxUrl(account.index));
}

const mailLinks = new Map();
chrome.notifications.onClicked.addListener((id) => {
  if (!id.startsWith('qes-mail-')) return;
  chrome.tabs.create({ url: mailLinks.get(id) || inboxUrl(0) });
  chrome.notifications.clear(id);
  mailLinks.delete(id);
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
async function sendEmail({ to, subject, body, tabId, account }, settings) {
  const s = settings || (await loadSettings());
  to = (Array.isArray(to) ? to : [to]).filter(isValidEmail);
  const who = to.join(', ');
  try {
    if (!to.length) throw new Error('받는 사람을 한 명 이상 선택하세요.');
    if (COMPOSE_MODES.includes(s.sendMode)) {
      await openCompose(buildComposeUrl(s.sendMode, to, subject, body, account ?? s.gmailAccount), tabId);
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
  if (msg?.type === 'CHECK_INBOX') {
    checkInbox().then(sendResponse);
    return true;
  }
  if (msg?.type === 'SEND_EMAIL') {
    sendEmail(msg.payload).then(sendResponse);
    return true; // 비동기 응답
  }
});
