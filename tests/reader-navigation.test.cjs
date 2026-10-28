const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../01-qzone-reader.user.js'), 'utf8');

function fixture({ active = false, visible = false, entryDelay = 0, switchDelay = 600,
  missing = false, neverSwitch = false, pending = false, mode = null } = {}) {
  let now = 0;
  let clicks = 0;
  let clickedAt = null;
  let listReads = 0;
  let storageReads = 0;
  const tab = {
    getClientRects: () => [{}],
    closest: () => ({ classList: { contains: () => active } }),
    click() { clicks++; clickedAt = now; },
  };
  const list = {
    getClientRects: () => visible ? [{}] : [],
    get children() { listReads++; return []; },
  };
  const context = {
    location: { pathname: '/123' },
    Date: { now: () => now },
    setTimeout(callback, delay) {
      now += delay;
      if (clickedAt !== null && !neverSwitch && now - clickedAt >= switchDelay) {
        active = true;
        visible = true;
      }
      queueMicrotask(callback);
    },
    sessionStorage: { getItem(key) { if (key === 'qzonebot:mode') return mode; storageReads++; return pending ? 'pending' : null; } },
    document: {
      getElementById(id) {
        if (id === 'tab_menu_friend') return missing || now < entryDelay ? null : tab;
        if (id === 'feed_friend_list') return list;
        throw new Error(`Unexpected ID: ${id}`);
      },
    },
    console: { warn() {} },
  };
  vm.runInNewContext(source.replace('  main().catch(error => {',
    '  globalThis.reader = { ensureFriendFeedPage, readTopFeed, main }; Promise.resolve().catch(error => {'), context);
  return {
    reader: context.reader,
    stats: () => ({ now, clicks, listReads, storageReads }),
  };
}

test('从其他栏目启动时，点击好友动态并等待异步切换', async () => {
  const f = fixture({ entryDelay: 600 });
  await f.reader.ensureFriendFeedPage();
  assert.equal(f.stats().clicks, 1);
  assert.equal(f.stats().now, 1200);
  assert.equal(f.stats().listReads, 0);
});

test('已处于好友动态时仍操作入口，并可立即确认界面', async () => {
  const f = fixture({ active: true, visible: true });
  await f.reader.ensureFriendFeedPage();
  assert.equal(f.stats().clicks, 1);
  assert.equal(f.stats().now, 0);
});

test('仅导航选中但列表隐藏时，不能通过界面确认', async () => {
  const f = fixture({ active: true, neverSwitch: true });
  await assert.rejects(f.reader.ensureFriendFeedPage(), /未确认导航选中且动态列表可见/);
  assert.equal(f.stats().clicks, 1);
});

test('残留列表可见但导航不在好友动态时不读取正文', () => {
  const f = fixture({ visible: true });
  assert.equal(f.reader.readTopFeed(), null);
  assert.equal(f.stats().listReads, 0);
});

test('入口缺失时主流程停止，不读取动态或进入正文判重', async () => {
  const f = fixture({ missing: true, visible: true });
  await assert.rejects(f.reader.main(), /未找到左侧好友动态入口/);
  assert.equal(f.stats().clicks, 0);
  assert.equal(f.stats().listReads, 0);
  assert.equal(f.stats().storageReads, 1); // 只检查未完成评论任务。
});

test('存在未完成评论时保留原有保护，不切换页面', async () => {
  const f = fixture({ pending: true });
  await f.reader.main();
  assert.equal(f.stats().clicks, 0);
  assert.equal(f.stats().now, 0);
});

 test('评论模式下动态模块不导航、不读取动态', async () => {
  const f = fixture({ mode: 'reply' });
  await f.reader.main();
  assert.equal(f.stats().clicks, 0);
  assert.equal(f.stats().listReads, 0);
  assert.equal(f.stats().storageReads, 0);
});
