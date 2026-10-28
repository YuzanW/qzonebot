const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../04-qzone-reply-reader.user.js'), 'utf8');
function fixture({ active = false, listVisible = false, succeedOn = 1, missing = false, listDelay = 0 } = {}) {
  let clicks = 0, now = 0, selectedAt = null;
  const sidebar = { getClientRects: () => [{}], closest: selector => {
    assert.equal(selector, 'li[type="me"]');
    return { classList: { contains: () => active } };
  }, click() { clicks++; if (clicks >= succeedOn) { active = true; selectedAt = now; listVisible = listDelay === 0; } } };
  const rows = [];
  const list = { getClientRects: () => listVisible ? [{}] : [], children: rows };
  const context = { location: { pathname: '/123', href: 'https://user.qzone.qq.com/123' },
    Date: { now: () => now }, setTimeout(cb, ms) { now += ms; if (selectedAt !== null && now - selectedAt >= listDelay) listVisible = true; queueMicrotask(cb); },
    console: { log() {} },
    document: { getElementById(id) {
      if (id === 'tab_menu_me') return missing ? null : sidebar;
      if (id === 'feed_me_list') return list;
      throw new Error(`不应读取隐藏标题或好友列表：${id}`);
    } },
  };
  vm.runInNewContext(source.replace('  main().catch(error => {',
    '  globalThis.reader = { relatedTab, isRelatedPage, ensureRelatedPage, readTopFeed }; Promise.resolve().catch(error => {'), context);
  return { reader: context.reader, sidebar, rows, clicks: () => clicks };
}
test('从好友动态进入与我相关，使用左侧tab_menu_me和feed_me_list', async () => {
  const f = fixture();
  assert.equal(f.reader.relatedTab(), f.sidebar);
  await f.reader.ensureRelatedPage();
  assert.equal(f.clicks(), 1);
  assert.equal(f.reader.isRelatedPage(), true);
});
test('仅导航选中、相关列表隐藏时不能读取残留内容', () => {
  const f = fixture({ active: true });
  assert.equal(f.reader.isRelatedPage(), false);
  assert.equal(f.reader.readTopFeed(), null);
});
test('仅相关列表可见、导航未选中时不能确认页面', () => {
  assert.equal(fixture({ listVisible: true }).reader.isRelatedPage(), false);
});
test('列表中的无ID占位行不占用最上方三条消息名额', () => {
  const f = fixture({ active: true, listVisible: true });
  f.rows.push({ matches: selector => { assert.equal(selector, '.f-single[id^="fct_"]'); return false; } });
  for (let i = 0; i < 4; i++) f.rows.push({ id: `fct_${i}`, matches: () => true,
    getClientRects: () => [{}], querySelector: () => null,
    querySelectorAll: selector => { assert.ok(['.comments-list > ul > li', '.f-item .img-box .img-item img'].includes(selector)); return []; },
  });
  // readTopFeed只需ISO时间，不改变导航测试的模拟时钟。
  // 单独注入真实Date以生成capturedAt。
  const ctx = { location: { pathname: '/123', href: 'https://user.qzone.qq.com/123' }, Date,
    document: { getElementById: id => id === 'tab_menu_me' ? f.sidebar : { children: f.rows, getClientRects: () => [{}] } } };
  vm.runInNewContext(source.replace('  main().catch(error => {',
    '  globalThis.read = readTopFeed; Promise.resolve().catch(error => {'), ctx);
  assert.deepEqual(Array.from(ctx.read(), row => row.feedId), ['fct_0', 'fct_1', 'fct_2']);
});

test('前两次点击无效时重试，第三次成功后停止点击', async () => {
  const f = fixture({ succeedOn: 3 });
  await f.reader.ensureRelatedPage();
  assert.equal(f.clicks(), 3);
  assert.equal(f.reader.isRelatedPage(), true);
});
test('选中导航后等待相关列表异步出现，期间不反复打断加载', async () => {
  const f = fixture({ listDelay: 1800 });
  await f.reader.ensureRelatedPage();
  assert.equal(f.clicks(), 1);
});
test('始终无法切换时最多点击八次并明确报错', async () => {
  const f = fixture({ succeedOn: Infinity });
  await assert.rejects(f.reader.ensureRelatedPage(), /尝试点击8次/);
  assert.equal(f.clicks(), 8);
});
test('入口缺失时等待后停止，不误点其他入口', async () => {
  const f = fixture({ missing: true });
  await assert.rejects(f.reader.ensureRelatedPage(), /尝试点击0次/);
  assert.equal(f.clicks(), 0);
});
test('已处于相关栏目时确认稳定后直接继续，不重新点击', async () => {
  const f = fixture({ active: true, listVisible: true });
  await f.reader.ensureRelatedPage();
  assert.equal(f.clicks(), 0);
});
