// setup.sh (Linux) and setup.ps1 / setup.cmd (Windows): optional app-menu and desktop shortcuts,
// plus the page address printed and copied. Runs in a throwaway HOME with stub desktop tools,
// so nothing touches the real desktop, menu or clipboard.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const BASH = ['/usr/bin/bash', '/bin/bash'].find(file => fs.existsSync(file));
const needBash = BASH && process.platform !== 'win32' ? {} : { skip: 'needs bash on Linux or macOS' };
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'launchpad-setup-'));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const ID = 'launchpad-startup-map';
function world() {
  const base = fs.mkdtempSync(path.join(scratch, 'w-'));
  const home = path.join(base, 'home'), site = path.join(base, 'My Apps', 'launch pad'), bin = path.join(base, 'bin');
  for (const dir of [home, path.join(home, 'Desktop'), site, bin]) fs.mkdirSync(dir, { recursive: true });
  for (const file of ['index.html', 'setup.sh']) if (fs.existsSync(path.join(root, file))) fs.copyFileSync(path.join(root, file), path.join(site, file));
  const stub = (name, body) => fs.writeFileSync(path.join(bin, name), '#!/bin/sh\n' + body + '\n', { mode: 0o755 });
  stub('xdg-user-dir', 'echo "$HOME/Desktop"');
  stub('wl-copy', 'cat > "$HOME/clipboard"');
  stub('update-desktop-database', 'echo "$@" >> "$HOME/refreshed"');
  stub('kbuildsycoca6', 'echo kbuildsycoca6 >> "$HOME/refreshed"');
  const data = path.join(home, '.local', 'share');
  return {
    home, site, data,
    menu: path.join(data, 'applications', ID + '.desktop'),
    icon: path.join(data, 'icons', 'hicolor', 'scalable', 'apps', ID + '.svg'),
    desk: path.join(home, 'Desktop', ID + '.desktop'),
    run(args, answers) {
      const result = spawnSync(BASH, [path.join(site, 'setup.sh'), ...args], {
        input: answers, encoding: 'utf8',
        env: { HOME: home, PATH: bin + ':/usr/bin:/bin', LANG: 'C.UTF-8' }
      });
      assert.equal(result.error, undefined);
      return result;
    }
  };
}
const exists = file => fs.existsSync(file);
const pageUrl = site => 'file://' + site.split('/').map(part => encodeURIComponent(part)).join('/') + '/index.html';
function favicon() {
  const href = fs.readFileSync(path.join(root, 'index.html'), 'utf8').match(/<link rel="icon" href="data:image\/svg\+xml,([^"]+)">/)[1];
  return decodeURIComponent(href);
}

