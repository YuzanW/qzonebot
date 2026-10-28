// ==UserScript==
// @name         QQ空间回复消息发送者
// @namespace    qzonebot.local
// @version      1.1.1
// @description  reply模式下执行回复任务，点击发表后保存消息ID并等待3秒刷新。
// @match        *://user.qzone.qq.com/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  const CHANNEL = 'qzonebot:reply:v1:';
  const account = location.pathname.split('/')[1];
  const PENDING_KEY = `${CHANNEL}pending-comment:${account}`;
  const RESULT_URL = 'http://127.0.0.1:8766/reply-result';
  const EDITOR_OPEN = { attempts: 5, hoverMs: 600, pressMs: 120, waitMs: 2000 };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const visible = el => el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const normalize = text => text.replace(/\s+/g, ' ').trim();
  let busy = false;
  const handled = new Set();
  const MAX_REGENERATIONS = 2;

  class ContextChanged extends Error {}
  const sameChain = (a, b) => JSON.stringify(a.map(normalize)) === JSON.stringify(b.map(normalize));
  const readChain = root => Array.from(root.querySelectorAll('.comments-list > ul > li'))
    .map(el => el.innerText.trim());

  function validateCommand(command) {
    if (command.type !== 'write_reply' || typeof command.commandId !== 'string' || !command.commandId ||
        typeof command.text !== 'string' || typeof command.comment !== 'string' ||
        !command.comment.trim() || command.comment.length > 500 ||
        typeof command.feedId !== 'string' || !command.feedId.startsWith('fct_') ||
        command.messageId !== command.feedId || !Array.isArray(command.commentChain) ||
        !command.commentChain.length || !command.commentChain.every(item => typeof item === 'string')) {
      throw new Error('评论任务格式无效。');
    }
  }

  async function freshFeed(command) {
    // 连续800ms不变才取快照；持续变化时停止，不能无限生成。
    const deadline = Date.now() + 5000;
    let previous = null, stableSince = Date.now();
    while (Date.now() < deadline) {
      const root = getTarget(command, false);
      const chain = readChain(root);
      const images = Array.from(root.querySelectorAll('.f-item .img-box .img-item img')).map(img => ({
        url: new URL(img.getAttribute('data-src') || img.currentSrc || img.src, location.href).href,
      })).filter(img => /^https?:/.test(img.url));
      const snapshot = JSON.stringify({ chain: chain.map(normalize), images });
      if (snapshot !== previous) { previous = snapshot; stableSince = Date.now(); }
      if (chain.length && Date.now() - stableSince >= 800) {
        return { feedId: command.feedId, messageId: command.messageId, messageType: '回复',
          text: command.text, images, commentChain: chain, pageUrl: location.href,
          capturedAt: new Date().toISOString() };
      }
      await sleep(200);
    }
    throw new Error('评论链持续变化或尚未加载，请稍后刷新重试。');
  }

  async function regenerate(command) {
    const feed = await freshFeed(command);
    const next = await new Promise((resolve, reject) => GM_xmlhttpRequest({
      method: 'POST', url: 'http://127.0.0.1:8766/reply',
      headers: { 'Content-Type': 'application/json' }, data: JSON.stringify(feed), timeout: 200_000,
      onload(response) {
        try {
          const result = JSON.parse(response.responseText);
          if (response.status !== 200 || result.ok !== true) throw new Error(result.error || '重新生成回复失败。');
          validateCommand(result.command);
          resolve(result.command);
        } catch (error) { reject(error); }
      },
      onerror: () => reject(new Error('重新生成时无法连接本地回复服务。')),
      ontimeout: () => reject(new Error('重新生成回复超时。')),
      onabort: () => reject(new Error('重新生成回复已取消。')),
    }));
    if (next.feedId !== feed.feedId || next.messageId !== feed.messageId || next.text !== feed.text ||
        next.pageUrl !== feed.pageUrl || !sameChain(next.commentChain, feed.commentChain) ||
        next.commandId === command.commandId) throw new Error('重新生成的任务与请求目标不一致。');
    return next;
  }

  async function waitFor(find, message, timeout = 10_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const result = find();
      if (result) return result;
      await sleep(200);
    }
    throw new Error(message);
  }

  function getTarget(command, checkChain = true) {
    if (sessionStorage.getItem('qzonebot:mode') !== 'reply' ||
        new URL(command.pageUrl).origin !== location.origin || new URL(command.pageUrl).pathname !== location.pathname) {
      throw new Error('任务来自其他QQ空间页面，已停止。');
    }
    const tab = document.getElementById('tab_menu_me');
    if (!visible(tab) || !tab.closest('li[type="me"]')?.classList.contains('current') ||
        !visible(document.getElementById('feed_me_list'))) {
      throw new Error('当前不是与我相关栏目，已停止。');
    }
    const root = document.getElementById(command.feedId);
    const text = root?.querySelector('.f-single-content .f-item .f-info')?.innerText ?? '';
    if (!root || !visible(root) || !root.matches('#feed_me_list > .f-single') || text !== command.text) {
      throw new Error('目标动态已变化或不在当前页面，已停止。');
    }
    if (checkChain && !sameChain(readChain(root), command.commentChain)) {
      throw new ContextChanged('评论链已变化，旧回复已取消。');
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

  async function send(command, regeneration = 0) {
    let submitted = false;
    let confirmed = false;
    let editor, originalHTML, writtenText;
    try {
      validateCommand(command);
      if (handled.has(command.commandId)) return;
      handled.add(command.commandId);
      const alreadySeen = JSON.parse(sessionStorage.getItem(`${CHANNEL}seen:${account}`) || '[]');
      if (alreadySeen.includes(command.messageId)) return;
      if (sessionStorage.getItem(PENDING_KEY)) throw new Error('存在未完成任务，不自动重复发送。');
      const root = getTarget(command);
      // 先验证会话存储可写，保证发送后能够保存本次正文。
      sessionStorage.setItem(PENDING_KEY, JSON.stringify({ ...command, phase: 'preparing' }));

      editor = await openCommentEditor(root);
      if (getTarget(command) !== root || !root.contains(editor)) throw new Error('编辑器所属动态已被替换。');
      originalHTML = editor.innerHTML;
      // 保留QQ空间自动插入的回复对象标记及现有内容，在末尾添加生成文本。
      const expectedEditorText = normalize(editor.innerText + command.comment);
      writtenText = expectedEditorText;
      editor.focus();
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      const selection = editor.ownerDocument.defaultView.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      // 用浏览器编辑命令触发站点自己的编辑器逻辑；失败时使用文本节点回退。
      if (!document.execCommand('insertText', false, command.comment)) {
        editor.appendChild(document.createTextNode(command.comment));
      }
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: command.comment }));
      editor.dispatchEvent(new Event('change', { bubbles: true }));
      editor.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: ' ' }));
      await sleep(400);
      if (normalize(editor.innerText) !== expectedEditorText) throw new Error('评论框内容未正确写入。');
      getTarget(command);
      const button = await waitFor(() =>
        Array.from(root.querySelectorAll('.comment-box-wrap .btn-post')).find(el =>
          visible(el) && !el.classList.contains('disabled') && !el.classList.contains('gb_bt_disable') &&
          el.getAttribute('aria-disabled') !== 'true'), '找不到可用的发表按钮。');
      // waitFor期间仍可能更新DOM；最后一次校验与click之间不再await。
      if (getTarget(command) !== root || !root.contains(editor) || !root.contains(button) ||
          normalize(editor.innerText) !== expectedEditorText) throw new Error('发表前目标或编辑内容已变化。');
      sessionStorage.setItem(PENDING_KEY, JSON.stringify({ ...command, phase: 'submitted' }));
      submitted = true;
      button.click();

      // 按发送尝试推进下一轮，不等待页面回显或确认实际送达。
      confirmed = true;
      sessionStorage.setItem(PENDING_KEY, JSON.stringify({ ...command, phase: 'clicked' }));
      const seenKey = `${CHANNEL}seen:${account}`;
      const seen = JSON.parse(sessionStorage.getItem(seenKey) || '[]');
      const saved = JSON.stringify([...new Set([...seen, command.messageId])]);
      sessionStorage.setItem(seenKey, saved);
      if (sessionStorage.getItem(seenKey) !== saved) throw new Error('回复记录保存失败，停止刷新。');
      sessionStorage.removeItem(PENDING_KEY);
      console.log('[QQ空间回复发送者] 已点击发表，3秒后刷新（未确认送达）。');
      setTimeout(() => {
        if (sessionStorage.getItem(seenKey) === saved) location.reload();
      }, 3000);
      report(command, true, '已点击发表，未确认实际送达。').catch(error => console.error('[QQ空间发送者]', error));
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
      // 仅撤销仍与本次写入完全一致的草稿，避免覆盖用户中途编辑。
      let clean = true;
      if (!submitted && editor && originalHTML !== undefined) {
        clean = normalize(editor.innerText) === writtenText;
        if (clean) {
          editor.innerHTML = originalHTML;
          editor.dispatchEvent(new Event('input', { bubbles: true }));
          editor.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
      if (command.commandId) await report(command, confirmed,
        confirmed ? `已点击发表，但本地收尾失败：${error.message}` :
          submitted ? `发送结果不确定，禁止自动重发：${error.message}` : error.message).catch(console.error);
      if (!submitted && clean && error instanceof ContextChanged && regeneration < MAX_REGENERATIONS) {
        console.warn(`[QQ空间回复发送者] 评论链变化，按最新内容重新生成（${regeneration + 1}/${MAX_REGENERATIONS}）。`);
        try {
          const next = await regenerate(command);
          return await send(next, regeneration + 1);
        } catch (retryError) { console.error('[QQ空间回复发送者] 重新生成失败，已停止：', retryError); }
      } else {
        console.error('[QQ空间回复发送者] 已停止：', error,
          !clean ? '草稿已被修改，请人工检查。' : '');
      }
    }
  }

  document.addEventListener(`${CHANNEL}sender-ping`, () => {
    if (sessionStorage.getItem('qzonebot:mode') !== 'reply') return;
    document.dispatchEvent(new Event(`${CHANNEL}sender-ready`));
  });
  document.addEventListener(`${CHANNEL}comment`, event => {
    if (sessionStorage.getItem('qzonebot:mode') !== 'reply') return;
    if (busy || typeof event.detail !== 'string') return;
    try {
      const command = JSON.parse(event.detail);
      if (!command || typeof command !== 'object') throw new Error('任务必须为对象。');
      busy = true;
      send(command).catch(console.error).finally(() => { busy = false; });
    } catch (error) {
      console.error('[QQ空间发送者] 任务解析失败：', error);
    }
  });
})();
