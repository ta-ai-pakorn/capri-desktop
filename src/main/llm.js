'use strict';

// Who she talks with: Ollama, any OpenAI-compatible server (local, cloud, or a keyless gateway),
// or Claude Code itself (headless `claude -p`, so your messages become its prompts).
// Keys come from config.json's `apiKeys` ({ openai: "sk-..." }) or the provider's env variable.

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const ollama = require('./ollama');

const PROVIDERS = {
  ollama: { label: 'Ollama (local)', kind: 'ollama', local: true },
  lmstudio: { label: 'LM Studio (local)', url: 'http://127.0.0.1:1234/v1', local: true },
  llamacpp: { label: 'llama.cpp / vLLM (local :8080)', url: 'http://127.0.0.1:8080/v1', local: true },
  pollinations: {
    label: 'Pollinations (no key)', url: 'https://text.pollinations.ai/openai', modelsUrl: 'https://text.pollinations.ai/models',
  },
  openrouter: { label: 'OpenRouter', url: 'https://openrouter.ai/api/v1', env: 'OPENROUTER_API_KEY' },
  openai: { label: 'OpenAI', url: 'https://api.openai.com/v1', env: 'OPENAI_API_KEY' },
  groq: { label: 'Groq', url: 'https://api.groq.com/openai/v1', env: 'GROQ_API_KEY' },
  gemini: { label: 'Google Gemini', url: 'https://generativelanguage.googleapis.com/v1beta/openai', env: 'GEMINI_API_KEY' },
  deepseek: { label: 'DeepSeek', url: 'https://api.deepseek.com/v1', env: 'DEEPSEEK_API_KEY' },
  mistral: { label: 'Mistral', url: 'https://api.mistral.ai/v1', env: 'MISTRAL_API_KEY' },
  custom: { label: 'Custom (customUrl in config)' },
  claude: { label: 'Claude Code (sends to the terminal agent)', kind: 'claude' },
  agy: { label: 'Antigravity (agy, your Google sign-in)', kind: 'agy' },
};

// no bypassPermissions: a chat bubble on the desktop shouldn't run anything without asking
const CLAUDE_MODES = ['default', 'acceptEdits'];
// the models her Claude Code chat can use: its own default, then the aliases (always the newest of each)
const CLAUDE_MODELS = ['Claude Code', 'fable', 'opus', 'sonnet', 'haiku'];

function endpoint(id, cfg) {
  const p = PROVIDERS[id];
  const url = (id === 'custom' ? cfg.customUrl : p.url) || '';
  const key = cfg.apiKeys?.[id] || (p.env && process.env[p.env]) || '';
  return { ...p, url: url.replace(/\/+$/, ''), key };
}

const headers = (key) => ({ 'content-type': 'application/json', ...(key && { authorization: `Bearer ${key}` }) });

// Why a server said no, in a sentence (Gemini sends its error inside an array), with a code when it's
// worth another try: 'busy' (too many people on it right now), 'gone' (that model isn't served anymore).
async function failure(res) {
  const body = await res.text().catch(() => '');
  let message = body.slice(0, 200) || `answered ${res.status}`;
  try {
    const parsed = JSON.parse(body);
    const err = (Array.isArray(parsed) ? parsed[0] : parsed)?.error;
    if (err) message = typeof err === 'string' ? err : err.message || message;
  } catch {
    // not JSON: the start of the body says it
  }
  const code = res.status === 429 || res.status === 503 || /overloaded|high demand|unavailable/i.test(message) ? 'busy'
    : res.status === 404 ? 'gone' : null;
  return Object.assign(new Error(message), { status: res.status, code });
}

// Gemini lists every model it has (embeddings, speech, images…): only the ones to chat with, a current
// stable Flash first (older ones get closed to new keys, previews come and go).
function geminiModels(names) {
  const version = (n) => Number(/gemini-(\d+(?:\.\d+)?)/.exec(n)?.[1] || 0);
  const rank = (n) => (/preview|exp/.test(n) ? 4 : 0) + (/flash-lite/.test(n) ? 1 : /flash/.test(n) ? 0 : 2);
  return names
    .filter((n) => /gemini/.test(n) && !/embed|tts|image|audio|live|veo|imagen|computer-use|robotics|aqa/.test(n))
    .sort((a, b) => rank(a) - rank(b) || version(b) - version(a));
}

