// ==UserScript==
// @name         QQ空间回复消息读取器
// @namespace    qzonebot.local
// @version      1.0.3
// @description  reply模式下读取与我相关最上方三条消息，只回复新的回复消息。
// @match        *://user.qzone.qq.com/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  const CHANNEL = 'qzonebot:reply:v1:';
  const WAIT_MS = 10_000;
  const account = location.pathname.split('/')[1];
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  function popupAndReload(message) {
    const box = document.createElement('div');
    box.setAttribute('role', 'alert');
    box.style.cssText = 'position:fixed;top:24px;left:50%;transform:translateX(-50%);z-index:2147483647;padding:20px 28px;max-width:80vw;background:#fff;color:#222;border:2px solid #3986ff;border-radius:10px;box-shadow:0 6px 30px #0005;white-space:pre-wrap;font:16px/1.6 sans-serif';
    box.textContent = `${message}\n10 秒后自动刷新。`;
    document.documentElement.appendChild(box);
    setTimeout(() => location.reload(), WAIT_MS);
  }

  const visible = el => el && el.getClientRects().length > 0;
  function normalizeMessageType(raw) {
    // QQ空间把对说说的回应标成“评论”，楼中楼才可能标成“回复”。
    // 只判断通知标题，不能用正文或评论区的“回复”按钮判断。
    const type = raw.replace(/\s+/g, '');
    return /^(?:评论|回复)(?:了)?(?:我的)?(?:说说|评论|日志|照片|相册|留言)?[。！!：:]?$/.test(type) ? '回复' : type;
  }
  function messageStatus(item, seen) {
    if (item.messageType !== '回复') return '非评论/回复通知';
    if (seen.includes(item.messageId)) return '已处理';
    if (!item.commentChain.length) return '等待评论链加载';
    return '新回复';
  }
  function relatedTab() {
    // 左侧导航才负责切换栏目；feed_tab_my 是可能隐藏的页内标题。
    return document.getElementById('tab_menu_me');
  }
  function isRelatedPage() {
    const tab = relatedTab();
    return Boolean(visible(tab) && tab.closest('li[type="me"]')?.classList.contains('current') &&
      visible(document.getElementById('feed_me_list')));
  }
  async function ensureRelatedPage() {
    const deadline = Date.now() + 30_000;
    const maxAttempts = 8;
    let attempts = 0;
    let nextClickAt = 0;
    let confirmedSince = null;
    while (Date.now() < deadline) {
      if (isRelatedPage()) {
        // 导航和列表都要连续保持可见，避免把切换中的短暂状态当作成功。
        confirmedSince ??= Date.now();
        if (Date.now() - confirmedSince >= 900) {
          console.log(`[QQ空间回复读取器] 已确认进入与我相关（点击${attempts}次）。`);
          return;
        }
      } else {
        confirmedSince = null;
        // 每轮重新找入口：页面初始化可能替换节点，首次点击也可能早于事件绑定。
        const tab = relatedTab();
        if (visible(tab) && attempts < maxAttempts && Date.now() >= nextClickAt) {
          attempts++;
          nextClickAt = Date.now() + 3000;
          console.log(`[QQ空间回复读取器] 进入与我相关，第${attempts}/${maxAttempts}次点击。`);
          tab.click();
        }
      }
      await sleep(300);
    }
    throw new Error(`进入与我相关失败：30秒内尝试点击${attempts}次，仍未确认导航选中且相关列表可见；已停止读取。`);
  }
  function readTopFeed() {
    if (!isRelatedPage()) return null;
    const rows = Array.from(document.getElementById('feed_me_list').children)
      .filter(el => el.matches('.f-single[id^="fct_"]') && visible(el)).slice(0, 3);
    if (!rows.length) return null;
    return rows.map(row => {
      const nick = row.querySelector('.f-nick')?.cloneNode(true);
      nick?.querySelectorAll('a').forEach(el => el.remove());
      const rawMessageType = row.querySelector('.f-nick .state')?.textContent.trim() || nick?.textContent.trim() || '';
      const messageType = normalizeMessageType(rawMessageType);
      const text = row.querySelector('.f-single-content .f-item .f-info')?.innerText ?? '';
      const chain = Array.from(row.querySelectorAll('.comments-list > ul > li')).map(el => el.innerText.trim());
      // 只读原动态的配图，避免把头像、表情当成原图。
      const images = Array.from(row.querySelectorAll('.f-item .img-box .img-item img')).map(img => ({
        url: new URL(img.getAttribute('data-src') || img.currentSrc || img.src, location.href).href,
      })).filter(img => /^https?:/.test(img.url));
      return { feedId: row.id, messageId: row.id, rawMessageType, messageType, text, images,
        commentChain: chain, pageUrl: location.href, capturedAt: new Date().toISOString() };
    });
  }

  async function waitForFeed() {
    // 等异步动态列表出现，并给首条正文、图片 DOM 一点渲染时间。
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (readTopFeed()) {
        await sleep(1500);
        const feed = readTopFeed();
        if (feed && feed.every(item => item.rawMessageType &&
          (item.messageType !== '回复' || item.commentChain.length))) return feed;
      }
      await sleep(300);
    }
    throw new Error('30秒内相关消息标题或评论链未加载完成；已停止本轮，不判作没有新回复。');
  }

  async function waitForReceiver() {
    // 握手重试允许两个油猴脚本以任意顺序启动。
    let ready = false;
    const onReady = () => { ready = true; };
    document.addEventListener(`${CHANNEL}ready`, onReady);
    try {
      const deadline = Date.now() + 10_000;
      while (!ready && Date.now() < deadline) {
        document.dispatchEvent(new Event(`${CHANNEL}ping`));
        if (!ready) await sleep(100);
      }
      if (!ready) throw new Error('接收器未启动，请同时安装并启用第二个脚本。');
    } finally {
      document.removeEventListener(`${CHANNEL}ready`, onReady);
    }
  }

  async function main() {
    if (sessionStorage.getItem('qzonebot:mode') !== 'reply') return;
    if (sessionStorage.getItem(`${CHANNEL}pending-comment:${account}`)) {
      console.warn('[QQ空间读取器] 存在未完成评论任务，请先检查评论结果及发送者日志。');
      return;
    }
    console.log('[QQ空间回复读取器] 已启动，正在进入与我相关。');
    await ensureRelatedPage();
    const messages = await waitForFeed();
    const seen = JSON.parse(sessionStorage.getItem(`${CHANNEL}seen:${account}`) || '[]');
    console.table(messages.map(item => ({ messageId: item.messageId, 原始类型: item.rawMessageType,
      识别类型: item.messageType, 评论数: item.commentChain.length, 判断: messageStatus(item, seen) })));
    console.log('[QQ空间回复读取器] 前三条判断：', messages.map(item => `${item.rawMessageType}：${messageStatus(item, seen)}`).join('；'));
    // 在最上方三条消息中选一条新的回复。完成后刷新，再处理剩余的新回复。
    const feed = messages.find(item => item.messageType === '回复' && !seen.includes(item.messageId));
    if (!feed) {
      const hasReplies = messages.some(item => item.messageType === '回复');
      popupAndReload(hasReplies ? '最上方三条中的评论/回复均已处理。' : '最上方三条消息中没有评论/回复通知。');
      return;
    }
    if (!feed.commentChain.length) throw new Error('回复消息的评论链尚未加载，停止本轮。');

    await waitForReceiver();
    // JSON 字符串用于跨油猴脚本传递，避免跨沙箱对象访问问题。
    // 等待Python生成工具调用；正文由发送者在确认评论成功后保存。
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        document.removeEventListener(`${CHANNEL}accepted`, onAccepted);
        document.removeEventListener(`${CHANNEL}failed`, onFailed);
      };
      const onAccepted = () => { cleanup(); resolve(); };
      const onFailed = event => {
        cleanup();
        reject(new Error(typeof event.detail === 'string' ? event.detail : '发送失败。'));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('等待本地Python接收确认超时。'));
      }, 210_000);
      document.addEventListener(`${CHANNEL}accepted`, onAccepted);
      document.addEventListener(`${CHANNEL}failed`, onFailed);
      document.dispatchEvent(new CustomEvent(`${CHANNEL}feed`, {
        detail: JSON.stringify(feed),
      }));
    });
    // 此处不记作成功，发送者负责保存正文并在刷新前核对。
  }

  main().catch(error => {
    console.error('[QQ空间读取器]', error);
    // 失败时保留上次记录并停留页面，修复服务后手动刷新重试。
  });
})();
