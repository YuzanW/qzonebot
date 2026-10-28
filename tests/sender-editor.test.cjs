const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require('node:path').join(__dirname, '../03-qzone-sender.user.js'), 'utf8');
// 暴露函数供测试，避免启动真实评论发送流程。
const context = {
  location: { pathname: '/123' },
  document: { addEventListener() {} },
  setTimeout, Date,
  window: {},
  console: { log() {} },
  MouseEvent: class {
    constructor(type, options) {
      // 模拟油猴隔离环境：沙箱window不能转换为原生Window。
      if (options.view != null) {
        throw new TypeError("Failed to construct 'MouseEvent': Failed to convert value to 'Window'.");
      }
      this.type = type;
      Object.assign(this, options);
    }
  },
  getComputedStyle: () => ({ visibility: 'visible' }),
};
vm.runInNewContext(source
  .replace('hoverMs: 600, pressMs: 120, waitMs: 2000', 'hoverMs: 6, pressMs: 1, waitMs: 20')
  .replace(/\}\)\(\);\s*$/, 'globalThis.openEditor = openCommentEditor; globalThis.commentBody = commentBody; })();'), context);

// 复现Chrome元素检查器中看到的comments-content结构。
function commentFixture(authorClass, body, mention = '') {
  const parts = [];
  const element = (tag, className, text) => ({
    textContent: text,
    matches(selector) {
      return selector.split(',').some(value => {
        const [wantedTag, wantedClass] = value.trim().split('.');
        return (!wantedTag || wantedTag === tag) && className.split(' ').includes(wantedClass);
      });
    },
    remove() { parts.splice(parts.indexOf(this), 1); },
  });
  parts.push(element('a', authorClass, 'please don’t say you are lazy'));
  parts.push({ textContent: ` : ${body}` });
  if (mention) parts.push(element('a', 'q_namecard', mention));
  parts.push(element('div', 'comments-op', '12:07 回复 删除'));
  parts.push(element('div', 'fail', ''));
  const content = {
    get firstElementChild() { return parts.find(part => part.matches); },
    get textContent() { return parts.map(part => part.textContent).join(''); },
    querySelectorAll: selector => parts.filter(part => part.matches?.(selector)),
  };
  return { querySelector: () => ({ cloneNode: () => content }) };
}

test('新发送评论的q_namecard作者和操作时间不混入正文', () => {
  assert.equal(context.commentBody(commentFixture('q_namecard q_des c_tx', '收到测试✔')), '收到测试✔');
});

test('兼容旧版nickname作者节点', () => {
  assert.equal(context.commentBody(commentFixture('nickname', '收到，测试成功~')), '收到，测试成功~');
});

test('清理作者时保留正文中的q_namecard提及', () => {
  assert.equal(context.commentBody(commentFixture('q_namecard', '谢谢 ', '@朋友')), '谢谢 @朋友');
});

function fixture({ opened = false, delayed = false, missing = false, focusOpens = true, clickAfter = Infinity, hoverOpens = false } = {}) {
  const editor = { getClientRects: () => [{}] };
  let active = opened;
  let focusCount = 0;
  let clickCount = 0;
  const events = [];
  const entry = {
    getClientRects: () => active ? [] : [{}],
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 100, height: 30 }),
    querySelector: () => null,
    closest: () => entry,
    scrollIntoView() {},
    focus() {
      focusCount++;
      if (!focusOpens) return;
      if (delayed) setTimeout(() => { active = true; }, 10);
      else active = true;
    },
    dispatchEvent(event) {
      events.push(event);
      if (event.type === 'mouseover' && hoverOpens) active = true;
      if (event.type === 'click' && ++clickCount >= clickAfter) active = true;
    },
  };
  const root = {
    contains: el => el === entry && !active,
    querySelectorAll(selector) {
      if (selector.startsWith('.comment-box-wrap ')) return active ? [editor] : [];
      if (selector === '.comment_default_inputentry .textinput') return missing ? [] : [entry];
      throw new Error(`Unexpected selector: ${selector}`);
    },
  };
  return { root, editor, events, counts: () => ({ focusCount, clickCount }) };
}

test('focus打开编辑器后不再点击已被替换的占位框', async () => {
  const f = fixture();
  assert.equal(await context.openEditor(f.root), f.editor);
  assert.deepEqual(f.counts(), { focusCount: 1, clickCount: 0 });
});

test('等待focus触发的异步编辑器初始化', async () => {
  const f = fixture({ delayed: true });
  assert.equal(await context.openEditor(f.root), f.editor);
  assert.equal(f.counts().focusCount, 1);
});

test('已经打开的编辑器直接复用，保留内容', async () => {
  const f = fixture({ opened: true });
  f.editor.innerText = '已有草稿';
  assert.equal(await context.openEditor(f.root), f.editor);
  assert.equal(f.editor.innerText, '已有草稿');
  assert.deepEqual(f.counts(), { focusCount: 0, clickCount: 0 });
});

test('没有评论入口时明确报错', async () => {
  const f = fixture({ missing: true });
  await assert.rejects(context.openEditor(f.root), /找不到该动态的评论入口/);
});

test('前三轮点击才打开时重试，并且打开后立即停止', async () => {
  const f = fixture({ focusOpens: false, clickAfter: 3 });
  assert.equal(await context.openEditor(f.root), f.editor);
  assert.equal(f.counts().clickCount, 3);
  assert.deepEqual(f.events.slice(0, 6).map(event => event.type),
    ['mouseover', 'mouseenter', 'mousemove', 'mousedown', 'mouseup', 'click']);
  assert.equal(f.events.find(event => event.type === 'mousedown').buttons, 1);
  assert.equal(f.events.find(event => event.type === 'click').clientX, 60);
});

test('鼠标事件不传入油猴沙箱window，避免view类型转换失败', async () => {
  const f = fixture({ focusOpens: false, clickAfter: 1 });
  assert.equal(await context.openEditor(f.root), f.editor);
  assert.equal(f.events.length, 6);
  for (const event of f.events) {
    assert.equal(event.view == null, true);
  }
});

test('移入就打开时不会继续按下或点击', async () => {
  const f = fixture({ hoverOpens: true });
  assert.equal(await context.openEditor(f.root), f.editor);
  assert.deepEqual(f.events.map(event => event.type), ['mouseover']);
  assert.equal(f.counts().clickCount, 0);
});

test('最多点击五次，失败时停止并提供诊断', async () => {
  const f = fixture({ focusOpens: false });
  await assert.rejects(context.openEditor(f.root), /已尝试5次/);
  assert.equal(f.counts().clickCount, 5);
});
