const express = require('express'), http = require('http'), fs = require('fs'), crypto = require('crypto');
const { WebSocketServer } = require('ws');
const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.static('public'));
fs.mkdirSync('uploads', { recursive: true });
app.use('/media', express.static('uploads')); // پشتیبانی از Range برای جلو/عقب کردن

// ذخیره‌سازی ساده در فایل
let db = { scores: {}, support: [] };
try { db = JSON.parse(fs.readFileSync('db.json')); } catch {}
const save = () => fs.writeFileSync('db.json', JSON.stringify(db));

const upToks = {}; // توکن آپلود -> کد لابی
const rooms = {}; // code -> {code,type,title,media,state,members:Map(ws->name)}
const code = () => { let c; do c = String(Math.floor(1000 + Math.random() * 9000)); while (rooms[c]); return c; };

app.get('/api/ranking', (q, r) =>
  r.json(Object.entries(db.scores).map(([name, pts]) => ({ name, pts })).sort((a, b) => b.pts - a.pts).slice(0, 50)));
app.get('/api/lobbies', (q, r) =>
  r.json(Object.values(rooms).filter(x => x.type === 'public' && x.members.size).map(x => ({ code: x.code, title: x.title, count: names(x).length }))));
app.post('/api/support', (q, r) => {
  db.support.push({ name: String(q.body.name || '').slice(0, 40), text: String(q.body.text || '').slice(0, 1000), t: Date.now() });
  save(); r.json({ ok: 1 });
});

const server = http.createServer(app);
server.requestTimeout = 0; // آپلودهای طولانی نباید قطع شوند
const wss = new WebSocketServer({ server });

const names = rm => [...rm.members].filter(([w]) => !w.ghost).map(([, n]) => n);
const bcast = (rm, msg, except) => rm.members.forEach((n, w) => { if (w !== except && w.readyState === 1) w.send(JSON.stringify(msg)); });
const curTime = s => s.time + (s.playing ? (Date.now() - s.at) / 1000 : 0);

const GRACE = 10 * 60 * 1000; // لابی خالی (بدون خروج دستی) تا ۱۰ دقیقه می‌ماند؛ با «خروج» آخرین نفر فوراً حذف می‌شود
const chatPush = (rm, msg) => { (rm.chat = rm.chat || []).push(msg); if (rm.chat.length > 40) rm.chat.shift(); bcast(rm, msg); };

function leave(ws, final) {
  const rm = rooms[ws.room]; if (!rm) return;
  if (rm.callers && rm.callers.delete(ws)) bcast(rm, { t: 'calloff', name: rm.members.get(ws) }, ws);
  rm.members.delete(ws); ws.room = null;
  if (!names(rm).length) { if (final && !ws.ghost) delete rooms[rm.code]; else rm.emptyAt = rm.emptyAt || Date.now(); }
  else bcast(rm, { t: 'members', members: names(rm) });
}

