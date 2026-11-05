'use strict';
// What the browser suites share: finding Playwright and axe-core, and the checks that run inside the page.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CACHED_TOOLS = path.join(os.homedir(), '.cache', 'launchpad-test-tools', 'node_modules');
const TOOLS_DIR = path.resolve(process.env.LAUNCHPAD_TEST_TOOLS || (fs.existsSync(CACHED_TOOLS) ? CACHED_TOOLS : path.join(__dirname, '..', '..', 'node_modules')));

function resolveTool(request) {
  for (const candidate of [path.join(TOOLS_DIR, request), request]) {
    try { return require.resolve(candidate); } catch {}
  }
  return null;
}

// Runs in the page before its own scripts: records copies on window.__copied (all on window.__copies, the path on
// window.__copiedVia) in stub mode, and wraps document.execCommand('copy') the same way.
function clipboardHarness({ mode }) {
  const w = window;
  w.__copied = undefined;
  w.__copies = [];
  w.__copiedVia = null;
  const record = (text, via) => { w.__copied = String(text); w.__copies.push(String(text)); w.__copiedVia = via; };
  const execOriginal = Document.prototype.execCommand;
  const recordingExec = function (command, ...rest) {
    const active = document.activeElement;
    const result = execOriginal.call(this, command, ...rest);
    if (String(command).toLowerCase() === 'copy' && result) {
      const text = active && typeof active.value === 'string' && typeof active.selectionStart === 'number'
        ? active.value.slice(active.selectionStart, active.selectionEnd)
        : String(document.getSelection());
      record(text, 'execCommand');
    }
    return result;
  };
  const recordingWrite = async text => { record(text, 'clipboard'); };
  if (!navigator.clipboard) Object.defineProperty(navigator, 'clipboard', { value: {}, configurable: true });
  w.__restoreClipboard = () => {
    if (mode === 'stub') {
      Object.defineProperty(navigator.clipboard, 'writeText', { value: recordingWrite, writable: true, configurable: true });
      Object.defineProperty(document, 'execCommand', { value: recordingExec, writable: true, configurable: true });
    } else {
      delete navigator.clipboard.writeText;
      delete document.execCommand;
    }
  };
  w.__readCopied = async () => (mode === 'stub' ? w.__copied : navigator.clipboard.readText());
  if (mode === 'stub') w.__restoreClipboard();
}

// Runs in the page: resolves any CSS colour through a canvas and returns WCAG contrast helpers.
function installContrast() {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  window.__rgb = color => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = '#000'; ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); const d = ctx.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
  const channel = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  window.__lum = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  window.__ratio = (a, b) => { const [x, y] = [window.__lum(a), window.__lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  window.__bg = el => {
    for (let node = el; node; node = node.parentElement) { const c = window.__rgb(getComputedStyle(node).backgroundColor); if (c[3] > 0.99) return c; }
    return window.__rgb(getComputedStyle(document.body).backgroundColor);
  };
}

// Runs in the page after installContrast: names every visible text below WCAG AA.
function contrastFailures() {
  const failures = [];
  for (const el of document.querySelectorAll('body *')) {
    if (el.closest('.sr-only, [hidden], svg, script, style, noscript, [aria-disabled="true"], :disabled')) continue;
    if (!el.getClientRects().length || getComputedStyle(el).visibility === 'hidden') continue;
    if (!Array.from(el.childNodes).some(node => node.nodeType === 3 && node.textContent.trim())) continue;
    let opacity = 1;
    for (let node = el; node; node = node.parentElement) opacity *= parseFloat(getComputedStyle(node).opacity);
    if (opacity < 0.99) continue;
    const style = getComputedStyle(el), size = parseFloat(style.fontSize), large = size >= 24 || (parseInt(style.fontWeight, 10) >= 700 && size >= 18.66);
    const ratio = window.__ratio(window.__rgb(style.color), window.__bg(el));
    if (ratio < (large ? 3 : 4.5)) failures.push((el.id || String(el.className) || el.tagName) + ' ' + ratio.toFixed(2) + ':1 "' + el.textContent.trim().slice(0, 32) + '"');
  }
  return failures;
}

module.exports = { TOOLS_DIR, resolveTool, clipboardHarness, installContrast, contrastFailures };
