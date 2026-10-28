// ==UserScript==
// @name         QQ空间评论发送者
// @namespace    qzonebot.local
// @version      1.4.0
// @description  执行Python返回的write_comment工具调用，评论成功后保存正文并等待10秒刷新。
// @match        *://user.qzone.qq.com/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  const CHANNEL = 'qzonebot:v1:';
  const account = location.pathname.split('/')[1];
  const LAST_TEXT_KEY = `${CHANNEL}last-text:${account}`;
  const PENDING_KEY = `${CHANNEL}pending-comment:${account}`;
  const RESULT_URL = 'http://127.0.0.1:8765/comment-result';
  const EDITOR_OPEN = { attempts: 5, hoverMs: 600, pressMs: 120, waitMs: 2000 };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const visible = el => el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const normalize = text => text.replace(/\s+/g, ' ').trim();
  let busy = false;

  async function waitFor(find, message, timeout = 10_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const result = find();
      if (result) return result;
      await sleep(200);
    }
    throw new Error(message);
  }

  function getTarget(command) {
    if (new URL(command.pageUrl).pathname !== location.pathname) {
      throw new Error('任务来自其他QQ空间页面，已停止。');
    }
    const root = document.getElementById(command.feedId);
    const text = root?.querySelector('.f-single-content .f-item .f-info')?.innerText ?? '';
    if (!root || !root.matches('#feed_friend_list > .f-single') || text !== command.text) {
      throw new Error('目标动态已变化或不在当前页面，已停止。');
    }
    return root;
  }

  function report(command, success, error = '') {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST', url: RESULT_URL,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ commandId: command.commandId, success, error }),
        timeout: 8000,
        onload(response) {
          if (response.status === 200) resolve();
          else reject(new Error(`回传执行结果失败：HTTP ${response.status}`));
        },
        onerror: () => reject(new Error('无法回传评论结果。')),
        ontimeout: () => reject(new Error('回传评论结果超时。')),
      });
    });
  }

  function commentBody(row) {
    const content = row.querySelector('.comments-content')?.cloneNode(true);
    if (!content) return '';
    // 只用来确认自己刚发出的评论，不影响动态正文读取或判重。
    // 新评论作者链接使用q_namecard；只移除开头的作者，保留正文中的@提及。
    const author = content.firstElementChild;
    if (author?.matches('.nickname, a.q_namecard')) author.remove();
    content.querySelectorAll('.comments-op, .comments-thumbnails, .fail').forEach(el => el.remove());
    return normalize(content.textContent.replace(/^\s*[:：]\s*/, ''));
  }

  async function openCommentEditor(root) {
    // 占位框也是contenteditable，但真正的编辑器只在comment-box-wrap内。
    const findEditor = () => Array.from(root.querySelectorAll(
      '.comment-box-wrap [contenteditable="true"][id$="_content_content"]'
    )).find(visible);
    let editor = findEditor();
    if (editor) return editor;
    const waitForEditor = async ms => {
      const deadline = Date.now() + ms;
      do {
        const found = findEditor();
        if (found) return found;
        await sleep(Math.min(100, Math.max(0, deadline - Date.now())));
      } while (Date.now() < deadline);
      return findEditor();
    };
    for (let attempt = 1; attempt <= EDITOR_OPEN.attempts; attempt++) {
      editor = findEditor();
      if (editor) return editor;
      // 每轮重新查询，QQ空间初始化时可能替换占位框。
      const entry = Array.from(root.querySelectorAll('.comment_default_inputentry .textinput')).find(visible);
      if (!entry) {
        // 占位框已消失时只等待组件加载，避免误点其他动态。
        editor = await waitForEditor(EDITOR_OPEN.waitMs);
        if (editor) return editor;
        if (attempt === 1) throw new Error('找不到该动态的评论入口。');
        continue;
      }
      const candidates = [entry, entry.querySelector('a'), entry.closest('.comment_default_inputentry')]
        .filter(el => el && root.contains(el) && visible(el));
      const target = candidates[(attempt - 1) % candidates.length];
      const usable = () => root.contains(target) && visible(target);
      const mouse = (type, buttons = 0) => {
        const rect = target.getBoundingClientRect();
        // 不传view：油猴沙箱window可能是代理对象，无法转换为原生Window。
        target.dispatchEvent(new MouseEvent(type, {
          bubbles: type !== 'mouseenter', cancelable: true,
          clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
          button: 0, buttons, detail: type === 'click' ? 1 : 0,
        }));
      };
      console.log(`[QQ空间发送者] 打开评论编辑器，第${attempt}/${EDITOR_OPEN.attempts}次尝试。`);
      entry.scrollIntoView({ block: 'center' });
      mouse('mouseover');
      if (!findEditor() && usable()) mouse('mouseenter');
      if (!findEditor() && usable()) mouse('mousemove');
      editor = await waitForEditor(EDITOR_OPEN.hoverMs);
      if (editor) return editor;
      if (usable()) mouse('mousedown', 1);
      if (!findEditor() && root.contains(entry) && visible(entry)) entry.focus();
      await sleep(EDITOR_OPEN.pressMs);
      // 配对释放已按下的鼠标；组件已打开时不再发click。
      if (usable()) mouse('mouseup');
      editor = findEditor();
      if (editor) return editor;
      if (usable()) mouse('click');
      editor = await waitForEditor(EDITOR_OPEN.waitMs);
      if (editor) return editor;
    }
    throw new Error(`评论编辑器未出现：已尝试${EDITOR_OPEN.attempts}次鼠标移入、停留及点击。请检查评论权限、组件加载，或网站是否要求真实鼠标操作。`);
  }

  async function send(command) {
    let submitted = false;
    try {
      if (command.type !== 'write_comment' || typeof command.commandId !== 'string' ||
          typeof command.text !== 'string' || typeof command.comment !== 'string' ||
          !command.comment.trim() || command.comment.length > 500 || typeof command.feedId !== 'string') {
        throw new Error('评论任务格式无效。');
      }
      if (sessionStorage.getItem(PENDING_KEY)) throw new Error('存在未完成任务，不自动重复发送。');
      const root = getTarget(command);
      // 先验证会话存储可写，保证发送后能够保存本次正文。
      sessionStorage.setItem(PENDING_KEY, JSON.stringify({ ...command, phase: 'preparing' }));

      const editor = await openCommentEditor(root);
      if (editor.innerText.trim()) throw new Error('评论框已有草稿，保留草稿并停止。');
      editor.focus();
      // 用浏览器编辑命令触发站点自己的编辑器逻辑；失败时使用文本节点回退。
      if (!document.execCommand('insertText', false, command.comment)) {
        editor.textContent = command.comment;
      }
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: command.comment }));
      editor.dispatchEvent(new Event('change', { bubbles: true }));
      editor.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: ' ' }));
      await sleep(400);
      if (normalize(editor.innerText) !== normalize(command.comment)) throw new Error('评论框内容未正确写入。');
      getTarget(command);
      const button = await waitFor(() =>
        Array.from(root.querySelectorAll('.comment-box-wrap .btn-post')).find(el =>
          visible(el) && !el.classList.contains('disabled') && !el.classList.contains('gb_bt_disable') &&
          el.getAttribute('aria-disabled') !== 'true'), '找不到可用的发表按钮。');
      const before = new Set(Array.from(root.querySelectorAll('[data-type="commentroot"]')));
      const beforeIds = new Set(Array.from(before, row => `${row.getAttribute('data-uin')}:${row.getAttribute('data-tid')}`));
      sessionStorage.setItem(PENDING_KEY, JSON.stringify({ ...command, phase: 'submitted' }));
      submitted = true;
      button.click();

      // 确认目标动态里出现当前账号发布的新评论，点击按钮本身不算成功。
      await waitFor(() => Array.from(root.querySelectorAll('[data-type="commentroot"]')).find(row =>
        !before.has(row) && row.getAttribute('data-uin') === account &&
        row.getAttribute('data-tid') &&
        !beforeIds.has(`${row.getAttribute('data-uin')}:${row.getAttribute('data-tid')}`) &&
        commentBody(row) === normalize(command.comment)
      ), '未确认评论成功。请检查是否发送成功、触发验证码或被限制；不会自动重发。', 20_000);

      sessionStorage.setItem(LAST_TEXT_KEY, command.text);
      if (sessionStorage.getItem(LAST_TEXT_KEY) !== command.text) throw new Error('正文临时保存失败，停止刷新。');
      sessionStorage.removeItem(PENDING_KEY);
      console.log('[QQ空间发送者] 评论成功，正文已临时保存，10秒后刷新。');
      setTimeout(() => {
        if (sessionStorage.getItem(LAST_TEXT_KEY) === command.text) location.reload();
        else console.error('[QQ空间发送者] 正文保存记录变化，取消刷新。');
      }, 10_000);
      report(command, true).catch(error => console.error('[QQ空间发送者]', error));
    } catch (error) {
      // 点击发表后的结果不明时保留pending，防止刷新导致重复评论。
      if (!submitted) {
        try {
          const pending = JSON.parse(sessionStorage.getItem(PENDING_KEY) || 'null');
          if (pending?.commandId === command.commandId && pending.phase === 'preparing') {
            sessionStorage.removeItem(PENDING_KEY);
          }
        } catch (storageError) { console.error('[QQ空间发送者] 无法读取临时状态：', storageError); }
      }
      console.error('[QQ空间发送者] 已停止：', error);
      if (command.commandId) report(command, false, error.message).catch(console.error);
    }
  }

  document.addEventListener(`${CHANNEL}sender-ping`, () => {
    if (sessionStorage.getItem('qzonebot:mode') === 'reply') return;
    document.dispatchEvent(new Event(`${CHANNEL}sender-ready`));
  });
  document.addEventListener(`${CHANNEL}comment`, event => {
    if (sessionStorage.getItem('qzonebot:mode') === 'reply') return;
    if (busy || typeof event.detail !== 'string') return;
    try {
      const command = JSON.parse(event.detail);
      if (!command || typeof command !== 'object') throw new Error('任务必须为对象。');
      busy = true;
      send(command);
    } catch (error) {
      console.error('[QQ空间发送者] 任务解析失败：', error);
    }
  });
})();