wss.on('connection', ws => {
  ws.alive = true; ws.on('pong', () => { ws.alive = true; });
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    const rm = rooms[ws.room];
    if (m.t === 'create' || m.t === 'join') {
      leave(ws);
      ws.ghost = m.t === 'join' && !!(m.ghost && ADMIN_KEY && m.key && same(String(m.key), ADMIN_KEY));
      if (!ws.ghost) { const acc = verifySession(m.auth); if (!acc) return ws.send(JSON.stringify({ t: 'error', msg: 'ابتدا وارد حساب خودت شو' })); m.name = acc.u; }
      let r;
      if (m.t === 'create') {
        const c = code();
        r = rooms[c] = { code: c, type: m.type === 'private' ? 'private' : 'public', title: `لابی ${String(m.name).slice(0, 20)}`, media: '', state: { playing: false, time: 0, at: Date.now() }, members: new Map(), chat: [], emptyAt: 0 };
      } else {
        r = rooms[m.code];
        if (!r) return ws.send(JSON.stringify({ t: 'error', msg: 'لابی‌ای با این کد پیدا نشد' }));
      }
      const nm = String(m.name).slice(0, 20);
      r.members.forEach((n, w) => { if (!ws.ghost && !w.ghost && n === nm && w !== ws) { r.members.delete(w); w.room = null; try { w.close(); } catch {} } });
      if (!ws.ghost) r.emptyAt = 0;
      ws.room = r.code; r.members.set(ws, String(m.name).slice(0, 20));
      const tok = crypto.randomBytes(8).toString('hex'); upToks[tok] = { code: r.code, name: String(m.name).slice(0, 20) };
      ws.send(JSON.stringify({ t: 'joined', ghost: !!ws.ghost, tok, code: r.code, media: r.media, playing: r.state.playing, time: curTime(r.state), members: names(r), chat: r.chat || [], local: r.local || null }));
      if (!ws.ghost) {
        bcast(r, { t: 'members', members: names(r) }, ws);
        if (!db.users[nm]) { db.users[nm] = Date.now(); save(); }
      }
      if (m.t === 'create') { db.scores[m.name] = (db.scores[m.name] || 0) + 5; db.stats.lobbies++; save(); }
    } else if (rm) {
      if (m.t === 'leave') leave(ws, true);
      else if (m.t === 'localmedia') {
        rm.local = { name: String(m.name || '').slice(0, 120), size: Number(m.size) || 0 }; rm.media = ''; rm.state = { playing: false, time: 0, at: Date.now() };
        bcast(rm, { t: 'localmedia', ...rm.local, by: rm.members.get(ws) }, ws);
      }
      else if (m.t === 'media') { rm.local = null; rm.media = String(m.url); rm.state = { playing: false, time: 0, at: Date.now() }; bcast(rm, { t: 'media', url: rm.media }); }
      else if (m.t === 'callon') {
        rm.callers = rm.callers || new Set();
        const others = [...rm.callers].filter(w => w !== ws).map(w => rm.members.get(w));
        rm.callers.add(ws);
        ws.send(JSON.stringify({ t: 'callers', list: others }));
        bcast(rm, { t: 'callon', name: rm.members.get(ws) }, ws);
      } else if (m.t === 'calloff') { if (rm.callers && rm.callers.delete(ws)) bcast(rm, { t: 'calloff', name: rm.members.get(ws) }, ws); }
      else if (m.t === 'rtc') { rm.members.forEach((n, w) => { if (n === m.to && w.readyState === 1) w.send(JSON.stringify({ t: 'rtc', from: rm.members.get(ws), data: m.data })); }); }
      else if (['play', 'pause', 'seek'].includes(m.t)) {
        const time = Number(m.time) || 0;
        rm.state = { playing: m.t === 'play' ? true : m.t === 'pause' ? false : rm.state.playing, time, at: Date.now() };
        bcast(rm, { t: m.t, time }, ws);
      } else if (m.t === 'chat') chatPush(rm, { t: 'chat', name: rm.members.get(ws), text: String(m.text).slice(0, 300) });
    }
  });
  ws.on('close', () => leave(ws));
});

setInterval(() => {
  wss.clients.forEach(w => { if (!w.alive) return w.terminate(); w.alive = false; try { w.ping(); } catch {} });
  Object.values(rooms).forEach(rm => { if (!names(rm).length && rm.emptyAt && Date.now() - rm.emptyAt > GRACE) delete rooms[rm.code]; });
}, 30000);

// هر دقیقه برای کسی که در حال تماشاست ۱ امتیاز
setInterval(() => {
  Object.values(rooms).forEach(rm => { if (rm.state.playing) rm.members.forEach(n => { db.scores[n] = (db.scores[n] || 0) + 1; }); });
  save();
}, 60000);


// آپلود فیلم از گالری (فقط اعضای لابی)
app.post('/upload', (req, res) => {
  const code = (upToks[req.query.tok] || {}).code, rm = rooms[code];
  if (!rm) return res.status(403).end('forbidden');
  const ext = (String(req.headers['x-ext'] || '').toLowerCase().match(/^[a-z0-9]{2,4}$/) || [''])[0];
  if (!['mp4', 'webm', 'mov', 'm4v', 'mp3', 'm4a', 'ogg', 'wav', 'mkv'].includes(ext)) return res.status(400).end('format');
  if (+req.headers['content-length'] > 4e9) return res.status(413).end('too big');
  const name = crypto.randomBytes(8).toString('hex') + '.' + ext;
  const out = fs.createWriteStream('uploads/' + name);
  req.pipe(out);
  out.on('finish', () => {
    if (rooms[code]) { rm.media = '/media/' + name; rm.state = { playing: false, time: 0, at: Date.now() }; bcast(rm, { t: 'media', url: rm.media }); }
    res.json({ ok: 1 });
  });
  req.on('aborted', () => { out.destroy(); fs.unlink('uploads/' + name, () => {}); });
});

