// Local solver for simple tasks (fractions of quantities, percentages, unit conversions). It
// calculates exactly with BigInt and sends nothing to an AI service; the AI panel handles the rest.
(() => {
  'use strict';

  function message(text, { ai = true } = {}) {
    document.getElementById('mathegym-helper-status')?.remove();
    const box = document.createElement('div');
    box.id = 'mathegym-helper-status';
    box.setAttribute('role', 'status');
    box.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483647;max-width:380px;padding:18px;background:#fff;color:#172d35;border:2px solid #5c7b85;border-radius:10px;box-shadow:0 6px 30px #0003;font:16px/1.5 system-ui;white-space:pre-wrap';
    const content = document.createElement('div');
    content.textContent = text;
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = 'Close';
    close.style.cssText = 'margin-top:12px;padding:6px 12px;cursor:pointer';
    close.addEventListener('click', () => box.remove());
    box.append(content, close);
    if (ai && window.mathegymOpenAI && (location.hostname === 'mathegym.de' || location.hostname.endsWith('.mathegym.de'))) {
      const ai = document.createElement('button');
      ai.type = 'button'; ai.textContent = 'Solve with AI';
      ai.style.cssText = close.style.cssText + ';margin-left:8px';
      ai.addEventListener('click', () => window.mathegymOpenAI());
      box.append(ai);
    }
    document.body.append(box);
  }

  function gcd(a, b) {
    a = a < 0n ? -a : a;
    while (b) [a, b] = [b, a % b];
    return a;
  }

  function decimal(value) {
    const normalized = value.replace(',', '.');
    const places = normalized.includes('.') ? normalized.split('.')[1].length : 0;
    return [BigInt(normalized.replace('.', '')), 10n ** BigInt(places)];
  }

  function quantity(value) {
    const mixed = value.match(/^([+-]?\d+)\s+(\d+)\s*\/\s*(\d+)$/);
    const fraction = value.match(/^([+-]?\d+)\s*\/\s*(\d+)$/);
    if (mixed) {
      const [, whole, top, bottom] = mixed;
      const denominator = BigInt(bottom);
      if (!denominator) throw new Error('The denominator must not be zero.');
      const sign = whole.startsWith('-') ? -1n : 1n;
      const absoluteWhole = BigInt(whole.replace(/^[+-]/, ''));
      return [sign * (absoluteWhole * denominator + BigInt(top)), denominator];
    }
    if (fraction) {
      const denominator = BigInt(fraction[2]);
      if (!denominator) throw new Error('The denominator must not be zero.');
      return [BigInt(fraction[1]), denominator];
    }
    return decimal(value);
  }

  // Mathegym expects German number formatting, so the result uses a decimal comma.
  function format(numerator, denominator) {
    const common = gcd(numerator, denominator);
    numerator /= common;
    denominator /= common;
    let remainder = denominator;
    for (const factor of [2n, 5n]) while (remainder % factor === 0n) remainder /= factor;
    if (remainder !== 1n) throw new Error('The result is a repeating decimal, which the local solver does not support.');
    const negative = numerator < 0n;
    if (negative) numerator = -numerator;
    let answer = String(numerator / denominator);
    let rest = numerator % denominator;
    if (rest) answer += ',';
    let places = 0;
    while (rest) {
      if (++places > 12) throw new Error('The result has too many decimal places.');
      rest *= 10n;
      answer += String(rest / denominator);
      rest %= denominator;
    }
    return (negative ? '-' : '') + answer;
  }

  // All factors are integers (seconds, millimetres, milligrams, millilitres and cents),
  // so the calculation stays exact.
  const units = {
    s: ['time', 1n], min: ['time', 60n], h: ['time', 3600n], d: ['time', 86400n],
    mm: ['length', 1n], cm: ['length', 10n], dm: ['length', 100n], m: ['length', 1000n], km: ['length', 1000000n],
    mg: ['mass', 1n], g: ['mass', 1000n], kg: ['mass', 1000000n], t: ['mass', 1000000000n],
    ml: ['volume', 1n], cl: ['volume', 10n], dl: ['volume', 100n], l: ['volume', 1000n],
    ct: ['money', 1n], '€': ['money', 100n]
  };

  // Returns the result or throws an error explaining why the task cannot be solved locally.
  function localSolve() {
    const body = document.getElementById('exBody');
    if (!body) throw new Error('The task area was not found. Open a Mathegym task first.');
    const fields = [...body.querySelectorAll('input.ergebniseingabe')];
    if (fields.length !== 1 || fields[0].disabled || fields[0].readOnly) {
      throw new Error('The local solver only handles tasks with exactly one writable result field.');
    }
    const field = fields[0];
    const copy = body.cloneNode(true);
    copy.querySelectorAll('[data-mathegym-action]').forEach(button => button.remove());
    if (copy.querySelector('mjx-container, math, img, canvas, svg')) {
      throw new Error('The local solver does not support this task layout.');
    }

    // Mathegym renders fractions as two DIVs separated by a fraction bar.
    for (const element of [...copy.querySelectorAll('div')]) {
      const children = [...element.children];
      if (children.length !== 2 || children[0].style.borderBottomStyle !== 'solid') continue;
      const top = children[0].textContent.trim();
      const bottom = children[1].textContent.trim();
      if (/^\d+$/.test(top) && /^\d+$/.test(bottom)) {
        element.replaceWith(document.createTextNode(` ${top}/${bottom} `));
      }
    }
    copy.querySelector('input.ergebniseingabe').replaceWith(document.createTextNode(' __ANSWER__ '));
    if (copy.querySelector('input, textarea, select, button')) throw new Error('The task contains additional fields or controls.');
    const walker = document.createTreeWalker(copy, NodeFilter.SHOW_TEXT);
    const parts = [];
    while (walker.nextNode()) parts.push(walker.currentNode.textContent);
    const expression = parts.join(' ').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
    // The tasks are German: "3/4 von 48 kg" means "3/4 of 48 kg".
    const number = '([+-]?(?:\\d+\\s+\\d+\\s*/\\s*\\d+|\\d+\\s*/\\s*\\d+|\\d+(?:[.,]\\d+)?))';
    const unit = '(s|min|h|d|mm|cm|dm|m|km|mg|g|kg|t|ml|cl|dl|l|ct|€)';
    const end = `\\s*=\\s*__ANSWER__\\s*${unit}$`;
    const portion = expression.match(new RegExp(`^${number}\\s+von\\s+${number}\\s*${unit}${end}`));
    const percent = expression.match(new RegExp(`^${number}\\s*%\\s+von\\s+${number}\\s*${unit}${end}`));
    const conversion = expression.match(new RegExp(`^${number}\\s*${unit}${end}`));
    let n, den, from, to, calculation;
    if (portion) {
      const [, share, amount, source, target] = portion;
      const [an, ad] = quantity(share);
      const [qn, qd] = quantity(amount);
      n = an * qn;
      den = ad * qd;
      from = source; to = target;
      calculation = `${share} × ${amount} ${from}`;
    } else if (percent) {
      const [, p, amount, source, target] = percent;
      const [pn, pd] = quantity(p);
      const [qn, qd] = quantity(amount);
      n = pn * qn; den = pd * 100n * qd;
      from = source; to = target;
      calculation = `${p}/100 × ${amount} ${from}`;
    } else if (conversion) {
      const [, amount, source, target] = conversion;
      [n, den] = quantity(amount);
      from = source; to = target;
      calculation = `${amount} ${from}`;
    } else {
      throw new Error('The local solver does not support this task type. It handles fractions of quantities, mixed numbers, percentages and unit conversions with one result field.');
    }
    if (units[from][0] !== units[to][0]) throw new Error('The two units are not compatible.');
    return { field, answer: format(n * units[from][1], den * units[to][1]), to, calculation };
  }

  function solve() {
    const onMathegym = location.hostname === 'mathegym.de' || location.hostname.endsWith('.mathegym.de');
    try {
      if (!onMathegym) throw new Error('Open a task on mathegym.de first and click the bookmarklet there.');
      const { field, answer, to, calculation } = localSolve();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, answer);
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.dispatchEvent(new Event('change', { bubbles: true }));
      field.focus();
      message(`Filled in ${answer} ${to}.\n\nCalculation: ${calculation} = ${answer} ${to}\n\nYou can now click "Ergebnis prüfen".`);
    } catch (error) {
      // Not solvable locally: the AI takes over; the local reason would only confuse here.
      if (onMathegym && window.mathegymOpenAI && document.getElementById('exBody')) window.mathegymOpenAI({ autoSolve: true });
      else message(error.message || 'The task could not be read.');
    }
  }
  window.mathegymMessage = message;
  window.mathegymSolve = solve;
  if (!window.mathegymInstallOnly) solve();
})();
