'use strict';

// Her world, as lore files you can edit (~/.capri-desktop/lore/*.md): one topic per file, and only the
// topics a message touches go into her prompt, so the lore can grow without every answer paying for
// all of it. `_core.md` always goes. Each topic file:
//
//   # Title
//   คำค้น: word, word, …      (or "keywords:"; Thai and English, matched anywhere in the text)
//   ---
//   what she knows
//
// Files are read on every message: an edit counts from the next one, no restart.

const fs = require('node:fs');
const path = require('node:path');
const { HOME } = require('./home');

const DIR = path.join(HOME, 'lore');
const DEFAULTS = path.join(__dirname, '..', '..', 'lore');
const MAX_TOPICS = 2;

// The first time: the lore that comes with her, copied where you can edit it
function seed() {
  if (fs.existsSync(DIR) || !fs.existsSync(DEFAULTS)) return;
  fs.mkdirSync(DIR, { recursive: true });
  for (const name of fs.readdirSync(DEFAULTS)) {
    if (name.endsWith('.md')) fs.copyFileSync(path.join(DEFAULTS, name), path.join(DIR, name));
  }
}

function parse(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  const [head, ...rest] = text.split(/^---\s*$/m);
  const body = rest.length ? rest.join('---').trim() : text.trim();
  const title = /^#\s*(.+)$/m.exec(head)?.[1]?.trim() || path.basename(file, '.md');
  const keys = (/^(?:คำค้น|keywords)\s*:\s*(.+)$/im.exec(head)?.[1] || '')
    .split(',').map((k) => k.trim().toLowerCase()).filter(Boolean);
  return { name: path.basename(file, '.md'), title, keys, body };
}

function read() {
  seed();
  let names = [];
  try { names = fs.readdirSync(DIR).filter((n) => n.endsWith('.md')); } catch { return { core: null, topics: [] }; }
  const all = names.map((n) => { try { return parse(path.join(DIR, n)); } catch { return null; } }).filter(Boolean);
  return { core: all.find((t) => t.name === '_core') || null, topics: all.filter((t) => t.name !== '_core') };
}

let turn = 0; // with nothing matched, one topic in turn: a newcomer still gets a taste of her world

// What goes into her prompt for this message: `text` is your message (with the last answer, for
// what you're both on about). Returns { text, picked: [names] }.
function forChat(text) {
  const { core, topics } = read();
  if (!core && !topics.length) return { text: '', picked: [] };
  const said = String(text || '').toLowerCase();
  // English words whole ("ai" isn't in "email"); Thai anywhere (no spaces between Thai words)
  const hit = (k) => (/^[\x20-\x7e]+$/.test(k)
    ? new RegExp(`(^|[^a-z0-9])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`).test(said)
    : said.includes(k));
  let picked = topics
    .map((t) => ({ t, score: t.keys.reduce((n, k) => n + (hit(k) ? 1 : 0), 0) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_TOPICS)
    .map((x) => x.t);
  if (!picked.length && topics.length) picked = [topics[turn++ % topics.length]];
  const parts = [];
  if (core) parts.push(`# Your world (Cyberpunk lore you know)\n${core.body}`);
  if (topics.length) parts.push(`Topics you know about: ${topics.map((t) => t.title).join(' · ')}`);
  for (const t of picked) parts.push(`## ${t.title}\n${t.body}`);
  return { text: parts.join('\n\n'), picked: picked.map((t) => t.name) };
}

module.exports = { DIR, forChat };
