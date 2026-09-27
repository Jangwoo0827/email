import { loadSettings, saveSettings, buildMail, isValidEmail } from './shared.js';

const $ = (id) => document.getElementById(id);
let settings;
let checked = new Set();
let activeTabId;

async function getPageContext() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id;
  const base = { pageTitle: tab?.title || '', pageUrl: tab?.url || '', selectedText: '' };
  if (!tab?.id) return base;
  try {
    // content.js가 주입된 페이지
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'GET_SELECTION' });
    return { ...base, ...res };
  } catch {
    // 설치 전에 열린 탭 등: activeTab 권한으로 직접 실행
    try {
      const [r] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => String(window.getSelection() || '').trim(),
      });
      return { ...base, selectedText: r?.result || '' };
    } catch {
      return base; // chrome:// 등 접근 불가 페이지
    }
  }
}

function renderRecipients(list) {
  const box = $('recipients');
  box.textContent = '';
  list.forEach((r, i) => {
    const row = document.createElement('label');
    row.className = 'check recipient';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = checked.has(i);
    cb.addEventListener('change', () => {
      cb.checked ? checked.add(i) : checked.delete(i);
      onCheckedChange(list);
    });
    const text = document.createElement('span');
    text.innerHTML = '<b></b> <span class="hint"></span>';
    text.querySelector('b').textContent = r.name || r.email;
    text.querySelector('.hint').textContent = r.name ? r.email : '';
    row.append(cb, text);
    box.appendChild(row);
  });
  onCheckedChange(list, false);
}

function onCheckedChange(list, persist = true) {
  const all = $('checkAll');
  all.checked = checked.size === list.length;
  all.indeterminate = checked.size > 0 && checked.size < list.length;
  $('send').disabled = checked.size === 0;
  $('count').textContent = checked.size ? `${checked.size}명 선택` : '받는 사람을 체크하세요';
  if (persist) saveSettings({ checkedRecipients: [...checked] }); // 마지막 선택 기억
}

function setStatus(text, kind = '') {
  $('status').textContent = text;
  $('status').className = 'status ' + kind;
}

async function init() {
  settings = await loadSettings();
  const list = settings.recipients.filter((r) => isValidEmail(r.email));
  const openOpts = () => chrome.runtime.openOptionsPage();
  $('goOptions').addEventListener('click', openOpts);
  $('openOptions').addEventListener('click', openOpts);

  const MODE_LABEL = { gmail: 'Gmail 작성창', outlook: 'Outlook 작성창', mailto: '메일 앱', resend: 'Resend 자동전송', sendgrid: 'SendGrid 자동전송', webhook: 'Webhook 자동전송' };
  $('mode').textContent = MODE_LABEL[settings.sendMode] || settings.sendMode;
  $('send').textContent = ['gmail', 'outlook', 'mailto'].includes(settings.sendMode) ? '작성창 열기' : '바로 전송';

  if (!list.length) {
    $('empty').style.display = 'block';
    $('main').style.display = 'none';
    return;
  }
  checked = new Set((settings.checkedRecipients || [0]).filter((i) => i < list.length));
  if (!checked.size) checked.add(0);
  renderRecipients(list);
  $('checkAll').addEventListener('change', (e) => {
    checked = new Set(e.target.checked ? list.map((_, i) => i) : []);
    renderRecipients(list);
    saveSettings({ checkedRecipients: [...checked] });
  });

  const ctx = await getPageContext();
  const { subject, body } = buildMail(settings, ctx);
  $('subject').value = subject;
  $('body').value = body;

  $('send').addEventListener('click', async () => {
    $('send').disabled = true;
    setStatus('전송 중…');
    const res = await chrome.runtime.sendMessage({
      type: 'SEND_EMAIL',
      payload: {
        to: [...checked].sort().map((i) => list[i].email),
        subject: $('subject').value,
        body: $('body').value,
        tabId: activeTabId,
      },
    });
    if (res?.ok) {
      setStatus('완료', 'ok');
      setTimeout(() => window.close(), 600);
    } else {
      setStatus(res?.error || '실패', 'err');
      $('send').disabled = checked.size === 0;
    }
  });

  // Ctrl/Cmd+Enter로 전송
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('send').click();
  });
}

init();
