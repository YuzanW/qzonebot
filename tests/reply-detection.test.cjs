const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../04-qzone-reply-reader.user.js'), 'utf8');
function reader(rows = []) {
  const ctx = { Date, location: { pathname: '/123', href: 'https://user.qzone.qq.com/123' },
    document: { getElementById: id => id === 'tab_menu_me' ? {
      getClientRects: () => [{}], closest: () => ({ classList: { contains: () => true } }),
    } : { getClientRects: () => [{}], children: rows } } };
  vm.runInNewContext(source.replace('  main().catch(error => {',
    '  globalThis.api = { normalizeMessageType, messageStatus, readTopFeed }; Promise.resolve().catch(error => {'), ctx);
  return ctx.api;
}
test('页面实际的评论通知及回复标题均识别为回复协议类型', () => {
  const r = reader();
  for (const title of ['评论', '\t 评论 \n', '回复', '回复了我的评论', '评论了我的说说'])
    assert.equal(r.normalizeMessageType(title), '回复');
  for (const title of ['赞了我的说说', '访问了我的主页', '', '取消回复', '分享了我的说说'])
    assert.notEqual(r.normalizeMessageType(title), '回复');
});
test('实际标题为评论且带评论链时可选中；成功处理后按消息ID去重', () => {
  const rows = ['赞了我的说说', '评论', '访问了我的主页', '回复'].map((title, i) => ({
    id: `fct_${i}`, matches: () => true, getClientRects: () => [{}],
    querySelector: selector => selector === '.f-nick .state' ? { textContent: `\t${title}\t` } : null,
    querySelectorAll: selector => selector === '.comments-list > ul > li' && i === 1
      ? [{ innerText: 'LiAlH4 : 唐诗的并非bot\n15:45' }] : [],
  }));
  const r = reader(rows), messages = r.readTopFeed();
  assert.equal(messages.length, 3);
  const select = seen => messages.find(item => r.messageStatus(item, seen) === '新回复');
  assert.equal(select([]).messageId, 'fct_1');
  assert.equal(select([]).rawMessageType, '评论');
  assert.equal(select(['fct_1']), undefined);
  assert.equal(r.messageStatus(messages[0], []), '非评论/回复通知');
  assert.equal(r.messageStatus({ ...messages[1], commentChain: [] }, []), '等待评论链加载');
});