// آپلود تکه‌ای و موازی (سریع‌تر و قابل تکرار برای فایل‌های بزرگ)
const EXTS = ['mp4', 'webm', 'mov', 'm4v', 'mp3', 'm4a', 'ogg', 'wav', 'mkv'];
const parts = {};
app.post('/upload-chunk', (req, res) => {
  const code = (upToks[req.query.tok] || {}).code, rm = rooms[code];
  if (!rm) return res.status(403).end('forbidden');
  const id = String(req.query.id || ''), i = +req.query.i, n = +req.query.n, ch = +req.query.ch, size = +req.query.size;
  const ext = (String(req.headers['x-ext'] || '').toLowerCase().match(/^[a-z0-9]{2,4}$/) || [''])[0];
  if (!/^[a-f0-9]{16}$/.test(id) || !EXTS.includes(ext) || !(n >= 1 && n <= 4096) || !(i >= 0 && i < n) || !(ch >= 1e6 && ch <= 16e6) || !(size > 0 && size <= 4e9) || Math.ceil(size / ch) !== n) return res.status(400).end('bad');
  if (+req.headers['content-length'] > ch) return res.status(413).end();
  const p = parts[id] = parts[id] || { got: new Set(), done: false, name: crypto.randomBytes(8).toString('hex') + '.' + ext };
  const path = 'uploads/part_' + id, want = Math.min(ch, size - i * ch);
  if (!fs.existsSync(path)) fs.closeSync(fs.openSync(path, 'a'));
  const out = fs.createWriteStream(path, { flags: 'r+', start: i * ch });
  req.pipe(out);
  out.on('finish', () => {
    if (out.bytesWritten !== want) return res.status(400).end('short');
    p.got.add(i);
    if (p.got.size === n && !p.done && fs.statSync(path).size === size) {
      p.done = true; fs.renameSync(path, 'uploads/' + p.name); delete parts[id];
      if (rooms[code]) { rm.local = null; rm.media = '/media/' + p.name; rm.state = { playing: false, time: 0, at: Date.now() }; bcast(rm, { t: 'media', url: rm.media }); }
    }
    res.json({ ok: 1 });
  });
  req.on('aborted', () => out.destroy());
});
// پیام صوتی داخل چت لابی
app.post('/voice', (req, res) => {
  const u = upToks[req.query.tok] || {}, rm = rooms[u.code];
  if (!rm) return res.status(403).end();
  const ext = (String(req.headers['x-ext'] || '').match(/^(webm|ogg|mp4|m4a|wav)$/) || [''])[0];
  const dur = Math.max(0, Math.min(900, Math.round(+req.headers['x-dur'] || 0)));
  if (!ext || +req.headers['content-length'] > 8e6) return res.status(400).end();
  const name = 'v' + crypto.randomBytes(8).toString('hex') + '.' + ext, out = fs.createWriteStream('uploads/' + name);
  let n = 0, bad = false;
  req.on('data', d => { n += d.length; if (n > 8e6 && !bad) { bad = true; req.destroy(); out.destroy(); fs.unlink('uploads/' + name, () => {}); } });
  req.pipe(out);
  out.on('finish', () => { if (bad) return; chatPush(rm, { t: 'chat', name: u.name, text: '🎤', voice: '/media/' + name, dur }); res.json({ ok: 1 }); });
});
// پاک کردن فایل‌های قدیمی‌تر از ۱۲ ساعت
setInterval(() => fs.readdirSync('uploads').forEach(f => {
  const p = 'uploads/' + f; if (Date.now() - fs.statSync(p).mtimeMs > 12 * 3600e3) fs.unlink(p, () => {});
}), 3600e3);


