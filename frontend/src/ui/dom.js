/** Tiny hyperscript helper: h('div', {class: 'x', onclick}, 'text', child). */
export function h(tag, attrs = null, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key.startsWith('on') && typeof value === 'function') {
        el.addEventListener(key.slice(2), value);
      } else if (key in el && key !== 'list' && key !== 'style') {
        el[key] = value;
      } else {
        el.setAttribute(key, value === true ? '' : String(value));
      }
    }
  }
  append(el, children);
  return el;
}
function append(el, children) {
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
}
export function clear(el, ...children) {
  el.replaceChildren();
  append(el, children);
}
export function $(selector, root = document) {
  const el = root.querySelector(selector);
  if (!el) throw new Error(`Missing element ${selector}`);
  return el;
}
/** Simple key/value table used across the stats tabs. */
export function kvTable(rows) {
  return h(
    'table',
    { class: 'kv' },
    h(
      'tbody',
      null,
      rows.map(([k, v]) => h('tr', null, h('th', null, k), h('td', null, ...(Array.isArray(v) ? v : [v])))),
    ),
  );
}
export function dataTable(headers, rows, cls = '') {
  return h(
    'table',
    { class: `grid ${cls}` },
    h(
      'thead',
      null,
      h(
        'tr',
        null,
        headers.map((x) => h('th', null, x)),
      ),
    ),
    h(
      'tbody',
      null,
      rows.length
        ? rows.map((r) =>
            h(
              'tr',
              null,
              r.map((c) => h('td', null, ...(Array.isArray(c) ? c : [c]))),
            ),
          )
        : h('tr', null, h('td', { colSpan: headers.length, class: 'empty' }, 'Nothing yet')),
    ),
  );
}
export function badge(text, kind = '') {
  return h('span', { class: `badge ${kind}` }, text);
}
