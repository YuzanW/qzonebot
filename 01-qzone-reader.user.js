// ==UserScript==
// @name         QQ空间首条动态读取器
// @namespace    qzonebot.local
// @version      1.4.1
// @description  启动时进入并确认好友动态，再读取最上方动态；新动态交给接收器，相同则10秒后刷新。
// @match        *://user.qzone.qq.com/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  const CHANNEL = 'qzonebot:v1:';
  const WAIT_MS = 10_000;
  const account = location.pathname.split('/')[1];
  // sessionStorage 按标签页隔离，刷新后保留；只保存紧邻上次读取的正文。
  const LAST_TEXT_KEY = `${CHANNEL}last-text:${account}`;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  function popupAndReload(message) {
    const box = document.createElement('div');
    box.setAttribute('role', 'alert');
    box.style.cssText = 'position:fixed;top:24px;left:50%;transform:translateX(-50%);z-index:2147483647;padding:20px 28px;max-width:80vw;background:#fff;color:#222;border:2px solid #3986ff;border-radius:10px;box-shadow:0 6px 30px #0005;white-space:pre-wrap;font:16px/1.6 sans-serif';
    box.textContent = `${message}\n10 秒后自动刷新。`;
    document.documentElement.appendChild(box);
    setTimeout(() => location.reload(), WAIT_MS);
  }

  function isFriendFeedPage() {
    const tab = document.getElementById('tab_menu_friend');
    const list = document.getElementById('feed_friend_list');
    return Boolean(tab?.closest('li[type="friend"]')?.classList.contains('current') &&
      tab.getClientRects().length > 0 && list?.getClientRects().length > 0);
  }

  async function ensureFriendFeedPage() {
    // 导航和列表均异步渲染；点击完成不等于已经切换到好友动态。
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const deadline = Date.now() + 30_000;
      let clicked = false;
      while (Date.now() < deadline) {
        const tab = document.getElementById('tab_menu_friend');
        if (!clicked && tab?.getClientRects().length > 0) {
          tab.click();
          clicked = true;
        }
        if (clicked && isFriendFeedPage()) return;
        await sleep(300);
      }
      if (attempt < maxAttempts) {
        console.warn(`[QQ空间读取器] 第 ${attempt} 次进入好友动态未成功，将重新查找并点击好友动态入口。`);
        continue;
      }
      throw new Error(clicked
        ? `尝试 ${maxAttempts} 次进入好友动态后，仍未确认导航选中且动态列表可见，已停止读取。`
        : `尝试 ${maxAttempts} 次进入好友动态后，仍未找到左侧好友动态入口，请确认已登录并打开个人中心，已停止读取。`);
    }
  }

  function readTopFeed() {
    // 等待正文渲染期间若被切换到其他栏目，也不能读取残留的动态 DOM。
    if (!isFriendFeedPage()) return null;
    const list = document.getElementById('feed_friend_list');
    if (!list) return null;
    const first = Array.from(list.children).find(el =>
      el.matches('.f-single') && el.getClientRects().length > 0
    );
    if (!first) return null;
    const content = first.querySelector('.f-single-content');
    const item = content?.querySelector('.f-item');
    if (!item) return null;

    // 直接读取正文，不读取昵称、点赞、评论，也不专门清理表情文字。
    // 纯图片动态没有正文时用空字符串，空字符串也参与严格比较。
    const text = item.querySelector('.f-info')?.innerText ?? '';
    const images = Array.from(item.querySelectorAll('.img-box .img-item')).map(link => {
      const img = link.querySelector('img');
      const pickey = link.getAttribute('data-pickey') || '';
      const comma = pickey.indexOf(',');
      const original = comma >= 0 ? pickey.slice(comma + 1) : '';
      const thumbnail = img?.getAttribute('data-src') ||
        img?.getAttribute('data-original') || img?.currentSrc || img?.src || '';
      const url = /^(https?:)?\/\//.test(original) ? original : thumbnail;
      if (!url || !/^(https?:)?\/\//.test(url)) return null;
      return {
        url: new URL(url, location.href).href,
        thumbnailUrl: thumbnail ? new URL(thumbnail, location.href).href : '',
        width: Number(link.getAttribute('data-width')) || null,
        height: Number(link.getAttribute('data-height')) || null,
      };
    }).filter(Boolean);

    // feedId只用于定位评论目标，判重仍只比较正文。
    return { text, images, feedId: first.id, pageUrl: location.href, capturedAt: new Date().toISOString() };
  }

  async function waitForFeed() {
    // 等异步动态列表出现，并给首条正文、图片 DOM 一点渲染时间。
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (readTopFeed()) {
        await sleep(1500);
        const feed = readTopFeed();
        if (feed) return feed;
      }
      await sleep(300);
    }
    throw new Error('30 秒内未找到首条动态，请确认已登录且当前是好友动态页面。');
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
    if (sessionStorage.getItem('qzonebot:mode') === 'reply') return;
    if (sessionStorage.getItem(`${CHANNEL}pending-comment:${account}`)) {
      console.warn('[QQ空间读取器] 存在未完成评论任务，请先检查评论结果及发送者日志。');
      return;
    }
    await ensureFriendFeedPage();
    const feed = await waitForFeed();
    const previousText = sessionStorage.getItem(LAST_TEXT_KEY);
    // 唯一判重条件是正文完全相同；首次运行（null）当作新动态。
    if (previousText !== null && previousText === feed.text) {
      sessionStorage.setItem(LAST_TEXT_KEY, feed.text);
      popupAndReload('测试：正文与上次相同，是同一条动态。');
      return;
    }

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
