import test from 'node:test'
import assert from 'node:assert/strict'
import { h } from '../site/src/dom.js'

// dom.js only touches `document` inside function bodies, so a minimal stub is
// enough to exercise the attribute guard without a browser.
function stubElement() {
  return {
    attrs: {}, style: {}, dataset: {},
    setAttribute(key, value) { this.attrs[key] = value },
    append() {},
    addEventListener() {},
  }
}

test('h() refuses HTML sinks and string event handlers', () => {
  const previous = globalThis.document
  globalThis.document = { createElement: stubElement, createTextNode: (value) => ({ value }) }
  try {
    assert.throws(() => h('div', { innerHTML: '<img onerror=alert(1)>' }), /refuses innerHTML/)
    assert.throws(() => h('div', { outerHTML: '<b>' }), /refuses outerHTML/)
    assert.throws(() => h('iframe', { srcdoc: '<script>' }), /refuses srcdoc/)
    assert.throws(() => h('button', { onclick: 'alert(1)' }), /expects a function/)

    const node = h('p', { text: '<b>literal</b>', className: 'x', onClick: () => {} })
    assert.equal(node.textContent, '<b>literal</b>')
    assert.equal(node.className, 'x')
  } finally {
    globalThis.document = previous
  }
})