// ===== اشتراک VIP =====
// قیمت‌ها و متن پرداخت را اینجا ویرایش کن
const PLANS = [
  { days: 30, name: 'ماهانه', price: '۱۰۰,۰۰۰ تومان' },
  { days: 90, name: 'سه‌ماهه', price: '۲۵۰,۰۰۰ تومان' },
  { days: 365, name: 'سالانه', price: '۸۰۰,۰۰۰ تومان' }
];
const PAY_INFO = 'برای خرید، مبلغ پلن را کارت‌به‌کارت کن و رسید را از بخش «پشتیبانی» بفرست. کد فعال‌سازی برایت ارسال می‌شود.\nشماره کارت: ----';
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const sign = s => crypto.createHmac('sha256', ADMIN_KEY).update(s).digest('hex').slice(0, 10);
const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const tokExp = t => { const [e, sg] = String(t || '').split('.'); return e && sg && same(sg, sign('t' + e)) ? Number(e) : 0; };
const fails = {};
db.used = db.used || {}; db.users = db.users || {}; db.stats = db.stats || { lobbies: 0 };

app.get('/api/vip/plans', (q, r) => r.json({ plans: PLANS, pay: PAY_INFO }));
app.get('/api/vip/check', (q, r) => {
  const exp = ADMIN_KEY ? tokExp(q.query.token) : 0;
  r.json({ vip: exp > Date.now(), exp });
});
app.post('/api/vip/redeem', (q, r) => {
  if (!ADMIN_KEY) return r.status(503).json({ err: 'سرور هنوز برای VIP تنظیم نشده' });
  const ip = q.ip, h = Math.floor(Date.now() / 3600000), k = ip + h;
  if ((fails[k] || 0) >= 10) return r.status(429).json({ err: 'تلاش زیاد؛ بعداً دوباره امتحان کن' });
  const code = String(q.body.code || '').trim();
  const [d, n, sg] = code.split('-');
  const days = Number(d);
  if (!days || !n || !sg || !same(sg, sign(d + '-' + n)) || days > 3650) { fails[k] = (fails[k] || 0) + 1; return r.status(400).json({ err: 'کد نامعتبر است' }); }
  if (db.used[code]) return r.status(400).json({ err: 'این کد قبلاً استفاده شده' });
  const base = Math.max(Date.now(), tokExp(q.body.cur));
  const exp = base + days * 86400000;
  db.used[code] = Date.now(); save();
  r.json({ token: exp + '.' + sign('t' + exp), exp });
});
const admin = (q, r) => { if (ADMIN_KEY && String(q.get('x-key') || '') && same(String(q.get('x-key')), ADMIN_KEY)) return true; r.status(401).json({ err: 'رمز اشتباه' }); return false; };
app.post('/api/admin/gen', (q, r) => {
  if (!admin(q, r)) return;
  const d = Math.max(1, Math.min(3650, Number(q.body.days) || 30)), n = crypto.randomBytes(3).toString('hex');
  r.json({ code: `${d}-${n}-${sign(d + '-' + n)}` });
});
app.get('/api/ice', (q, r) => {
  const s = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
  if (process.env.TURN_URL) s.push({ urls: process.env.TURN_URL.split(','), username: process.env.TURN_USER || '', credential: process.env.TURN_PASS || '' });
  r.json(s);
});
app.get('/api/admin/stats', (q, r) => {
  if (!admin(q, r)) return;
  r.json({ users: Object.keys(db.users).length, lobbiesTotal: db.stats.lobbies, online: wss.clients.size, vipCodesUsed: Object.keys(db.used).length,
    rooms: Object.values(rooms).map(x => ({ code: x.code, title: x.title, type: x.type, count: names(x).length, members: names(x) })) });
});
app.get('/api/admin/support', (q, r) => { if (admin(q, r)) r.json(db.support.slice(-50).reverse()); });


