/**
 * Properties that parse a string as HTML. `h()` refuses them outright: every
 * string that reaches the DOM in this app goes through `text` / `textContent`,
 * and that rule is what keeps imported and YouTube-supplied data inert.
 */
const HTML_SINKS = new Set(['innerHTML', 'outerHTML', 'srcdoc'])

export function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (HTML_SINKS.has(key)) throw new TypeError(`h() refuses ${key}; use { text } or child nodes`)
    if (value === undefined || value === null || value === false) continue
    if (key === 'className') node.className = value
    else if (key === 'text') node.textContent = value
    else if (key === 'dataset') Object.assign(node.dataset, value)
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value)
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value)
    else if (key.startsWith('on')) throw new TypeError(`h() expects a function for ${key}, not a string handler`)
    else if (key in node && key !== 'list') node[key] = value
    else node.setAttribute(key, value === true ? '' : String(value))
  }
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue
    node.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return node
}

/**
 * Patch a list in place, keyed by identity. Existing nodes are reused and
 * reordered rather than rebuilt, so focus, scroll and any embedded iframe
 * inside a row survive an update.
 */
export function reconcileList(container, items, keyOf, create, update) {
  const existing = new Map()
  for (const node of [...container.children]) {
    if (node.dataset?.key !== undefined) existing.set(node.dataset.key, node)
  }
  items.forEach((item, index) => {
    const key = String(keyOf(item, index))
    let node = existing.get(key)
    if (node) existing.delete(key)
    else {
      node = create(item, index)
      node.dataset.key = key
    }
    update?.(node, item, index)
    const atPosition = container.children[index]
    if (atPosition !== node) container.insertBefore(node, atPosition ?? null)
  })
  for (const stale of existing.values()) stale.remove()
}

/** Set textContent only when it differs, to avoid pointless DOM churn. */
export function setText(node, text) {
  const value = String(text ?? '')
  if (node.textContent !== value) node.textContent = value
}

export function setClass(node, className) {
  if (node.className !== className) node.className = className
}

export function toggleHidden(node, hidden) {
  node.hidden = Boolean(hidden)
}

export function clear(node) {
  while (node.firstChild) node.firstChild.remove()
}

export function badge(text, selected = false) {
  return h('span', { className: `tag ${selected ? 'tag--selected' : ''}`, text })
}

export function button(label, options = {}) {
  const { className = 'button', ...attrs } = options
  return h('button', { type: 'button', className, ...attrs }, label)
}

export function linkButton(label, href, className = 'button button--secondary') {
  return h('a', { href, className, text: label })
}

export function progressBar(percent, label = `${percent}% complete`) {
  const fill = h('span', { className: 'progress__fill', style: { width: `${Math.max(0, Math.min(100, percent))}%` } })
  const bar = h('div', { className: 'progress', role: 'progressbar', 'aria-label': label, 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(percent) }, fill)
  bar.update = (nextPercent, nextLabel) => {
    const clamped = Math.max(0, Math.min(100, nextPercent))
    fill.style.width = `${clamped}%`
    bar.setAttribute('aria-valuenow', String(nextPercent))
    if (nextLabel) bar.setAttribute('aria-label', nextLabel)
  }
  return bar
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return ''
  const total = Math.round(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
    : `${minutes}:${String(secs).padStart(2, '0')}`
}

export function shortVideoLabel(videoId) {
  return `Video ${String(videoId).slice(0, 8)}`
}

export function thumbnailImg(videoId, alt = '') {
  const img = h('img', {
    className: 'thumbnail',
    src: `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg`,
    alt,
    loading: 'lazy',
  })
  img.addEventListener('error', () => { img.classList.add('thumbnail--failed') })
  return img
}

function toastRegion() {
  let region = document.getElementById('toast-region')
  if (!region) {
    region = h('div', { id: 'toast-region', className: 'toast-region', role: 'status', 'aria-live': 'polite' })
    document.body.append(region)
  }
  return region
}

export function showToast(message, kind = 'info', options = {}) {
  const { action } = options
  if (options.label || options.onClick) {
    throw new TypeError('showToast expects { action: { label, onClick } }')
  }
  const region = toastRegion()
  region.replaceChildren()
  const toast = h('div', { className: `toast toast--${kind}` }, h('span', { text: message }))
  let timer
  if (action) {
    toast.append(button(action.label, {
      className: 'button button--ghost button--small toast__action',
      onClick: () => { clearTimeout(timer); toast.remove(); action.onClick() },
    }))
  }
  region.append(toast)
  timer = setTimeout(() => toast.remove(), action ? 8000 : 3500)
}

export function createEmptyState(title, body, actionLabel, actionHref) {
  return h('section', { className: 'empty-state' },
    h('div', { className: 'empty-state__icon', text: '▷' }),
    h('h2', { text: title }),
    h('p', { className: 'muted', text: body }),
    actionLabel ? linkButton(actionLabel, actionHref, 'button button--primary') : null,
  )
}
