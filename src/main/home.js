'use strict';

// Where her settings live: a fixed folder in your home (~/.capri-desktop), not AppData.
// Started from inside a packaged Windows app (MSIX, like the Claude desktop app), anything written
// to AppData lands in that app's private copy of it: the same Capri opened from your desktop would
// find nothing there, and you couldn't find her settings in File Explorer either.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = path.join(os.homedir(), '.capri-desktop');
// what's hers to keep: settings (with your keys), her chat memory, the key that unlocks your keys
// (Chromium keeps it in "Local State", locked to your Windows account), and your own sounds
const KEEP = ['config.json', 'memory.json', 'Local State', 'sounds'];

// Her old folders, wherever they may be: AppData as this process sees it, and each packaged app's copy
function oldFolders(app) {
  const found = [path.join(app.getPath('appData'), 'capri-desktop')];
  const packages = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Packages');
  try {
    for (const pkg of fs.readdirSync(packages)) found.push(path.join(packages, pkg, 'LocalCache', 'Roaming', 'capri-desktop'));
  } catch { /* not Windows, or no packaged apps */ }
  return found.filter((dir) => fs.existsSync(path.join(dir, 'config.json')));
}

// The first time: her settings come along from the old folder last used
function migrate(app) {
  const from = oldFolders(app)
    .map((dir) => ({ dir, at: fs.statSync(path.join(dir, 'config.json')).mtimeMs }))
    .sort((a, b) => b.at - a.at)[0]?.dir;
  if (!from) return null;
  fs.mkdirSync(HOME, { recursive: true });
  for (const name of KEEP) {
    const src = path.join(from, name);
    if (fs.existsSync(src)) fs.cpSync(src, path.join(HOME, name), { recursive: true });
  }
  return from;
}

// Call before the app is ready, before anything reads userData.
function useSettingsHome(app) {
  let from = null;
  if (!fs.existsSync(path.join(HOME, 'config.json'))) {
    try { from = migrate(app); } catch (err) { console.error('[capri] could not bring her settings over:', err.message); }
  }
  fs.mkdirSync(HOME, { recursive: true });
  app.setPath('userData', HOME);
  if (from) console.log(`[capri] settings moved from ${from} to ${HOME}`);
  return HOME;
}

module.exports = { HOME, useSettingsHome };
