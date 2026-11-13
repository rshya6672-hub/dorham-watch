const express = require('express'), http = require('http'), fs = require('fs'), crypto = require('crypto'), https = require('https');
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
const MEDIA_TTL = 24 * 3600e3; // فایل‌های آپلودشده ۲۴ ساعت می‌مانند
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
const validAv = x => typeof x === 'string' && x.startsWith('data:image/jpeg;base64,') && x.length < 24000 ? x : '';
const avMap = rm => { const o = {}; rm.members.forEach((n, w) => { if (w.av && !w.ghost) o[n] = w.av; }); return o; };
const callMuted = rm => rm.callers ? [...rm.callers].filter(w => w.muted && !w.ghost).map(w => rm.members.get(w)).filter(Boolean) : [];
const callList = rm => rm.callers ? [...rm.callers].filter(w => !w.ghost).map(w => rm.members.get(w)).filter(Boolean) : [];
const chatPush = (rm, msg) => {
  (rm.chat = rm.chat || []).push(msg); if (rm.chat.length > 40) rm.chat.shift(); bcast(rm, msg);
  pushAway(rm, msg.name, { title: msg.name + ' · لابی ' + rm.code, body: msg.voice ? '🎤 پیام صوتی' : String(msg.text || '').slice(0, 120), tag: 'chat-' + rm.code, url: '/?room=' + rm.code });
};

function leave(ws, final) {
  const rm = rooms[ws.room]; if (!rm) return;
  ws.muted = false;
  if (rm.callers && rm.callers.delete(ws)) { bcast(rm, { t: 'calloff', name: rm.members.get(ws) }, ws); bcast(rm, { t: 'calllist', list: callList(rm) }, ws); }
  const nm0 = rm.members.get(ws);
  if (!final && !ws.ghost && ws.ep && nm0) { rm.away = rm.away || {}; rm.away[nm0] = { ep: ws.ep, at: Date.now(), last: 0 }; }
  rm.members.delete(ws); ws.room = null;
  if (!names(rm).length) { if (final && !ws.ghost) { archiveRoom(rm); delete rooms[rm.code]; } else rm.emptyAt = rm.emptyAt || Date.now(); }
  else bcast(rm, { t: 'members', members: names(rm), avs: avMap(rm) });
}