// The provider's models by name; null when it can't be reached (Ollama only), throws with why otherwise.
async function models(id, cfg) {
  const p = endpoint(id, cfg);
  if (p.kind === 'ollama') return ollama.models().catch(() => null);
  if (p.kind === 'claude') return claudeVersion().then(() => CLAUDE_MODELS);
  if (p.kind === 'agy') return agyModels();
  // what's missing has a code, so her setup knows what to ask for (setup.js)
  if (!p.url) throw Object.assign(new Error('no address set for this server'), { code: 'nourl' });
  if (p.env && !p.key) throw Object.assign(new Error(`no API key (or ${p.env})`), { code: 'nokey' });
  const res = await fetch(p.modelsUrl || `${p.url}/models`, { headers: headers(p.key), signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw await failure(res);
  const body = await res.json();
  const list = Array.isArray(body) ? body : body.data || body.models || [];
  const names = list.map((m) => (typeof m === 'string' ? m : m.id || m.name)).filter(Boolean);
  return id === 'gemini' ? geminiModels(names) : names;
}

function warm(id, model) {
  if (PROVIDERS[id].kind === 'ollama') ollama.warm(model);
}

// OpenAI-style streaming (server-sent events): onDelta(piece) as it comes, resolves with all of it.
async function openaiChat(p, { model, messages }, onDelta, signal) {
  const res = await fetch(`${p.url}/chat/completions`, {
    method: 'POST',
    headers: headers(p.key),
    body: JSON.stringify({ model, messages, stream: true }),
    signal,
  });
  if (!res.ok) throw await failure(res);
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return text;
      const msg = JSON.parse(data);
      if (msg.error) throw new Error(msg.error.message || msg.error);
      const piece = msg.choices?.[0]?.delta?.content || ''; // reasoning comes apart, and is left out
      if (piece) {
        text += piece;
        onDelta(piece);
      }
    }
  }
  return text;
}

// --- Claude Code ---------------------------------------------------------------------------------
// The prompt goes in on stdin, never on the command line: the shell (needed for an npm claude.cmd)
// only ever sees fixed arguments.

const quote = (s) => (process.platform === 'win32' ? `"${s}"` : s); // cmd joins the arguments
// its session id, picked here so her hooks can tell its events from your other sessions' (main.js)
let claudeSession = null;
let claudeStarted = false; // each message after the first continues the same conversation

function claudeVersion() {
  return new Promise((resolve, reject) => {
    execFile('claude', ['--version'], { shell: process.platform === 'win32', timeout: 10000 }, (err, out) => (
      err ? reject(new Error('Claude Code not found (is `claude` on your PATH?)')) : resolve(out.trim())));
  });
}

function claudeChat(cfg, text, persona, onDelta, signal, model) {
  // her persona, from a file: too long and too full of quotes and newlines for cmd's command line
  const personaFile = path.join(os.tmpdir(), 'capri-persona.txt');
  fs.writeFileSync(personaFile, persona);
  // --safe-mode: no CLAUDE.md, plugins or hooks of yours, so she answers as herself, not as your own setup
  const args = ['-p', '--safe-mode', '--output-format', 'stream-json', '--verbose',
    '--permission-mode', CLAUDE_MODES.includes(cfg.claudeMode) ? cfg.claudeMode : 'default',
    '--append-system-prompt-file', quote(personaFile)];
  if (model && model !== 'Claude Code') args.push('--model', model);
  if (!claudeSession) claudeSession = randomUUID();
  args.push(claudeStarted ? '--resume' : '--session-id', claudeSession);
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, {
      cwd: cfg.claudeCwd || os.homedir(),
      shell: process.platform === 'win32',
      windowsHide: true,
    });
    const kill = () => (process.platform === 'win32'
      ? execFile('taskkill', ['/pid', String(child.pid), '/t', '/f'], () => {})
      : child.kill());
    signal.addEventListener('abort', kill, { once: true });
    let buffer = '';
    let all = '';
    let result = null;
    let errors = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        claudeStarted = true;
        if (msg.type === 'assistant') {
          for (const block of msg.message?.content || []) {
            if (block.type !== 'text' || !block.text) continue;
            const piece = (all ? '\n' : '') + block.text;
            all += piece;
            onDelta(piece);
          }
        } else if (msg.type === 'result') {
          result = msg;
        }
      }
    });
    child.stderr.on('data', (chunk) => { errors += chunk; });
    child.stdin.end(text);
    child.on('error', reject);
    child.on('close', () => {
      if (signal.aborted) return reject(new Error('stopped'));
      if (result?.is_error) return reject(new Error(result.result || 'Claude Code failed'));
      if (!result) return reject(new Error(errors.trim().slice(0, 300) || 'Claude Code gave no answer'));
      resolve(result.result || all);
    });
  });
}

// --- Antigravity (agy) ---------------------------------------------------------------------------
// Headless `agy -p`, signed in with the user's own Google account: no key. It's an agent, so it runs
// in plan mode, in a sandbox, in an empty folder of its own, with slash commands off: it only talks.
// Each answer is one fresh prompt carrying her persona and the recent chat (her own memory, not agy's).

const AGY_DIR = path.join(os.tmpdir(), 'capri-agy');

function agyPath() {
  const local = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe');
  return local && fs.existsSync(local) ? local : 'agy';
}