// ===== ورود با شماره موبایل =====
db.accounts = db.accounts || {}; db.unames = db.unames || {};
const pend = {}, adminCodes = [];
const en = x => String(x || '').replace(/[۰-۹]/g, c => '۰۱۲۳۴۵۶۷۸۹'.indexOf(c)).replace(/[٠-٩]/g, c => '٠١٢٣٤٥٦٧٨٩'.indexOf(c));
const hm = s => crypto.createHmac('sha256', ADMIN_KEY).update('auth:' + s).digest('base64url').slice(0, 32);
const mk = o => { const p = Buffer.from(JSON.stringify(o)).toString('base64url'); return p + '.' + hm(p); };
const rd = t => { try { const [p, s] = String(t || '').split('.'); if (!p || !s || !ADMIN_KEY || !same(s, hm(p))) return null; const o = JSON.parse(Buffer.from(p, 'base64url').toString()); return o.exp && o.exp < Date.now() ? null : o; } catch { return null; } };
function verifySession(t) { const o = rd(t); return o && o.k === 's' ? o : null; }
const phoneHash = ph => crypto.createHmac('sha256', ADMIN_KEY).update('ph:' + ph).digest('hex').slice(0, 24);
const normPhone = x => { let d = en(x).replace(/\D/g, ''); if (d.startsWith('0098')) d = d.slice(4); else if (d.startsWith('98')) d = d.slice(2); if (d.length === 10 && d[0] === '9') d = '0' + d; return /^09\d{9}$/.test(d) ? d : ''; };
const sessTok = (h, u, n) => mk({ k: 's', h, u, n, exp: Date.now() + 18144e6 });
const bad = (r, c, err) => r.status(c).json({ err });

