// 페이지의 선택 텍스트를 popup/background에 제공
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'GET_SELECTION') {
    sendResponse({
      selectedText: String(window.getSelection() || '').trim(),
      pageTitle: document.title,
      pageUrl: location.href,
    });
  }
});
