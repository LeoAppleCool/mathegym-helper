// Adds a Solve button next to every writable result field and keeps the buttons up to date
// when the task changes. Alt+L solves the current task from the keyboard.
(() => {
  'use strict';
  if (location.hostname !== 'mathegym.de' && !location.hostname.endsWith('.mathegym.de')) return;
  if (window.mathegymInlineController) { window.mathegymInlineController.refresh(); return; }
  // The extension (its own script world) and the bookmarklet (page context) cannot see each
  // other's variables; the marker on the document prevents duplicate buttons.
  const mode = globalThis.chrome?.runtime?.id ? 'extension' : 'bookmarklet';
  const active = document.documentElement.dataset.mathegymHelper;
  if (active && active !== mode) {
    window.mathegymMessage?.('The Mathegym Helper extension is already active on this page. Use the Solve buttons next to the fields.', { ai: false });
    return;
  }
  document.documentElement.dataset.mathegymHelper = mode;

  const entries = new Map();
  const unit = /^(?:s|min|h|d|mm|cm|dm|m|km|mg|g|kg|t|ml|cl|dl|l|ct|€|%|°|(?:mm|cm|dm|m|km)[²³])$/;
  let timer;
  function visible(field) {
    const style = getComputedStyle(field);
    return !field.disabled && !field.readOnly && !field.hidden && style.display !== 'none' && style.visibility !== 'hidden' && field.getClientRects().length > 0;
  }
  function plainText(element) {
    const copy = element.cloneNode(true);
    copy.querySelectorAll('[data-mathegym-action]').forEach(button => button.remove());
    return copy.textContent.trim();
  }
  function placement(field) {
    // Place buttons for radios and checkboxes outside the label so that a click does not select them.
    if (['radio', 'checkbox'].includes(field.type) && field.closest('label')) return { after: field.closest('label') };
    const cell = field.closest('td');
    const nextCell = cell?.nextElementSibling;
    if (nextCell && !nextCell.querySelector('input, textarea, select') && unit.test(plainText(nextCell))) {
      // Units are often inside a DIV in the table cell. Insert the button into that text
      // element so that it stays on the same line.
      let label = nextCell;
      while (true) {
        const children = [...label.children].filter(child => !child.hasAttribute('data-mathegym-action'));
        if (children.length !== 1 || !unit.test(plainText(children[0]))) break;
        label = children[0];
      }
      return { inside: label };
    }
    let next = field.nextSibling;
    while (next && (next.nodeType === Node.TEXT_NODE && !next.textContent.trim() || next.nodeType === Node.ELEMENT_NODE && next.hasAttribute('data-mathegym-action'))) next = next.nextSibling;
    if (next?.nodeType === Node.TEXT_NODE && unit.test(next.textContent.trim())) return { after: next };
    if (next?.nodeType === Node.ELEMENT_NODE && !next.querySelector('input, textarea, select') && unit.test(plainText(next))) return { after: next };
    return { after: field };
  }
  function refresh() {
    const body = document.getElementById('exBody');
    const fields = body ? [...body.querySelectorAll('input, textarea, select')].filter(field =>
      !['hidden', 'submit', 'button', 'image', 'reset', 'password', 'file'].includes(field.type) && visible(field)) : [];
    const active = new Set(fields);
    for (const [field, button] of entries) if (!active.has(field)) { button.remove(); entries.delete(field); }
    for (const field of fields) {
      let button = entries.get(field);
      if (!button) {
        button = document.createElement('button');
        button.type = 'button';
        button.textContent = 'Solve';
        button.title = 'Solve the current task and fill in the results';
        button.setAttribute('aria-label', 'Solve current task');
        button.setAttribute('data-mathegym-action', 'solve');
        button.setAttribute('data-html2canvas-ignore', 'true');
        button.style.cssText = 'display:inline-block;vertical-align:middle;margin:0 0 0 8px;padding:3px 9px;border:1px solid #a44300;border-radius:5px;background:#c85000;color:#fff;font:600 13px/1.4 system-ui,sans-serif;cursor:pointer;white-space:nowrap';
        button.addEventListener('click', event => {
          event.preventDefault(); event.stopPropagation();
          if (!field.isConnected || !document.getElementById('exBody')?.contains(field)) return;
          if (typeof window.mathegymSolve === 'function') window.mathegymSolve();
        });
        entries.set(field, button);
      }
      const target = placement(field);
      if (target.inside) { if (button.parentElement !== target.inside) target.inside.append(button); }
      else if (button.previousSibling !== target.after) target.after.after(button);
    }
  }
  const observer = new MutationObserver(records => {
    const relevant = records.some(record => {
      if (record.target.nodeType === Node.ELEMENT_NODE && record.target.closest('#mathegym-helper-ai, #mathegym-helper-status, [data-mathegym-action]')) return false;
      if ([...record.removedNodes].some(node => node.nodeType === Node.ELEMENT_NODE && !node.isConnected && [...entries.values()].includes(node))) return true;
      const changed = [...record.addedNodes, ...record.removedNodes];
      return record.type === 'attributes' || changed.some(node => node.nodeType !== Node.ELEMENT_NODE || !node.hasAttribute('data-mathegym-action'));
    });
    if (relevant && !timer) timer = setTimeout(() => { timer = undefined; refresh(); }, 60);
  });
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['disabled', 'readonly', 'hidden', 'style', 'class'] });
  // On a Mac, Alt+L types the @ sign on German keyboards, so the shortcut stays off there.
  if (!/Mac|iPhone|iPad/.test(navigator.platform)) document.addEventListener('keydown', event => {
    if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.repeat || event.code !== 'KeyL') return;
    if (!entries.size || typeof window.mathegymSolve !== 'function') return;
    event.preventDefault();
    window.mathegymSolve();
  }, true);
  window.mathegymInlineController = { refresh, observer };
  refresh();
})();