const normEmail = x => { const e = String(x || '').trim().toLowerCase(); return e.length <= 100 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) ? e : ''; };
const idOf = b => { const p = normPhone(b.phone); if (p) return { kind: 'p', id: p }; const e = normEmail(b.email); return e ? { kind: 'e', id: e } : null; };
const idHash = x => crypto.createHmac('sha256', ADMIN_KEY).update((x.kind === 'p' ? 'ph:' : 'em:') + x.id).digest('hex').slice(0, 24);
const sendMail = async (to, code) => {
  const x = await fetch('https://api.brevo.com/v3/smtp/email', { method: 'POST', signal: AbortSignal.timeout(10000),
    headers: { 'api-key': process.env.BREVO_KEY, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ sender: { name: process.env.MAIL_NAME || 'Dor Ham', email: process.env.MAIL_FROM }, to: [{ email: to }], subject: 'کد ورود به دورهم',
      htmlContent: `<div dir="rtl" style="font-family:Tahoma,sans-serif;text-align:right"><p>کد ورود شما به دورهم:</p><p style="font-size:30px;letter-spacing:6px;font-weight:bold;direction:ltr;text-align:center">${code}</p><p>این کد تا ۵ دقیقه معتبر است. آن را با هیچ‌کس در میان نگذارید.</p></div>` }) });
  return x.ok;
};
app.post('/api/auth/send', async (q, r) => {
  if (!ADMIN_KEY) return bad(r, 503, 'سرور هنوز تنظیم نشده');
  const x = idOf(q.body); if (!x) return bad(r, 400, String(q.body.email || '').trim() ? 'ایمیل معتبر نیست' : 'شماره موبایل معتبر نیست');
  if (x.kind === 'e' && !(process.env.BREVO_KEY && process.env.MAIL_FROM)) return bad(r, 503, 'ورود با ایمیل هنوز راه‌اندازی نشده');
  const k = 'a' + q.ip + Math.floor(Date.now() / 3600000), key = x.kind + x.id;
  if ((fails[k] = (fails[k] || 0) + 1) > 8) return bad(r, 429, 'تلاش زیاد؛ بعداً دوباره امتحان کن');
  if (pend[key] && Date.now() - pend[key].at < 60000) return bad(r, 429, 'کمی صبر کن و دوباره بخواه');
  const code = String(crypto.randomInt(10000, 100000));
  pend[key] = { h: hm('c' + key + code), exp: Date.now() + 300000, tries: 0, at: Date.now() };
  if (x.kind === 'e') { // کد ایمیل محرمانه است: فقط به ایمیل می‌رود و هیچ‌جا (حتی پنل مدیر) دیده نمی‌شود
    let ok = false; try { ok = await sendMail(x.id, code); } catch {}
    if (!ok) { delete pend[key]; return bad(r, 502, 'ارسال ایمیل ناموفق بود؛ دوباره امتحان کن'); }
    return r.json({ ok: 1, manual: false, email: true });
  }
  let sent = false;
  if (process.env.KAVENEGAR_KEY && process.env.KAVENEGAR_TEMPLATE) {
    try { const y = await fetch(`https://api.kavenegar.com/v1/${process.env.KAVENEGAR_KEY}/verify/lookup.json?receptor=${x.id}&token=${code}&template=${encodeURIComponent(process.env.KAVENEGAR_TEMPLATE)}`, { signal: AbortSignal.timeout(8000) }); sent = y.ok; } catch {}
  }
  if (!sent) { adminCodes.push({ phone: x.id, code, at: Date.now() }); if (adminCodes.length > 30) adminCodes.shift(); }
  r.json({ ok: 1, manual: !sent });
});
app.post('/api/auth/verify', (q, r) => {
  const x = idOf(q.body), code = en(q.body.code).replace(/\D/g, ''), key = x && x.kind + x.id, p = key && pend[key];
  if (!x || !p || p.exp < Date.now()) return bad(r, 400, 'کد منقضی شده؛ دوباره بخواه');
  if (++p.tries > 5) { delete pend[key]; return bad(r, 429, 'تلاش زیاد؛ کد جدید بخواه'); }
  if (!same(p.h, hm('c' + key + code))) return bad(r, 400, 'کد اشتباه است');
  delete pend[key];
  const h = idHash(x), a = db.accounts[h];
  if (a) return r.json({ token: sessTok(h, a.u, a.n), u: a.u, n: a.n });
  r.json({ vtoken: mk({ k: 'v', h, exp: Date.now() + 900000 }) });
});
function saveAcct(h, u, n, r) {
  if (!/^[A-Za-z0-9_]{3,20}$/.test(u)) return bad(r, 400, 'نام کاربری باید ۳ تا ۲۰ حرف انگلیسی، عدد یا _ باشد');
  if (!n) return bad(r, 400, 'اسمت را بنویس');
  const own = db.unames[u.toLowerCase()]; if (own && own !== h) return bad(r, 400, 'این نام کاربری قبلاً گرفته شده');
  const old = db.accounts[h]; if (old) delete db.unames[old.u.toLowerCase()];
  db.accounts[h] = { u, n }; db.unames[u.toLowerCase()] = h; save();
  r.json({ token: sessTok(h, u, n), u, n });
}
app.post('/api/auth/profile', (q, r) => {
  const v = rd(q.body.vtoken); if (!v || v.k !== 'v') return bad(r, 401, 'نشست منقضی شد؛ از اول وارد شو');
  saveAcct(v.h, String(q.body.username || '').trim(), String(q.body.name || '').trim().slice(0, 20), r);
});
app.post('/api/auth/update', (q, r) => {
  const s = verifySession(q.body.token); if (!s) return bad(r, 401, 'دوباره وارد شو');
  saveAcct(s.h, String(q.body.username || '').trim(), String(q.body.name || '').trim().slice(0, 20), r);
});
app.get('/api/auth/me', (q, r) => { const s = verifySession(String(q.headers.authorization || '').slice(7)); r.json(s ? { ok: 1, u: s.u, n: s.n } : { ok: 0 }); });
app.get('/api/admin/codes', (q, r) => { if (admin(q, r)) r.json(adminCodes.filter(c => Date.now() - c.at < 600000).reverse()); });

// ===== دعوت دوستان =====
db.refd = db.refd || {}; db.refip = db.refip || {};
app.post('/api/ref', (q, r) => {
  const ref = String(q.body.ref || '').slice(0, 20), n = String(q.body.name || '').slice(0, 20);
  if (!ref || !n || ref === n || !(ref in db.scores) || db.refd[n] || db.refip[q.ip]) return r.json({ ok: 0 });
  db.refd[n] = ref; db.refip[q.ip] = 1;
  db.scores[ref] += 50; db.scores[n] = (db.scores[n] || 0) + 20; save();
  r.json({ ok: 1 });
});

server.listen(process.env.PORT || 3000, () => console.log('Dor Ham running on port', process.env.PORT || 3000));
