#!/usr/bin/env node
'use strict';

// One-step setup for the Thai version, after `npm install`:
//   1. Capri speaks Thai, and does not close other AIs' browser tabs (her config)
//   2. her hooks go into Claude Code's settings.json (a backup is made first)
//   3. a "Capri" shortcut on the desktop (Windows)
//
//   node scripts/setup-thai.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const say = (line) => console.log(line);

// 1. her settings: where Electron keeps them for this app (its package name)
function appDataDir() {
  if (process.platform === 'win32') return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support');
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}
const configFile = path.join(appDataDir(), 'capri-desktop', 'config.json');
let config = {};
try { config = JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch { /* first run */ }
config.lang = 'th';
if (config.closePages === undefined) config.closePages = false; // a choice made later in her menu is kept
fs.mkdirSync(path.dirname(configFile), { recursive: true });
fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
say(`✓ ตั้งภาษาไทย และปิดการปิดแท็บ AI อื่นแล้ว (${configFile})`);

// 2. her hooks in Claude Code
try {
  const r = require('./install-hooks').install();
  say(`✓ ติดตั้ง hook ใน ${r.file} แล้ว (สำรองไฟล์เดิมไว้ก่อนแก้)`);
} catch (err) {
  say(`✗ ติดตั้ง hook ไม่สำเร็จ: ${err.message}`);
}

// 3. a desktop shortcut that opens her without a terminal
if (process.platform === 'win32') {
  // from plain Node, require('electron') gives the path to its program, downloading it first if
  // `npm install` left that for the first launch
  let exe = null;
  try { exe = require(path.join(ROOT, 'node_modules', 'electron')); } catch { /* not installed */ }
  if (!exe || !fs.existsSync(exe)) {
    say('✗ ยังไม่เจอ Electron: รัน npm install ก่อน แล้วค่อยรันไฟล์นี้อีกครั้ง');
  } else {
    const ps = [
      "$desk = [Environment]::GetFolderPath('Desktop')",
      '$s = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $desk "Capri.lnk"))',
      `$s.TargetPath = '${exe}'`,
      `$s.Arguments = '"${ROOT}"'`,
      `$s.WorkingDirectory = '${ROOT}'`,
      `$s.IconLocation = '${path.join(ROOT, 'assets', 'icons', 'capri.ico')}'`,
      '$s.Save()',
    ].join('; ');
    const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
    say(r.status === 0 ? '✓ สร้าง shortcut "Capri" บน Desktop แล้ว' : `✗ สร้าง shortcut ไม่สำเร็จ: ${r.stderr.trim()}`);
  }
}

say('');
say('เหลือ 3 อย่างที่ต้องทำเอง:');
say('  1. เปิด Capri: ดับเบิลคลิก "Capri" บน Desktop (หรือ npm start)');
say('  2. ปิด Claude Code ให้สนิทแล้วเปิดใหม่ เพื่อให้ hook ทำงาน');
say('  3. ใส่ AI ให้แชต: คลิกขวาที่ Capri › โมเดล AI › ตั้งค่ากับเธอ… (เช่น Gemini key ฟรีจาก aistudio.google.com)');
