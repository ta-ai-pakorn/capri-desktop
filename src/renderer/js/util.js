export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const rand = (a, b) => a + Math.random() * (b - a);
export const pick = (list) => list[Math.floor(Math.random() * list.length)];
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, t) => a + (b - a) * t;

export const ease = {
  linear: (t) => t,
  out: (t) => 1 - Math.pow(1 - t, 4),               // power4.out
  in: (t) => t * t * t,
  inOut: (t) => (t < 0.5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2),
};

// Calmer animations: when Windows has its animation effects off (prefers-reduced-motion), unless
// her menu says otherwise (Animations: like Windows, full, reduced). Read live: `.matches`.
const systemReduced = matchMedia('(prefers-reduced-motion: reduce)');
export const reducedMotion = {
  setting: 'auto', // 'auto' (like Windows), 'full' or 'reduced'
  get matches() {
    return this.setting === 'reduced' || (this.setting === 'auto' && systemReduced.matches);
  },
  get system() {
    return systemReduced.matches;
  },
  onSystemChange(fn) {
    systemReduced.addEventListener('change', fn);
  },
};

// "{project} a fini" + {project: 'x'} -> "x a fini"
export const fmt = (str, vars = {}) => str.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ''));

export function duration(ms, lang = 'fr') {
  const ru = lang === 'ru';
  const s = Math.max(0, Math.round(ms / 1000));
  if (lang === 'th') {
    if (s < 60) return `${s} วิ`;
    const tm = Math.floor(s / 60);
    if (tm < 60) return `${tm} นาที ${s % 60} วิ`;
    return `${Math.floor(tm / 60)} ชม. ${tm % 60} นาที`;
  }
  if (s < 60) return ru ? `${s} с` : `${s} s`;
  const m = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, '0');
  if (m < 60) return lang === 'en' ? `${m}m ${ss}s` : ru ? `${m} мин ${ss} с` : `${m} min ${ss}`;
  return `${Math.floor(m / 60)} ${ru ? 'ч' : 'h'} ${String(m % 60).padStart(2, '0')}`;
}

export const basename = (p = '') => String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';

// the local date, YYYY-MM-DD
export const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// Tweens a set of numeric props on `target`. Values are read by the stepped render loop,
// so the result lands on whole drawing frames like cel animation.
export function tween(target, to, ms, easing = ease.out) {
  const from = {};
  for (const k of Object.keys(to)) from[k] = target[k];
  const start = performance.now();
  return new Promise((resolve) => {
    if (ms <= 0) {
      Object.assign(target, to);
      resolve();
      return;
    }
    const tick = () => {
      const t = Math.min(1, (performance.now() - start) / ms);
      const e = easing(t);
      for (const k of Object.keys(to)) target[k] = lerp(from[k], to[k], e);
      if (t < 1) requestAnimationFrame(tick);
      else resolve();
    };
    requestAnimationFrame(tick);
  });
}

// Technical errors (from the AI services, Claude Code, Windows), said in Thai when she speaks Thai.
// Unknown ones stay as they came, so nothing that helps fix them is lost.
const TH_ERRORS = [
  [/claude auth login|Failed to authenticate|authentication_failed|login reached its time limit/i, 'Claude ยังไม่ได้ล็อกอิน หรือล็อกอินหมดอายุ: พิมพ์ claude auth login ในเทอร์มินัลแล้วล็อกอินใหม่'],
  [/Claude Code not found/i, 'หาโปรแกรม Claude Code ในเครื่องไม่เจอ'],
  [/Claude Code gave no answer/i, 'Claude Code ไม่ตอบอะไรกลับมาเลย'],
  [/Claude Code failed/i, 'Claude Code ทำงานไม่สำเร็จ'],
  [/^stopped$/i, 'หยุดแล้ว'],
  [/no API key/i, 'ยังไม่ได้ใส่ API key'],
  [/API key not valid|invalid api key|incorrect api key|unauthori[sz]ed|\b401\b/i, 'API key ไม่ถูกต้อง หรือหมดอายุแล้ว'],
  [/quota|rate.?limit|RESOURCE_EXHAUSTED|too many requests|\b429\b/i, 'ใช้เกินโควตาแล้ว รอสักพักแล้วค่อยลองใหม่'],
  [/overloaded|high demand|unavailable|\b50[0-4]\b/i, 'ฝั่งบริการ AI ล่มหรือคนใช้เยอะอยู่ ลองใหม่อีกที'],
  [/permission denied|forbidden|\b403\b/i, 'บริการไม่อนุญาตให้ใช้ (403)'],
  [/not found|\b404\b/i, 'หาไม่เจอ'],
  [/no address set/i, 'ยังไม่ได้ใส่ที่อยู่เซิร์ฟเวอร์'],
  [/^offline$/i, 'ติดต่อ AI ไม่ได้'],
  [/^no model$/i, 'ยังไม่มีโมเดลให้ใช้'],
  [/unknown provider/i, 'ไม่รู้จักบริการ AI นี้'],
  [/no picture of the screen/i, 'จับภาพหน้าจอไม่ได้'],
  [/not one she found/i, 'ไฟล์นี้ไม่ได้อยู่ในรายการที่ฉันหาเจอ'],
  [/Ollama answered (\d+)/i, 'Ollama ตอบกลับมาเป็นรหัส $1'],
  [/not valid JSON/i, 'ไฟล์ settings.json เขียนผิดรูปแบบ ฉันเลยไม่แตะมัน'],
  [/EACCES|EPERM/i, 'ไม่มีสิทธิ์เขียนไฟล์'],
  [/fetch failed|ECONNREFUSED|ENOTFOUND|ECONNRESET|ETIMEDOUT|timed? ?out|network/i, 'ต่อเน็ตหรือเซิร์ฟเวอร์ไม่ได้'],
];
export function errText(error, lang) {
  const text = String(error ?? '');
  if (lang !== 'th' || !text) return text;
  for (const [re, th] of TH_ERRORS) if (re.test(text)) return text.replace(/^[\s\S]*$/, () => th.replace('$1', (re.exec(text) || [])[1] || ''));
  return text;
}