function agyRun(args, { signal, timeout } = {}) {
  return new Promise((resolve, reject) => {
    const exe = agyPath();
    fs.mkdirSync(AGY_DIR, { recursive: true });
    const child = spawn(exe, args, { cwd: AGY_DIR, windowsHide: true, shell: exe === 'agy' && process.platform === 'win32' });
    let out = '';
    let errors = '';
    const kill = () => (process.platform === 'win32'
      ? execFile('taskkill', ['/pid', String(child.pid), '/t', '/f'], () => {})
      : child.kill());
    signal?.addEventListener('abort', kill, { once: true });
    const timer = timeout ? setTimeout(kill, timeout) : null;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { errors += chunk; });
    child.on('error', () => reject(new Error('Antigravity CLI not found (is `agy` installed?)')));
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (signal?.aborted) return reject(new Error('stopped'));
      resolve({ code, out, errors });
    });
  });
}

// No --effort: agy's model names carry it (gemini-4-hydrogen-medium is Hydrogen at Medium).
// Its models, the quick ones first: a desktop chat wants a fast answer more than a deep one
async function agyModels() {
  const { code, out, errors } = await agyRun(['models'], { timeout: 30000 });
  const names = out.split('\n').map((l) => l.split('\t')[0].trim()).filter((n) => /^[a-z0-9][\w.-]+$/i.test(n));
  if (code !== 0 || !names.length) throw new Error(errors.trim().slice(0, 300) || 'agy listed no models');
  const rank = (n) => (/flash/.test(n) ? 0 : /sonnet/.test(n) ? 1 : 2) + (/-low$/.test(n) ? 0 : /-medium$/.test(n) ? 0.1 : 0.2);
  return names.sort((a, b) => rank(a) - rank(b));
}

async function agyChat(model, messages, onDelta, signal) {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  const talk = messages.filter((m) => m.role !== 'system');
  const last = talk.pop();
  // Windows caps a command line near 32k characters: the oldest messages go first
  const lines = talk.map((m) => `${m.role === 'assistant' ? 'Capri' : 'User'}: ${m.content}`);
  while (lines.length && system.length + (last?.content || '').length + lines.join('\n').length > 22000) lines.shift();
  const said = lines.join('\n');
  const prompt = [
    'You are only playing a character in a desktop chat bubble. Do not use any tools, do not read or write files, do not run commands: just answer with her reply text, nothing else.',
    '', '# Who you are and how you talk', system,
    ...(said ? ['', '# The conversation so far', said] : []),
    '', '# The user just said', last?.content || '',
    '', 'Your reply, as her, plain text only:',
  ].join('\n');
  const args = ['-p', prompt, '--output-format', 'json', '--mode', 'plan', '--sandbox', '--disable-slash-commands',
    '--print-timeout', '120s', ...(model ? ['--model', model] : [])];
  const { out, errors } = await agyRun(args, { signal, timeout: 130000 });
  let result = null;
  try { result = JSON.parse(out.trim().split('\n').filter(Boolean).at(-1)); } catch { /* not JSON: say why below */ }
  if (!result) throw new Error(errors.trim().slice(0, 300) || out.trim().slice(0, 300) || 'Antigravity gave no answer');
  if (result.status !== 'SUCCESS' || !result.response) throw new Error(result.error || result.message || `Antigravity: ${result.status || 'no answer'}`);
  const text = String(result.response).trim();
  onDelta(text);
  return text;
}

function resetClaude() {
  claudeSession = null;
  claudeStarted = false;
}

// Claude Code's conversation, to save and pick up again after a restart.
const claudeMemory = () => ({ session: claudeSession, started: claudeStarted });
function restoreClaude(saved) {
  claudeSession = saved?.session || null;
  claudeStarted = Boolean(claudeSession && saved.started);
}

const isChatSession = (id) => Boolean(id) && id === claudeSession;
// agy's events, if her hooks are in it: her chat runs in a folder of its own, so they're told apart by it
const isChatFolder = (cwd) => Boolean(cwd) && path.resolve(String(cwd)).toLowerCase() === AGY_DIR.toLowerCase();

async function chat(id, cfg, { model, messages }, onDelta, signal) {
  const p = endpoint(id, cfg);
  if (p.kind === 'ollama') return ollama.chat({ model, messages }, onDelta, signal);
  // Claude Code keeps its own memory of the conversation: only her persona and your last message go
  if (p.kind === 'claude') return claudeChat(cfg, messages.at(-1).content, messages[0].content, onDelta, signal, model);
  if (p.kind === 'agy') return agyChat(model, messages, onDelta, signal);
  return openaiChat(p, { model, messages }, onDelta, signal);
}

// Whether her answers stay on this PC: a server on this machine (and with Ollama, not a cloud model).
function isLocal(id, cfg, model) {
  if (id === 'ollama') {
    return !ollama.isCloud(model) && /^(https?:\/\/)?(127\.0\.0\.1|localhost|0\.0\.0\.0|\[?::1\]?)(:|\/|$)/.test(process.env.OLLAMA_HOST || '127.0.0.1');
  }
  if (id === 'custom') return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(cfg.customUrl || '');
  return Boolean(PROVIDERS[id].local);
}

module.exports = { isLocal, PROVIDERS, CLAUDE_MODES, models, warm, chat, resetClaude, isChatSession, isChatFolder, claudeMemory, restoreClaude };
