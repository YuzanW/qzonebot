const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../06-qzone-reply-sender.user.js'), 'utf8');
const writeBlock = source.slice(source.indexOf('      const expectedEditorText'), source.indexOf('      getTarget(command);', source.indexOf('      const expectedEditorText')));
for (const nativeInsert of [true, false]) {
  test(`已有回复对象标记时在末尾添加输出文本，${nativeInsert ? '使用原生插入' : '使用文本节点回退'}`, async () => {
    const prefix = '回复 LiAlH4 :\u00a0';
    let atEnd = false;
    const editor = { innerText: prefix, focus() {}, dispatchEvent() {},
      appendChild(node) { this.innerText += node.textContent; },
      ownerDocument: { defaultView: { getSelection: () => ({ removeAllRanges() {}, addRange() {} }) } } };
    const context = { editor, command: { comment: '测试输出' }, normalize: s => s.replace(/\s+/g, ' ').trim(),
      sleep: async () => {}, InputEvent: class {}, Event: class {}, KeyboardEvent: class {},
      document: { createRange: () => ({ selectNodeContents(node) { assert.equal(node, editor); }, collapse(toStart) { atEnd = !toStart; } }),
        createTextNode: textContent => ({ textContent }),
        execCommand(type, ui, text) { assert.equal(type, 'insertText'); assert.ok(atEnd); if (nativeInsert) editor.innerText += text; return nativeInsert; } } };
    await vm.runInNewContext(`(async () => { ${writeBlock} })()`, context);
    assert.equal(editor.innerText, prefix + '测试输出');
  });
}