wss.on('connection', ws => {
  ws.alive = true; ws.on('pong', () => { ws.alive = true; });
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    const rm = rooms[ws.room];
    if (m.t === 'hello') { ws.ep = String(m.ep || '').slice(0, 600); if (m.name) ws.gname = String(m.name).trim().slice(0, 20); return; }
    if (['gcreate', 'gjoin', 'glist', 'gleave', 'gmsg'].includes(m.t)) return handleG(ws, m);
    if (m.t === 'create' || m.t === 'join') {
      leave(ws);
      ws.ghost = m.t === 'join' && !!(m.ghost && ADMIN_KEY && m.key && same(String(m.key), ADMIN_KEY));
      if (!ws.ghost) { m.name = String(m.name || '').trim().slice(0, 20); if (!m.name) return ws.send(JSON.stringify({ t: 'error', msg: 'اول یک نام انتخاب کن' })); }
      ws.av = validAv(m.av); ws.muted = false;
      let r;
      if (m.t === 'create') {
        const c = code();
        r = rooms[c] = { code: c, type: m.type === 'private' ? 'private' : 'public', title: `لابی ${String(m.name).slice(0, 20)}`, media: '', state: { playing: false, time: 0, at: Date.now() }, members: new Map(), chat: [], emptyAt: 0, by: String(m.name).slice(0, 20), at: Date.now(), seen: new Set(), uploads: [] };
      } else {
        r = rooms[m.code];
        if (!r && ws.ghost && m.arch) r = restoreRoom(String(m.arch));
        if (!r) return ws.send(JSON.stringify({ t: 'error', msg: 'لابی‌ای با این کد پیدا نشد' }));
      }
      const nm = String(m.name).slice(0, 20);
      r.members.forEach((n, w) => { if (!ws.ghost && !w.ghost && n === nm && w !== ws) { r.members.delete(w); w.room = null; try { w.close(); } catch {} } });
      if (!ws.ghost) r.emptyAt = 0;
      if (r.away) delete r.away[nm];
      if (!ws.ghost) (r.seen = r.seen || new Set()).add(nm);
      ws.room = r.code; r.members.set(ws, String(m.name).slice(0, 20));
      const tok = crypto.randomBytes(8).toString('hex'); upToks[tok] = { code: r.code, name: String(m.name).slice(0, 20) };
      ws.send(JSON.stringify({ t: 'joined', ghost: !!ws.ghost, tok, code: r.code, media: r.media, playing: r.state.playing, time: curTime(r.state), members: names(r), chat: r.chat || [], local: r.local || null, calls: callList(r), cmuted: callMuted(r), avs: avMap(r) }));
      if (!ws.ghost) {
        bcast(r, { t: 'members', members: names(r), avs: avMap(r) }, ws);
        if (!db.users[nm]) { db.users[nm] = Date.now(); save(); }
      }
      if (m.t === 'create') { db.scores[m.name] = (db.scores[m.name] || 0) + 5; db.stats.lobbies++; save(); if (r.type === 'public') notifyNewLobby(r, nm, ws); }
    } else if (rm) {
      if (m.t === 'leave') leave(ws, true);
      else if (m.t === 'setav') { ws.av = validAv(m.av); bcast(rm, { t: 'avs', avs: avMap(rm) }); }
      else if (m.t === 'mute') { if (rm.callers && rm.callers.has(ws)) { ws.muted = !!m.muted; bcast(rm, { t: 'callmute', muted: callMuted(rm) }); } }
      else if (m.t === 'localmedia') {
        rm.local = { name: String(m.name || '').slice(0, 120), size: Number(m.size) || 0 }; rm.media = ''; rm.state = { playing: false, time: 0, at: Date.now() };
        bcast(rm, { t: 'localmedia', ...rm.local, by: rm.members.get(ws) }, ws);
      }
      else if (m.t === 'media') { rm.local = null; rm.media = String(m.url); rm.state = { playing: false, time: 0, at: Date.now() }; bcast(rm, { t: 'media', url: rm.media }); }
      else if (m.t === 'callon') {
        if (ws.ghost) return;
        rm.callers = rm.callers || new Set();
        if (!rm.callers.size) pushAway(rm, rm.members.get(ws), { title: rm.members.get(ws) + ' تماس صوتی شروع کرد 🎙', body: 'لابی ' + rm.code, tag: 'call-' + rm.code, url: '/?room=' + rm.code });
        const others = [...rm.callers].filter(w => w !== ws).map(w => rm.members.get(w));
        rm.callers.add(ws);
        ws.send(JSON.stringify({ t: 'callers', list: others }));
        bcast(rm, { t: 'callon', name: rm.members.get(ws) }, ws);
        bcast(rm, { t: 'calllist', list: callList(rm) });
      } else if (m.t === 'calloff') { if (rm.callers && rm.callers.delete(ws)) { bcast(rm, { t: 'calloff', name: rm.members.get(ws) }, ws); bcast(rm, { t: 'calllist', list: callList(rm) }); } }
      else if (m.t === 'rtc') { rm.members.forEach((n, w) => { if (n === m.to && w.readyState === 1) w.send(JSON.stringify({ t: 'rtc', from: rm.members.get(ws), data: m.data })); }); }
      else if (['play', 'pause', 'seek'].includes(m.t)) {
        const time = Number(m.time) || 0;
        rm.state = { playing: m.t === 'play' ? true : m.t === 'pause' ? false : rm.state.playing, time, at: Date.now() };
        bcast(rm, { t: m.t, time }, ws);
      } else if (m.t === 'chat') chatPush(rm, { t: 'chat', name: rm.members.get(ws), text: String(m.text).slice(0, 300) });
    }
  });
  ws.on('close', () => { leave(ws); gDrop(ws); });
});

