const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../06-qzone-reply-sender.user.js'), 'utf8');
const command = () => ({ type: 'write_reply', commandId: 'cmd1', feedId: 'fct_1', messageId: 'fct_1',
  text: '原文', comment: '新回复', commentChain: ['甲 : 评论'], pageUrl: 'https://user.qzone.qq.com/123' });
function fixture({ staleAt = 0, alwaysStale = false, uncertain = false, mutateDraft = false, wrongTarget = false } = {}) {
  const data = new Map([['qzonebot:mode', 'reply']]);
  const reports = [], requests = [];
  let checks = 0, clicks = 0, generated = 0, now = 0;
  let html = '回复甲：';
  const editor = { get innerHTML() { return html; }, set innerHTML(v) { html = v; },
    get innerText() { return html; }, focus() {}, dispatchEvent() {},
    appendChild(node) { html += node.textContent; },
    ownerDocument: { defaultView: { getSelection: () => ({ removeAllRanges() {}, addRange() {} }) } } };
  const button = { click() { clicks++; }, classList: { contains: () => false },
    getClientRects: () => [{}], getAttribute: () => null };
  const root = { contains: () => true, querySelectorAll: sel => sel === '.comment-box-wrap .btn-post' ? [button] : [] };
  const ctx = { URL, Date, console: { log() {}, warn() {}, error() {} },
    location: { pathname: '/123', origin: 'https://user.qzone.qq.com', href: command().pageUrl, reload() {} },
    sessionStorage: { getItem: k => data.get(k) ?? null, setItem: (k,v) => data.set(k,v), removeItem: k => data.delete(k) },
    setTimeout(cb, ms) { if (ms === 3000) return; now += ms; queueMicrotask(cb); },
    getComputedStyle: () => ({ visibility: 'visible' }), Event: class {}, InputEvent: class {}, KeyboardEvent: class {},
    document: { addEventListener() {}, createRange: () => ({ selectNodeContents() {}, collapse() {} }),
      createTextNode: textContent => ({ textContent }), execCommand() { return false; } },
    GM_xmlhttpRequest(req) {
      const body = JSON.parse(req.data);
      if (req.url.endsWith('/reply-result')) { reports.push(body); req.onload({ status: 200 }); }
      else {
        requests.push(body); generated++;
        req.onload({ status: 200, responseText: JSON.stringify({ ok: true, command: {
          ...command(), ...body, type: 'write_reply', commandId: `new${generated}`,
          feedId: wrongTarget ? 'fct_other' : body.feedId,
        } }) });
      }
    },
    root, editor, fresh: { ...command(), images: [], messageType: '回复' },
    target() { checks++; if (alwaysStale || checks === staleAt) return false; return true; },
    changedDraft() { if (mutateDraft) html += '手写'; },
    uncertain,
  };
  vm.runInNewContext(source.replace('  document.addEventListener(`${CHANNEL}sender-ping`', `
    getTarget = () => { if (!target()) { changedDraft(); throw new ContextChanged('changed'); } return root; };
    freshFeed = async () => fresh;
    openCommentEditor = async () => editor;
    waitFor = async (find, message, timeout) => {
      if (timeout === 20000) { if (uncertain) throw new Error('unknown'); return {}; }
      return find();
    };
    globalThis.api = { send, sameChain, validateCommand };
    document.addEventListener(\`\${CHANNEL}sender-ping\``), ctx);
  return { api: ctx.api, data, reports, requests, editor, clicks: () => clicks };
}
test('只归一化空白，不忽略新增、删除、改写或评论顺序变化', () => {
  const { api } = fixture();
  assert.equal(api.sameChain(['甲 :\n 内容'], ['甲 : 内容']), true);
  for (const chain of [[], ['甲 : 其他'], ['甲 : 内容', '乙 : 新评论']])
    assert.equal(api.sameChain(['甲 : 内容'], chain), false);
  assert.equal(api.sameChain(['甲', '乙'], ['乙', '甲']), false);
});
test('开始发送时链变化，重新生成后只发表一次并写入seen', async () => {
  const f = fixture({ staleAt: 1 });
  await f.api.send(command());
  assert.equal(f.requests.length, 1);
  assert.equal(f.clicks(), 1);
  assert.deepEqual(f.reports.map(r => r.success), [false, true]);
  assert.ok(f.data.get('qzonebot:reply:v1:seen:123').includes('fct_1'));
  await f.api.send(command());
  assert.equal(f.clicks(), 1);
});
test('写入后链变化会撤销旧草稿，再生成时不叠加两份文本', async () => {
  const f = fixture({ staleAt: 3 });
  await f.api.send(command());
  assert.equal(f.editor.innerText, '回复甲：新回复');
  assert.equal(f.requests.length, 1);
  assert.equal(f.clicks(), 1);
});
test('等待发表按钮之后再次校验，变化时不发送旧内容', async () => {
  const f = fixture({ staleAt: 4 });
  await f.api.send(command());
  assert.equal(f.requests.length, 1);
  assert.equal(f.clicks(), 1);
});
test('评论链持续变化最多重新生成两次，无发表和seen记录', async () => {
  const f = fixture({ alwaysStale: true });
  await f.api.send(command());
  assert.equal(f.requests.length, 2);
  assert.equal(f.clicks(), 0);
  assert.equal(f.data.has('qzonebot:reply:v1:seen:123'), false);
});
test('点击后不等待回显，记录已处理并清除pending', async () => {
  const f = fixture({ uncertain: true });
  await f.api.send(command());
  await f.api.send({ ...command(), commandId: 'another' });
  assert.equal(f.clicks(), 1);
  assert.equal(f.requests.length, 0);
  assert.equal(f.data.has('qzonebot:reply:v1:pending-comment:123'), false);
  assert.ok(f.data.get('qzonebot:reply:v1:seen:123').includes('fct_1'));
  assert.equal(f.reports[0].success, true);
  assert.match(f.reports[0].error, /未确认实际送达/);
});
test('用户改写草稿后不覆盖、不重新生成或发表', async () => {
  const f = fixture({ staleAt: 3, mutateDraft: true });
  await f.api.send(command());
  assert.equal(f.editor.innerText, '回复甲：新回复手写');
  assert.equal(f.requests.length, 0);
  assert.equal(f.clicks(), 0);
});
test('服务返回不匹配目标时拒绝发送', async () => {
  const f = fixture({ staleAt: 1, wrongTarget: true });
  await f.api.send(command());
  assert.equal(f.clicks(), 0);
});
function pageFixture({ changing = false, foreign = false } = {}) {
  let now = 0;
  const visible = { getClientRects: () => [{}] };
  const root = { ...visible, matches: () => true,
    querySelector: () => ({ innerText: '原文' }),
    querySelectorAll: selector => selector.includes('comments-list')
      ? [{ innerText: changing ? `评论${now}` : '甲 : 评论' }] : [],
  };
  const ctx = { URL, location: { pathname: '/123', origin: 'https://user.qzone.qq.com', href: command().pageUrl },
    Date: class extends Date { static now() { return now; } },
    setTimeout(cb, ms) { now += ms; queueMicrotask(cb); },
    sessionStorage: { getItem: () => 'reply' }, getComputedStyle: () => ({ visibility: 'visible' }),
    document: { addEventListener() {}, getElementById: id => id === 'tab_menu_me'
      ? { ...visible, closest: () => ({ classList: { contains: () => true } }) }
      : id === 'feed_me_list' ? visible : foreign ? null : root },
  };
  vm.runInNewContext(source.replace('  document.addEventListener(`${CHANNEL}sender-ping`',
    '  globalThis.api = { getTarget, freshFeed }; document.addEventListener(`${CHANNEL}sender-ping`'), ctx);
  return { ...ctx.api, now: () => now };
}
test('真实目标校验拒绝其他域名、路径、丢失目标以及正文变化', () => {
  const p = pageFixture();
  assert.ok(p.getTarget(command()));
  assert.throws(() => p.getTarget({ ...command(), pageUrl: 'https://example.com/123' }));
  assert.throws(() => p.getTarget({ ...command(), pageUrl: 'https://user.qzone.qq.com/456' }));
  assert.throws(() => p.getTarget({ ...command(), text: '另一条正文' }));
  assert.throws(() => pageFixture({ foreign: true }).getTarget(command()));
});
test('重新生成前连续800ms稳定才取快照，持续变化则5秒内停止', async () => {
  const stable = pageFixture();
  const feed = await stable.freshFeed(command());
  assert.equal(stable.now(), 800);
  assert.deepEqual(Array.from(feed.commentChain), ['甲 : 评论']);
  const changing = pageFixture({ changing: true });
  await assert.rejects(changing.freshFeed(command()), /持续变化/);
  assert.equal(changing.now(), 5000);
});
