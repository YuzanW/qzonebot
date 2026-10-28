// ==UserScript==
// @name         QQ空间动态接收器
// @namespace    qzonebot.local
// @version      1.4.0
// @description  将动态正文与配图链接传给本地Python服务，不弹窗、不刷新。
// @match        *://user.qzone.qq.com/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  const CHANNEL = 'qzonebot:v1:';
  const ENDPOINT = 'http://127.0.0.1:8765/feed';
  let received = false;

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function waitForSender() {
    let ready = false;
    const onReady = () => { ready = true; };
    document.addEventListener(`${CHANNEL}sender-ready`, onReady);
    try {
      const deadline = Date.now() + 10_000;
      while (!ready && Date.now() < deadline) {
        document.dispatchEvent(new Event(`${CHANNEL}sender-ping`));
        if (!ready) await sleep(100);
      }
      if (!ready) throw new Error('请同时安装并启用03-qzone-sender.user.js。');
    } finally {
      document.removeEventListener(`${CHANNEL}sender-ready`, onReady);
    }
  }

  // 使用油猴请求接口访问本机，避免HTTPS页面直接fetch本地HTTP的限制。
  // 传递图片链接和元数据，不下载图片。
  function receiveFeed(feed) {
    // 旧版读取器没有feedId，不能把缺少评论目标的动态交给服务。
    if (typeof feed.feedId !== 'string' || !feed.feedId.startsWith('fct_')) {
      return Promise.reject(new Error('动态缺少有效feedId，请在油猴中更新01-qzone-reader.user.js，并停用旧版或重复的读取器。'));
    }
    if (typeof feed.pageUrl !== 'string' || new URL(feed.pageUrl).hostname !== 'user.qzone.qq.com') {
      return Promise.reject(new Error('动态缺少有效QQ空间pageUrl，请更新01-qzone-reader.user.js。'));
    }
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: ENDPOINT,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify(feed),
        timeout: 200_000,
        onload(response) {
          try {
            let result;
            try { result = JSON.parse(response.responseText); } catch { /* 下方显示响应摘要 */ }
            if (response.status !== 200 || result?.ok !== true || !result.command) {
              const detail = typeof result?.error === 'string' && result.error
                ? result.error
                : (response.responseText || '').trim().slice(0, 500) || '服务未返回错误详情';
              throw new Error(`本地服务返回异常：HTTP ${response.status}；${detail}`);
            }
            resolve(result.command);
          } catch (error) { reject(error); }
        },
        onerror: () => reject(new Error('无法连接本地Python服务，请先运行 local_python/server.py。')),
        ontimeout: () => reject(new Error('本地Python服务响应超时。')),
        onabort: () => reject(new Error('本地请求已取消。')),
      });
    });
  }

  document.addEventListener(`${CHANNEL}ping`, () => {
    if (sessionStorage.getItem('qzonebot:mode') === 'reply') return;
    document.dispatchEvent(new Event(`${CHANNEL}ready`));
  });

  document.addEventListener(`${CHANNEL}feed`, async event => {
    if (sessionStorage.getItem('qzonebot:mode') === 'reply') return;
    if (received || typeof event.detail !== 'string') return;
    try {
      const feed = JSON.parse(event.detail);
      if (typeof feed.text !== 'string' || !Array.isArray(feed.images)) return;
      received = true;
      await waitForSender();
      const command = await receiveFeed(feed);
      document.dispatchEvent(new Event(`${CHANNEL}accepted`));
      document.dispatchEvent(new CustomEvent(`${CHANNEL}comment`, { detail: JSON.stringify(command) }));
      console.log('[QQ空间接收器] 已将Python工具调用交给发送者。');
    } catch (error) {
      received = false;
      console.error('[QQ空间接收器] 接收失败：', error);
      document.dispatchEvent(new CustomEvent(`${CHANNEL}failed`, { detail: error.message }));
    }
  });
})();