setInterval(() => {
  wss.clients.forEach(w => { if (!w.alive) return w.terminate(); w.alive = false; try { w.ping(); } catch {} });
  Object.values(rooms).forEach(rm => { if (rm.away) for (const [n, a] of Object.entries(rm.away)) if (Date.now() - a.at > 6 * 3600e3) delete rm.away[n]; });
  Object.values(rooms).forEach(rm => { if (!names(rm).length && !rm.members.size && rm.emptyAt && Date.now() - rm.emptyAt > GRACE) { archiveRoom(rm); delete rooms[rm.code]; } });
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
    if (rooms[code]) { recordUpload(rm, name, (upToks[req.query.tok] || {}).name, out.bytesWritten); rm.media = '/media/' + name; rm.state = { playing: false, time: 0, at: Date.now() }; bcast(rm, { t: 'media', url: rm.media }); }
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
      if (rooms[code]) { recordUpload(rm, p.name, (upToks[req.query.tok] || {}).name, size); rm.local = null; rm.media = '/media/' + p.name; rm.state = { playing: false, time: 0, at: Date.now() }; bcast(rm, { t: 'media', url: rm.media }); }
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
// پاک کردن فایل‌های قدیمی‌تر از ۲۴ ساعت
setInterval(() => fs.readdirSync('uploads').forEach(f => {
  const p = 'uploads/' + f; if (Date.now() - fs.statSync(p).mtimeMs > MEDIA_TTL) fs.unlink(p, () => {});
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
  r.json({ users: Object.keys(db.users).length, lobbiesTotal: db.stats.lobbies, online: wss.clients.size, chats: Object.keys(db.chats).length, vipCodesUsed: Object.keys(db.used).length,
    rooms: Object.values(rooms).map(x => ({ code: x.code, title: x.title, type: x.type, count: names(x).length, members: names(x), by: x.by || '', at: x.at || 0, media: liveUploads(x.uploads).length, msgs: (x.chat || []).length })),
    archive: Object.values(db.archive).sort((a, b) => b.closedAt - a.closedAt).slice(0, 300).map(a => ({ id: a.id, code: a.code, type: a.type, by: a.by, at: a.at, closedAt: a.closedAt, count: a.seen.length, media: liveUploads(a.uploads).length, msgs: a.chat.length })) });
});
// ===== بایگانی لابی‌ها برای مدیر =====
db.archive = db.archive || {};
const liveUploads = l => (l || []).filter(u => Date.now() - u.at < MEDIA_TTL && fs.existsSync('uploads/' + String(u.url).slice(7)));
function recordUpload(rm, name, by, size) { (rm.uploads = rm.uploads || []).push({ url: '/media/' + name, by: by || '', at: Date.now(), size: size || 0 }); }
function archiveRoom(rm) { // لابی بسته می‌شود ولی برای مدیر می‌ماند
  if (!rm || rm.archived) return; rm.archived = true;
  const id = rm.code + '-' + (rm.at || Date.now());
  db.archive[id] = { id, code: rm.code, type: rm.type, title: rm.title, by: rm.by || '', at: rm.at || 0, closedAt: Date.now(), seen: [...(rm.seen || [])], chat: rm.chat || [], uploads: rm.uploads || [], media: rm.media || '' };
  const ids = Object.keys(db.archive); if (ids.length > 1000) ids.sort((a, b) => db.archive[a].closedAt - db.archive[b].closedAt).slice(0, ids.length - 1000).forEach(k => delete db.archive[k]);
  save();
}
function restoreRoom(id) {
  const a = db.archive[id]; if (!a || rooms[a.code]) return null;
  const r = rooms[a.code] = { code: a.code, type: a.type, title: a.title, media: a.media || '', state: { playing: false, time: 0, at: Date.now() }, members: new Map(), chat: a.chat || [], emptyAt: Date.now(), by: a.by, at: a.at, seen: new Set(a.seen || []), uploads: a.uploads || [] };
  delete db.archive[id]; save(); return r;
}
const upInfo = u => { const left = u.at + MEDIA_TTL - Date.now(); return { url: u.url, by: u.by, at: u.at, size: u.size, left: Math.max(0, left), ok: left > 0 && fs.existsSync('uploads/' + String(u.url).slice(7)) }; };
app.get('/api/admin/lobby', (q, r) => {
  if (!admin(q, r)) return;
  const id = String(q.query.id || ''), code = String(q.query.code || ''), a = id ? db.archive[id] : null, x = a || rooms[code];
  if (!x) return bad(r, 404, 'پیدا نشد');
  r.json({ live: !a, code: x.code, title: x.title, type: x.type, by: x.by || '', at: x.at || 0, closedAt: a ? a.closedAt : 0, seen: a ? a.seen : [...(x.seen || [])], now: a ? [] : names(x), chat: x.chat || [], uploads: (x.uploads || []).map(upInfo) });
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

// ===== اعلان واقعی (Web Push) بدون کتابخانه‌ی خارجی =====
const b64u = b => Buffer.from(b).toString('base64url');
const hkdf = (salt, ikm, info, len) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, len));
let VAPID = null;
function vapid() { // کلید VAPID از ADMIN_KEY ساخته می‌شود تا با ری‌استارت عوض نشود
  if (VAPID) return VAPID;
  const seed = crypto.createHmac('sha256', ADMIN_KEY).update('vapid-v1').digest(), e = crypto.createECDH('prime256v1'); e.setPrivateKey(seed);
  const pub = e.getPublicKey();
  VAPID = { pub: b64u(pub), key: crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: b64u(seed), x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) }, format: 'jwk' }) };
  return VAPID;
}
function vapidAuth(endpoint) {
  const v = vapid(), head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64u(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'https://dorham-watch.onrender.com' }));
  const sig = crypto.sign('sha256', Buffer.from(head + '.' + body), { key: v.key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${v.pub}`;
}
function encryptPush(sub, payload) { // RFC 8291 (aes128gcm)
  const ua = Buffer.from(sub.keys.p256dh, 'base64url'), auth = Buffer.from(sub.keys.auth, 'base64url');
  const as = crypto.createECDH('prime256v1'); as.generateKeys(); const asPub = as.getPublicKey(), salt = crypto.randomBytes(16);
  const prk = hkdf(auth, as.computeSecret(ua), Buffer.concat([Buffer.from('WebPush: info\0'), ua, asPub]), 32);
  const cek = hkdf(salt, prk, Buffer.from('Content-Encoding: aes128gcm\0'), 16), nonce = hkdf(salt, prk, Buffer.from('Content-Encoding: nonce\0'), 12);
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce), ct = Buffer.concat([c.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPub.length]), asPub, ct]);
}
function sendPush(sub, obj) {
  return new Promise(res => {
    try {
      const body = encryptPush(sub, JSON.stringify(obj)), u = new URL(sub.endpoint);
      const rq = (u.protocol === 'http:' ? http : https).request(u, { method: 'POST', timeout: 8000, headers: { 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', 'Content-Length': body.length, TTL: 3600, Urgency: 'high', Authorization: vapidAuth(sub.endpoint) } }, r => { r.resume(); res(r.statusCode); });
      rq.on('error', () => res(0)); rq.on('timeout', () => { rq.destroy(); res(0); }); rq.end(body);
    } catch { res(0); }
  });
}
async function pushSub(ep, obj) { const rec = db.subs[ep]; if (!rec || !ADMIN_KEY) return; const st = await sendPush(rec.sub, obj); if (st === 404 || st === 410) { delete db.subs[ep]; save(); } }
const connectedEps = () => new Set([...wss.clients].filter(w => w.readyState === 1 && w.ep).map(w => w.ep));
function pushAway(rm, except, obj) {
  if (!rm.away) return; const on = connectedEps();
  for (const [n, a] of Object.entries(rm.away)) { if (n === except || on.has(a.ep) || Date.now() - a.last < 5000 || !db.subs[a.ep]) continue; a.last = Date.now(); pushSub(a.ep, obj); }
}
function notifyNewLobby(r, by, src) { // فقط لابی‌های عمومی
  wss.clients.forEach(w => { if (w !== src && w.readyState === 1) w.send(JSON.stringify({ t: 'newlobby', code: r.code, by })); });
  const on = connectedEps();
  Object.entries(db.subs).forEach(([ep, rec]) => { if (rec.name !== by && !on.has(ep)) pushSub(ep, { title: 'لابی جدید 🎬', body: `${by} یه لابی ساخت — کد ${r.code}`, tag: 'lobby', url: '/?room=' + r.code }); });
}
db.subs = db.subs || {};
const PUSH_OK = /^https:\/\/(fcm\.googleapis\.com|android\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9.-]+\.push\.apple\.com|[a-z0-9.-]+\.notify\.windows\.com)\//;
app.get('/api/push/key', (q, r) => r.json({ key: ADMIN_KEY ? vapid().pub : '' }));
app.post('/api/push/subscribe', (q, r) => {
  const s = q.body.sub, n = String(q.body.name || '').slice(0, 20);
  const okEp = s && typeof s.endpoint === 'string' && s.endpoint.length < 700 && (PUSH_OK.test(s.endpoint) || (process.env.PUSH_ALLOW_LOCAL && /^http:\/\/localhost[:/]/.test(s.endpoint)));
  if (!ADMIN_KEY || !okEp || !s.keys || typeof s.keys.p256dh !== 'string' || typeof s.keys.auth !== 'string') return bad(r, 400, 'bad');
  if (!db.subs[s.endpoint] && Object.keys(db.subs).length >= 1000) return bad(r, 429, 'full');
  db.subs[s.endpoint] = { sub: { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } }, name: n, at: Date.now() }; save(); r.json({ ok: 1 });
});
app.post('/api/push/unsubscribe', (q, r) => { delete db.subs[String(q.body.endpoint || '')]; save(); r.json({ ok: 1 }); });

// ===== گپ‌ها (گروه‌های متنی دائمی) =====
db.chats = db.chats || {};
const chatPresent = {}, chatToks = {};
let gSaveT = 0; const saveSoon = () => { if (!gSaveT) gSaveT = setTimeout(() => { gSaveT = 0; save(); }, 2000); };
const gsend = (w, o) => { if (w.readyState === 1) w.send(JSON.stringify(o)); };
const gbcast = (c, o) => (chatPresent[c.code] || []).forEach(w => gsend(w, o));
const chatInfo = c => ({ code: c.code, title: c.title, type: c.type, count: Object.keys(c.members).length, online: (chatPresent[c.code] || new Set()).size });
const chatMembers = c => { const here = new Set([...(chatPresent[c.code] || [])].map(w => w.gname)); return Object.keys(c.members).map(n => ({ n, on: here.has(n) })); };
const chatAvs = c => { const o = {}; Object.entries(c.members).sort((a, b) => b[1].at - a[1].at).slice(0, 30).forEach(([n, v]) => { if (v.av) o[n] = v.av; }); return o; };
function gDrop(ws) {
  (ws.chatCodes || []).forEach(k => { const st = chatPresent[k], c = db.chats[k]; if (st) { st.delete(ws); if (c) gbcast(c, { t: 'gmembers', code: k, members: chatMembers(c) }); } });
}
function pushChatOffline(c, msg) {
  const here = new Set([...(chatPresent[c.code] || [])]), on = connectedEps(), body = msg.k === 's' ? 'استیکر' : msg.k === 'i' ? '🖼 تصویر / گیف' : String(msg.text).slice(0, 120);
  wss.clients.forEach(w => { if (w.gname && w.gname !== msg.name && c.members[w.gname] && !here.has(w)) gsend(w, { t: 'gnotify', code: c.code, title: c.title, by: msg.name, text: body }); });
  for (const [n, v] of Object.entries(c.members)) {
    if (n === msg.name || !v.ep || on.has(v.ep) || !db.subs[v.ep] || Date.now() - (v.last || 0) < 5000) continue;
    v.last = Date.now(); pushSub(v.ep, { title: `${msg.name} · ${c.title}`, body, tag: 'g-' + c.code, url: '/?chat=' + c.code });
  }
}
function handleG(ws, m) {
  if (m.t === 'glist') {
    const pub = Object.values(db.chats).filter(c => c.type === 'public').sort((a, b) => chatInfo(b).online - chatInfo(a).online || b.at - a.at).slice(0, 30).map(chatInfo);
    const mine = (Array.isArray(m.codes) ? m.codes.slice(0, 30) : []).map(k => db.chats[String(k)]).filter(Boolean).map(chatInfo);
    return gsend(ws, { t: 'glist', pub, mine });
  }
  const name = String(m.name || ws.gname || '').trim().slice(0, 20);
  if (!name) return gsend(ws, { t: 'gerror', msg: 'اول یک نام انتخاب کن' });
  ws.gname = name;
  if (m.t === 'gcreate') {
    const title = String(m.title || '').trim().slice(0, 30);
    if (!title) return gsend(ws, { t: 'gerror', msg: 'اسم گپ را بنویس' });
    if (Object.keys(db.chats).length >= 300) return gsend(ws, { t: 'gerror', msg: 'ظرفیت گپ‌ها پر است' });
    if (Object.values(db.chats).filter(c => c.owner === name).length >= 5) return gsend(ws, { t: 'gerror', msg: 'حداکثر ۵ گپ می‌توانی بسازی' });
    let code; do { code = String(crypto.randomInt(10000, 100000)); } while (db.chats[code]);
    db.chats[code] = { code, title, type: m.type === 'private' ? 'private' : 'public', owner: name, at: Date.now(), members: {}, msgs: [] };
    m = { ...m, t: 'gjoin', code, created: true };
  }
  if (m.t === 'gjoin') {
    const c = db.chats[String(m.code)];
    if (!c) return gsend(ws, { t: 'gerror', msg: 'گپی با این کد پیدا نشد' });
    const old = c.members[name];
    if (!old && Object.keys(c.members).length >= 100) return gsend(ws, { t: 'gerror', msg: 'این گپ پر است' });
    const av = validAv(m.av) || (old && old.av) || '';
    c.members[name] = { ep: ws.ep || (old && old.ep) || '', av, at: Date.now(), last: old ? old.last : 0 };
    (chatPresent[c.code] = chatPresent[c.code] || new Set()).add(ws); (ws.chatCodes = ws.chatCodes || new Set()).add(c.code);
    const gtok = crypto.randomBytes(8).toString('hex'); chatToks[gtok] = c.code;
    gsend(ws, { t: 'gjoined', code: c.code, title: c.title, type: c.type, owner: c.owner, created: !!m.created, members: chatMembers(c), avs: chatAvs(c), msgs: c.msgs.slice(-100), gtok });
    gbcast(c, { t: 'gmembers', code: c.code, members: chatMembers(c) });
    if (av && !old) gbcast(c, { t: 'gav', code: c.code, name, av });
    return saveSoon();
  }
  const c = db.chats[String(m.code)];
  if (!c || !c.members[name]) return;
  if (m.t === 'gleave') {
    const st = chatPresent[c.code]; if (st) st.delete(ws); if (ws.chatCodes) ws.chatCodes.delete(c.code);
    if (!m.stay) { delete c.members[name]; if (!Object.keys(c.members).length) delete db.chats[c.code]; }
    if (db.chats[c.code]) gbcast(c, { t: 'gmembers', code: c.code, members: chatMembers(c) });
    return saveSoon();
  }
  if (m.t === 'gmsg') {
    if (!chatPresent[c.code] || !chatPresent[c.code].has(ws)) return;
    const now = Date.now(); if (now - (ws.gl || 0) < 300) return; ws.gl = now;
    const msg = { id: (c.seq = (c.seq || 0) + 1), name, at: now, k: 't' };
    if (m.k === 's' && /^[a-z0-9_]{1,24}$/.test(String(m.id))) { msg.k = 's'; msg.sid = String(m.id); }
    else if (m.k === 'i' && /^\/media\/[a-f0-9]{16}\.(gif|png|jpg|webp)$/.test(String(m.url)) && fs.existsSync('uploads/' + String(m.url).slice(7))) { msg.k = 'i'; msg.url = String(m.url); }
    else { const t = String(m.text || '').trim().slice(0, 500); if (!t) return; msg.text = t; }
    c.msgs.push(msg); if (c.msgs.length > 200) c.msgs.shift();
    gbcast(c, { t: 'gmsg', code: c.code, msg }); pushChatOffline(c, msg); saveSoon();
  }
}
app.post('/chat-upload', (req, res) => {
  const code = chatToks[String(req.query.tok || '')], ext = String(req.query.ext || '').toLowerCase();
  if (!code || !db.chats[code]) return res.status(403).end('forbidden');
  if (!['gif', 'png', 'jpg', 'webp'].includes(ext)) return res.status(400).end('bad');
  const chunks = []; let n = 0, dead = false;
  req.on('data', d => { n += d.length; if (n > 8e6) { if (!dead) { dead = true; res.status(413).end(); } } else if (!dead) chunks.push(d); });
  req.on('end', () => {
    if (dead) return; const b = Buffer.concat(chunks), sig = b.subarray(0, 12).toString('latin1');
    const ok = sig.startsWith('GIF8') || (b[0] === 0x89 && sig.slice(1, 4) === 'PNG') || (b[0] === 0xff && b[1] === 0xd8) || (sig.startsWith('RIFF') && sig.slice(8, 12) === 'WEBP');
    if (!ok) return res.status(400).end('bad');
    const name = crypto.randomBytes(8).toString('hex') + '.' + ext; fs.writeFileSync('uploads/' + name, b); res.json({ url: '/media/' + name });
  });
});

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