test('setup.sh passes bash -n', needBash, () => {
  assert.ok(exists(path.join(root, 'setup.sh')), 'setup.sh exists beside the page');
  const result = spawnSync(BASH, ['-n', path.join(root, 'setup.sh')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('setup.sh with no answers adds nothing, prints the address and copies it', needBash, () => {
  const w = world();
  const result = w.run([], '');
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(pageUrl(w.site)), 'prints the percent-encoded file:// address');
  assert.equal(fs.readFileSync(path.join(w.home, 'clipboard'), 'utf8'), pageUrl(w.site), 'copies exactly the address');
  assert.match(result.stdout, /Ctrl\+D/, 'suggests a bookmark');
  for (const file of [w.menu, w.icon, w.desk]) assert.ok(!exists(file), file + ' not written without a yes');
});

test('setup.sh yes, yes adds a valid menu entry, its icon and a launchable desktop shortcut', needBash, () => {
  const w = world();
  const result = w.run([], 'y\ny\n');
  assert.equal(result.status, 0, result.stderr);
  for (const file of [w.menu, w.icon, w.desk]) assert.ok(exists(file), file + ' written');
  const entry = fs.readFileSync(w.menu, 'utf8');
  assert.ok(entry.includes('Exec=xdg-open "' + path.join(w.site, 'index.html') + '"\n'), 'Exec opens this page, quoted');
  assert.match(entry, new RegExp('^Icon=' + ID + '$', 'm'));
  assert.match(entry, /^Name=Startclip$/m, 'the menu shows the public name');
  assert.match(entry, /^X-Launchpad-Setup=1$/m, 'marked as made by setup.sh');
  assert.equal(fs.readFileSync(w.desk, 'utf8'), entry, 'the desktop shortcut is the same entry');
  assert.ok(fs.statSync(w.desk).mode & 0o100, 'the desktop shortcut is executable (Plasma launches only those)');
  assert.ok(fs.readFileSync(w.icon, 'utf8').startsWith(favicon()), 'the icon is the page favicon');
  assert.ok(fs.readFileSync(path.join(w.home, 'refreshed'), 'utf8').includes('kbuildsycoca6'), 'the menu is refreshed');
  const validate = spawnSync('desktop-file-validate', [w.menu], { encoding: 'utf8' });
  if (!validate.error) assert.equal(validate.status, 0, validate.stdout + validate.stderr);
  assert.equal(w.run([], 'y\ny\n').status, 0, 'a second run rewrites its own files');
});

test('setup.sh updates an entry made before the rename in place', needBash, () => {
  const w = world();
  fs.mkdirSync(path.dirname(w.menu), { recursive: true });
  fs.writeFileSync(w.menu, '[Desktop Entry]\nName=Launchpad\nX-Launchpad-Setup=1\n');
  assert.equal(w.run([], 'y\nn\n').status, 0);
  assert.match(fs.readFileSync(w.menu, 'utf8'), /^Name=Startclip$/m);
});

test('setup.sh --dry-run writes and copies nothing', needBash, () => {
  const w = world();
  const result = w.run(['--dry-run'], 'y\ny\n');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /would write/i);
  for (const file of [w.menu, w.icon, w.desk, path.join(w.home, 'clipboard')]) assert.ok(!exists(file), file + ' untouched');
});

test('setup.sh never overwrites or removes a file it did not make', needBash, () => {
  const w = world();
  fs.mkdirSync(path.dirname(w.menu), { recursive: true });
  fs.writeFileSync(w.menu, '[Desktop Entry]\nName=Someone else\n');
  const result = w.run([], 'y\nn\n');
  assert.match(result.stdout + result.stderr, /not made by setup\.sh/);
  assert.equal(fs.readFileSync(w.menu, 'utf8'), '[Desktop Entry]\nName=Someone else\n');
  assert.equal(w.run(['--uninstall'], '').status, 0);
  assert.equal(fs.readFileSync(w.menu, 'utf8'), '[Desktop Entry]\nName=Someone else\n', 'uninstall keeps it too');
});

test('setup.sh --uninstall removes exactly what it added', needBash, () => {
  const w = world();
  w.run([], 'y\ny\n');
  fs.writeFileSync(path.join(w.home, 'Desktop', 'notes.txt'), 'keep');
  const result = w.run(['--uninstall'], '');
  assert.equal(result.status, 0, result.stderr);
  for (const file of [w.menu, w.icon, w.desk]) assert.ok(!exists(file), file + ' removed');
  assert.ok(exists(path.join(w.home, 'Desktop', 'notes.txt')));
});

test('Windows: setup.cmd runs setup.ps1 past the script policy, and setup.ps1 mirrors the Linux steps', () => {
  const cmd = fs.readFileSync(path.join(root, 'setup.cmd'), 'utf8');
  assert.match(cmd, /\r\n/, 'setup.cmd keeps CRLF line endings');
  assert.match(cmd, /powershell(\.exe)? -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup\.ps1" %\*/i);
  const ps = fs.readFileSync(path.join(root, 'setup.ps1'), 'utf8');
  for (const needle of ['[switch]$DryRun', '[switch]$Uninstall', 'Set-Clipboard', 'WScript.Shell', 'assets\\startclip.ico', 'Startclip.lnk', 'Launchpad.lnk',
                        "GetFolderPath('Desktop')", 'Start Menu\\Programs', 'AbsoluteUri', 'Ctrl+D'])
    assert.ok(ps.includes(needle), 'setup.ps1 has ' + needle);
  for (const file of ['startclip.ico', 'startclip.ico.source'])
    assert.ok(exists(path.join(root, 'assets', file)), 'assets/' + file + ' exists (node tools/make-icon.cjs)');
  assert.ok(!/Invoke-Expression|iex\s|DownloadString|Start-Process\s+-Verb\s+RunAs/i.test(ps), 'no eval, download or elevation');
  const pwsh = ['pwsh', 'powershell'].map(bin => spawnSync(bin, ['-NoProfile', '-Command', '$null'], { encoding: 'utf8' })).find(r => !r.error);
  if (pwsh) {
    const parse = spawnSync('pwsh', ['-NoProfile', '-Command',
      `$e=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('${path.join(root, 'setup.ps1')}',[ref]$null,[ref]$e);if($e){$e|%{$_.Message};exit 1}`], { encoding: 'utf8' });
    assert.equal(parse.status, 0, parse.stdout + parse.stderr);
  }
});
