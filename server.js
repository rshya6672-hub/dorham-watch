const express = require('express'), http = require('http'), fs = require('fs'), crypto = require('crypto');
const { WebSocketServer } = require('ws');
const app = express();
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
  r.json(Object.values(rooms).filter(x => x.type === 'public').map(x => ({ code: x.code, title: x.title, count: x.members.size }))));
app.post('/api/support', (q, r) => {
  db.support.push({ name: String(q.body.name || '').slice(0, 40), text: String(q.body.text || '').slice(0, 1000), t: Date.now() });
  save(); r.json({ ok: 1 });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const names = rm => [...rm.members.values()];
const bcast = (rm, msg, except) => rm.members.forEach((n, w) => { if (w !== except && w.readyState === 1) w.send(JSON.stringify(msg)); });
const curTime = s => s.time + (s.playing ? (Date.now() - s.at) / 1000 : 0);

function leave(ws) {
  const rm = rooms[ws.room]; if (!rm) return;
  rm.members.delete(ws); ws.room = null;
  if (!rm.members.size) delete rooms[rm.code];
  else bcast(rm, { t: 'members', members: names(rm) });
}

wss.on('connection', ws => {
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    const rm = rooms[ws.room];
    if (m.t === 'create' || m.t === 'join') {
      leave(ws);
      let r;
      if (m.t === 'create') {
        const c = code();
        r = rooms[c] = { code: c, type: m.type === 'private' ? 'private' : 'public', title: `لابی ${String(m.name).slice(0, 20)}`, media: '', state: { playing: false, time: 0, at: Date.now() }, members: new Map() };
      } else {
        r = rooms[m.code];
        if (!r) return ws.send(JSON.stringify({ t: 'error', msg: 'لابی‌ای با این کد پیدا نشد' }));
      }
      ws.room = r.code; r.members.set(ws, String(m.name).slice(0, 20));
      const tok = crypto.randomBytes(8).toString('hex'); upToks[tok] = { code: r.code, name: String(m.name).slice(0, 20) };
      ws.send(JSON.stringify({ t: 'joined', tok, code: r.code, media: r.media, playing: r.state.playing, time: curTime(r.state), members: names(r) }));
      bcast(r, { t: 'members', members: names(r) }, ws);
      if (m.t === 'create') { db.scores[m.name] = (db.scores[m.name] || 0) + 5; save(); }
    } else if (rm) {
      if (m.t === 'media') { rm.media = String(m.url); rm.state = { playing: false, time: 0, at: Date.now() }; bcast(rm, { t: 'media', url: rm.media }); }
      else if (['play', 'pause', 'seek'].includes(m.t)) {
        const time = Number(m.time) || 0;
        rm.state = { playing: m.t === 'play' ? true : m.t === 'pause' ? false : rm.state.playing, time, at: Date.now() };
        bcast(rm, { t: m.t, time }, ws);
      } else if (m.t === 'chat') bcast(rm, { t: 'chat', name: rm.members.get(ws), text: String(m.text).slice(0, 300) });
    }
  });
  ws.on('close', () => leave(ws));
});

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
  out.on('finish', () => { if (bad) return; bcast(rm, { t: 'chat', name: u.name, text: '🎤', voice: '/media/' + name, dur }); res.json({ ok: 1 }); });
});
// پاک کردن فایل‌های قدیمی‌تر از ۱۲ ساعت
setInterval(() => fs.readdirSync('uploads').forEach(f => {
  const p = 'uploads/' + f; if (Date.now() - fs.statSync(p).mtimeMs > 12 * 3600e3) fs.unlink(p, () => {});
}), 3600e3);

server.listen(process.env.PORT || 3000, () => console.log('Dor Ham running on port', process.env.PORT || 3000));
