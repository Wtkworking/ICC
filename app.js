/* ICC Data — frontend (vanilla JS, no build step) */
const $ = (s, el = document) => el.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'html') n.innerHTML = v; else if (v !== undefined && v !== null) n.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined) n.append(k.nodeType ? k : document.createTextNode(k));
  return n;
};
const fmt = (n) => (n === null || n === undefined || n === '' ? '-' : Number(n).toLocaleString('th-TH'));
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const state = { user: null, perms: [], meta: null, cache: {}, charts: [] };
const can = (p) => state.perms.includes(p);

// URL ของ Apps Script อยู่ในไฟล์ config.js (ไม่ต้องแก้ไฟล์นี้)
const API_URL = (window.ICC_CONFIG && window.ICC_CONFIG.API_URL) || '';
const REQUIRED_API_VERSION = 3; // ต้องตรงกับ API_VERSION ใน Code.gs
const apiOk = () => /^https:\/\/script\.google\.com\/.*\/exec$/.test(API_URL);

// คิวส่งคำสั่ง: Apps Script รับคำสั่งพร้อมกันหลายอันไม่ดี ส่งทีละอันและลองใหม่เมื่อคำตอบไม่ใช่ JSON
let lanes = [Promise.resolve(), Promise.resolve()];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function callScript(payload) {
  const attempt = async () => {
    const r = await fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload), redirect: 'follow' });
    const text = await r.text();
    try { return JSON.parse(text); } catch { throw Object.assign(new Error('NOT_JSON'), { snippet: text.slice(0, 200), status: r.status }); }
  };
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try { return await attempt(); }
    catch (e) { lastErr = e; await sleep(600 * (i + 1)); }
  }
  if (lastErr.message === 'NOT_JSON') throw new Error('Google ตอบกลับช้าหรือขัดข้องชั่วคราว (ลองแล้ว 3 ครั้ง) — กดรีเฟรชหน้าอีกครั้ง ถ้ายังเป็นอยู่ให้เช็กว่า Deploy ล่าสุดเป็น Web app / Anyone');
  throw new Error('ติดต่อ Apps Script ไม่ได้ — ตรวจสอบอินเทอร์เน็ตและ URL ใน config.js');
}
let laneIdx = 0;
function enqueue(payload) {
  const i = laneIdx; laneIdx = (laneIdx + 1) % lanes.length;
  const run = lanes[i].then(() => callScript(payload));
  lanes[i] = run.catch(() => {});
  return run;
}

// แปลงคำสั่งแบบ REST ที่หน้าเว็บใช้ ให้เป็น action ที่ Apps Script เข้าใจ
async function api(url, opts = {}) {
  if (!apiOk()) { $('#apiWarn')?.classList.remove('hidden'); throw new Error('ยังไม่ได้ตั้งค่า API_URL ใน config.js'); }
  const method = (opts.method || 'GET').toUpperCase();
  const body = opts.body || {};
  const [path] = url.split('?');
  let payload = { token: localStorage.getItem('icc_token') || '' };
  let m;
  if (path === '/api/login') payload = { action: 'login', email: body.email, password: body.password };
  else if (path === '/api/logout') payload.action = 'logout';
  else if (path === '/api/me') payload.action = 'me';
  else if (path === '/api/boot') payload.action = 'boot';
  else if (path === '/api/bundle') Object.assign(payload, { action: 'bundle', tables: body.tables });
  else if (path === '/api/meta') payload.action = 'meta';
  else if (path === '/api/dashboard') payload.action = 'dashboard';
  else if (path === '/api/ai/ask') Object.assign(payload, { action: 'ai', question: body.question });
  else if (path === '/api/users') Object.assign(payload, method === 'GET' ? { action: 'users.list' } : { action: 'users.create', ...body });
  else if ((m = /^\/api\/users\/(.+)$/.exec(path))) Object.assign(payload, { action: 'users.update', id: m[1], ...body });
  else if ((m = /^\/api\/import\/(\w+)$/.exec(path))) Object.assign(payload, { action: 'import', table: m[1], rows: body.rows, commit: !!body.commit });
  else if ((m = /^\/api\/data\/(\w+)\/(.+)$/.exec(path))) Object.assign(payload, { action: method === 'DELETE' ? 'data.delete' : 'data.update', table: m[1], id: m[2], record: body });
  else if ((m = /^\/api\/data\/(\w+)$/.exec(path))) Object.assign(payload, method === 'GET' ? { action: 'data.list', table: m[1] } : { action: 'data.create', table: m[1], record: body });
  else throw new Error('ไม่รู้จักคำสั่ง ' + url);

  const data = await enqueue(payload);
  if (data.error) {
    if (data.status === 401 && path !== '/api/login') { localStorage.removeItem('icc_token'); showLogin(); }
    throw Object.assign(new Error(data.error), { data });
  }
  if (path === '/api/login') localStorage.setItem('icc_token', data.token);
  if (path === '/api/logout') localStorage.removeItem('icc_token');
  return data;
}
function toast(msg, err = false) {
  const t = $('#toast'); t.textContent = msg; t.className = `toast${err ? ' err' : ''}`;
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.add('hidden'), 3200);
}
async function loadTable(name, fresh = false) {
  if (!fresh && state.cache[name]) return state.cache[name];
  state.cache[name] = await api(`/api/data/${name}${fresh ? '?fresh=1' : ''}`);
  return state.cache[name];
}

/* ---------------- auth ---------------- */
function showLogin() { $('#login').classList.remove('hidden'); $('#app').classList.add('hidden'); }
async function boot() {
  if (!apiOk()) { showLogin(); $('#apiWarn').classList.remove('hidden'); return; }
  if (!localStorage.getItem('icc_token')) { showLogin(); return; }
  try { enter(await api('/api/boot')); }
  catch (e) { try { const me = await api('/api/me'); enter({ ...me, version: 0 }); } catch { showLogin(); } }
}
function versionBanner(v) {
  state.banner = null;
  if ((v || 0) >= REQUIRED_API_VERSION) return;
  const b = el('div', { id: 'versionBanner', class: 'notice', style: 'margin:0 0 16px' },
    el('strong', {}, 'Apps Script ยังเป็นโค้ดเวอร์ชันเก่า'), ` (พบเวอร์ชัน ${v || 'ไม่ระบุ'} ต้องการ ${REQUIRED_API_VERSION}) — บางหน้าจะทำงานไม่ครบ วิธีแก้: เปิด Apps Script → วาง Code.gs ล่าสุด → Deploy → Manage deployments → ✏️ → Version: New version → Deploy (URL เดิม)`);
  state.banner = b;
}
async function enter(me) {
  state.user = me.user; state.perms = me.permissions; state.apiVersion = me.version || 0;
  state.meta = me.tables || (await api('/api/meta')).tables;
  $('#login').classList.add('hidden'); $('#app').classList.remove('hidden');
  $('#whoami').innerHTML = `<strong>${esc(me.user.name)}</strong><br><span class="muted small">${esc(me.user.email)} · ${esc(roleLabel(me.user.role))}</span>`;
  $('#storageMode').textContent = 'เก็บข้อมูลบน Google Sheets ผ่าน Apps Script';
  for (const a of document.querySelectorAll('#nav a[data-perm]')) a.classList.toggle('hidden', !can(a.dataset.perm));
  if (state.user.role === 'admin' && !location.hash) location.hash = '#users';
  versionBanner(state.apiVersion);
  route();
}
const roleLabel = (r) => ({ executive: 'ผู้บริหาร', staff: 'เจ้าหน้าที่', admin: 'แอดมิน' }[r] || r);

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  $('#loginError').textContent = '';
  try { const me = await api('/api/login', { method: 'POST', body: { email: f.get('email'), password: f.get('password') } }); state.cache = {}; enter(me); }
  catch (err) { $('#loginError').textContent = err.message; }
});
$('#logoutBtn').addEventListener('click', async () => { try { await api('/api/logout', { method: 'POST' }); } catch (e) {} localStorage.removeItem('icc_token'); state.cache = {}; location.hash = ''; showLogin(); });

/* ---------------- routing ---------------- */
window.addEventListener('hashchange', route);
function route() {
  if (!state.user) return;
  const hash = location.hash.replace(/^#/, '') || (can('read') ? 'dashboard' : 'users');
  for (const a of document.querySelectorAll('#nav a')) a.classList.toggle('active', a.dataset.route === hash);
  closeModal();
  state.charts.forEach((c) => c.destroy()); state.charts = [];
  const main = $('#main'); main.innerHTML = '';
  if (state.banner) main.append(state.banner.cloneNode(true));
  main.append(el('div', { class: 'loading' }, el('span', { class: 'spinner' }), 'กำลังดึงข้อมูลจาก Google Sheets…'));
  const [page, arg] = hash.split('/');
  const pages = { dashboard: renderDashboard, ai: renderAI, table: () => renderTable(arg), import: renderImport, users: renderUsers };
  const guard = { dashboard: 'read', ai: 'ai', table: 'read', import: 'import', users: 'manage_users' };
  if (!can(guard[page] || 'read')) { main.append(el('div', { class: 'card' }, 'สิทธิ์ของคุณไม่สามารถเข้าหน้านี้ได้')); return; }
  const clearLoading = () => main.querySelectorAll('.loading').forEach((n) => n.remove());
  const origAppend = main.append.bind(main);
  main.append = (...a) => { clearLoading(); main.append = origAppend; origAppend(...a); };
  (pages[page] || renderDashboard)(main).then(clearLoading).catch((e) => { main.innerHTML = ''; main.append(el('div', { class: 'card error' }, e.message)); });
}

/* ---------------- dashboard ---------------- */
function chart(canvas, type, labels, datasets, opts = {}) {
  const palette = ['#1f5c3f', '#5c9c7a', '#b8791a', '#3a6ea5', '#8a5a9c', '#a83232', '#7a7f7c', '#c9b458'];
  const ds = datasets.map((d, i) => ({ ...d, backgroundColor: d.backgroundColor || (type === 'doughnut' ? palette : palette[i % palette.length]), borderWidth: type === 'doughnut' ? 2 : 0, borderColor: '#fff' }));
  const short = (l) => (String(l).length > 34 ? String(l).slice(0, 32) + '…' : l);
  const c = new Chart(canvas, { type, data: { labels: labels.map(short), datasets: ds }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: type === 'doughnut' || datasets.length > 1, position: 'right' } }, scales: type === 'doughnut' ? {} : { y: { beginAtZero: true, ticks: { precision: 0 } } }, ...opts } });
  state.charts.push(c);
}
const chartCard = (title, type, data, key = 'name', val = 'value', extra) => {
  const cv = el('canvas');
  const card = el('div', { class: 'card' }, el('h3', {}, title), el('div', { class: 'chart-wrap' }, cv));
  setTimeout(() => chart(cv, type, data.map((d) => d[key]), [{ data: data.map((d) => d[val]) }], extra), 0);
  return card;
};

async function renderDashboard(main) {
  const d = await api('/api/dashboard');
  const c = d.counts;
  const topAg = d.agency.top.find((a) => a.Students > 0);
  const lead = el('p', { class: 'lead' }, { html: '' });
  lead.innerHTML = `ตอนนี้มีนักศึกษาที่มาจากตัวแทน <b>${fmt(c.students)} คน</b> จากตัวแทน/สถาบันที่ยังมีสัญญา <b>${fmt(c.activeAgencies)} ราย</b>${topAg ? ` โดย <b>${esc(topAg.Name)}</b> ส่งมามากที่สุด ${fmt(topAg.Students)} คน` : ''} มีตัวแทนที่ยังไม่ส่งนักศึกษาเลย <b>${fmt(d.agency.zeroActive.length)} ราย</b> และฐานศิษย์เก่า <b>${fmt(c.alumni)} คน</b> ใน ${d.alumni.province.length} มณฑล`;
  main.append(el('div', { class: 'page-head' }, el('div', {}, el('h1', {}, 'ภาพรวม'), el('p', { class: 'muted' }, `ข้อมูล ณ ${new Date(d.generatedAt).toLocaleString('th-TH')}`)),
    el('div', { class: 'actions' }, can('ai') ? el('a', { href: '#ai', class: 'btn primary' }, 'ถาม AI วิเคราะห์') : null)));
  main.append(lead);

  const stat = (n, l) => el('div', { class: 'card stat' }, el('span', { class: 'n' }, fmt(n)), el('span', { class: 'l' }, l));
  main.append(el('div', { class: 'grid four', style: 'margin-bottom:16px' }, stat(c.agencies, 'ตัวแทน/สถาบันทั้งหมด'), stat(c.students, 'นักศึกษาจากตัวแทน'), stat(c.trips, `ทริป (${fmt(c.tripVisits)} จุดแวะ)`), stat(c.alumni, 'ศิษย์เก่า')));

  // agency
  main.append(el('h2', { style: 'margin-top:24px' }, 'ตัวแทนรับสมัคร'));
  const agTop = d.agency.rows.filter((r) => r.Students > 0).slice(0, 10);
  main.append(el('div', { class: 'grid two', style: 'margin-bottom:16px' },
    chartCard('นักศึกษาต่อตัวแทน (10 อันดับ)', 'bar', agTop, 'Name', 'Students', { indexAxis: 'y' }),
    chartCard('นักศึกษาแยกหลักสูตร', 'doughnut', d.studentsByProgram)));
  const zero = d.agency.zeroActive;
  main.append(el('div', { class: 'card', style: 'margin-bottom:16px' },
    el('h3', {}, `ตัวแทนที่สัญญายังใช้ได้แต่ยังไม่มีนักศึกษา (${zero.length})`),
    zero.length ? el('div', { class: 'table-wrap' }, simpleTable(['ชื่อ', 'ประเภท', 'สิ้นสุดสัญญา', 'มณฑล', 'ผู้ดูแล'], zero.map((r) => [r.Name, r.Category, r.ContractEnd || '-', r.Province, r.Owner]))) : el('p', { class: 'muted' }, 'ไม่มี — ทุกตัวแทนที่มีสัญญามีนักศึกษาแล้ว')));
  main.append(el('div', { class: 'card', style: 'margin-bottom:16px' }, el('h3', {}, 'ผลงานตามอาจารย์ผู้ดูแล'),
    el('div', { class: 'table-wrap' }, simpleTable(['อาจารย์ผู้ดูแล', 'ตัวแทนที่ดูแล', 'นักศึกษารวม'], d.agency.byOwner.map((o) => [o.name, fmt(o.agencies), fmt(o.students)]), [false, true, true]))));

  // trips
  main.append(el('h2', { style: 'margin-top:24px' }, 'ทริป — คุ้มหรือไม่'));
  const tripRows = d.trips.map((t) => [t.Name, t.Year, fmt(t.Budget), fmt(t.Visits), t.Provinces.join(', '), fmt(t.GoalTotal), fmt(t.MOU), fmt(t.Leads), fmt(t.AttributedStudents), t.CostPerStudent ? fmt(t.CostPerStudent) : '-', fmt(t.AlumniOnRoute)]);
  main.append(el('div', { class: 'card', style: 'margin-bottom:16px' }, el('div', { class: 'table-wrap' },
    simpleTable(['ทริป', 'ปี', 'งบ (บาท)', 'จุดแวะ', 'มณฑล', 'เป้า (คน)', 'MOU', 'Lead', 'นศ.ที่ได้', 'ต้นทุน/คน', 'ศิษย์เก่าในเส้นทาง'], tripRows, [false, true, true, true, false, true, true, true, true, true, true])),
    d.trips.some((t) => t.Note) ? el('div', { class: 'notice' }, 'บางทริปยังไม่ได้ผูกจุดแวะกับตัวแทน/สถาบัน (ช่อง "ตัวแทน/สถาบันที่เกี่ยวข้อง" ในจุดแวะ) และยังไม่ได้บันทึกผล MOU/lead — เมื่อบันทึกแล้ว ระบบจะคำนวณนักศึกษาที่ได้และต้นทุนต่อหัวให้อัตโนมัติ') : null));

  // alumni
  main.append(el('h2', { style: 'margin-top:24px' }, 'ศิษย์เก่า'));
  main.append(el('div', { class: 'grid three' },
    chartCard('เพศ', 'doughnut', d.alumni.gender.map((g) => ({ name: { M: 'ชาย', F: 'หญิง' }[g.name] || g.name, value: g.value }))),
    chartCard('ช่วงอายุ', 'bar', d.alumni.ageRange),
    chartCard('หลักสูตร', 'doughnut', d.alumni.program)));
  main.append(el('div', { class: 'grid two', style: 'margin-top:16px' },
    chartCard('อุตสาหกรรม', 'bar', d.alumni.industry, 'name', 'value', { indexAxis: 'y' }),
    chartCard('มณฑลที่อยู่ (15 อันดับ)', 'bar', d.alumni.province, 'name', 'value', { indexAxis: 'y' })));
}
function simpleTable(heads, rows, numeric = []) {
  return el('table', {}, el('thead', {}, el('tr', {}, heads.map((h, i) => el('th', { class: numeric[i] ? 'num' : '' }, h)))),
    el('tbody', {}, rows.map((r) => el('tr', {}, r.map((c, i) => el('td', { class: numeric[i] ? 'num' : '', title: String(c ?? '') }, c ?? '-'))))));
}

/* ---------------- AI ---------------- */
async function renderAI(main) {
  main.append(el('div', { class: 'page-head' }, el('div', {}, el('h1', {}, 'ถาม AI วิเคราะห์'), el('p', { class: 'muted' }, 'คำตอบอิงจากตัวเลขที่ระบบคำนวณจากข้อมูลจริง ไม่ส่งชื่อ เบอร์โทร หรือพาสปอร์ตออกไป'))));
  const q = el('textarea', { placeholder: 'เช่น ตัวแทนไหนหานักศึกษาได้น้อยทั้งที่สัญญายังเหลืออีกนาน', rows: 3 });
  const ans = el('div', { class: 'ai-answer muted' }, 'พิมพ์คำถามหรือเลือกจากตัวอย่างด้านขวา');
  const btn = el('button', { class: 'btn primary', onclick: run }, 'ถาม');
  const modelTag = el('span', { class: 'muted small' });
  async function run() {
    if (!q.value.trim()) return;
    btn.disabled = true; ans.className = 'ai-answer muted'; ans.textContent = 'กำลังวิเคราะห์...';
    try { const r = await api('/api/ai/ask', { method: 'POST', body: { question: q.value } }); ans.className = 'ai-answer'; ans.textContent = r.answer; modelTag.textContent = `โมเดล: ${r.model}`; }
    catch (e) { ans.className = 'ai-answer error'; ans.textContent = e.message; }
    btn.disabled = false;
  }
  const examples = ['ตัวแทนไหนหานักศึกษาได้มากที่สุดปีนี้ และมาจากหลักสูตรอะไร', 'ตัวแทนไหนสัญญายังไม่หมดแต่ยังไม่ส่งนักศึกษาเลย ควรทำอย่างไร', 'ทริปแต่ละทริปคุ้มไหม ได้อะไรกลับมาบ้าง', 'อาจารย์คนไหนดูแลตัวแทนที่มีผลงานดีที่สุด', 'ศิษย์เก่าส่วนใหญ่อยู่มณฑลไหน ควรจัดทริปไปที่ไหนต่อ'];
  main.append(el('div', { class: 'ai-box' },
    el('div', { class: 'card' }, q, el('div', { class: 'actions', style: 'margin:10px 0 16px' }, btn, modelTag), ans),
    el('div', { class: 'card' }, el('h3', {}, 'ตัวอย่างคำถาม'), el('div', { class: 'chips' }, examples.map((x) => el('button', { class: 'chip', onclick: () => { q.value = x; run(); } }, x))))));
}

/* ---------------- generic table page ---------------- */
async function renderTable(name) {
  const main = $('#main');
  const meta = state.meta[name];
  if (!meta) { main.append(el('div', { class: 'card' }, 'ไม่พบตาราง')); return; }
  const need = [name, ...meta.fields.filter((f) => f.type === 'select' && f.options && !Array.isArray(f.options)).map((f) => f.options.table).filter((t) => !state.cache[t])];
  let bundle = null;
  if (state.apiVersion >= 3) { try { bundle = await api('/api/bundle', { method: 'POST', body: { tables: [...new Set(need)] } }); } catch (e) { bundle = null; } }
  if (bundle && Array.isArray(bundle[name])) Object.assign(state.cache, bundle);
  else state.cache[name] = await loadTable(name, true); // โค้ด Apps Script เก่า: ขอทีละตาราง
  const rows = state.cache[name]; const lookups = await loadLookups(meta);
  const label = (f, v) => {
    if (f.type === 'boolean') return v === true || ['true', 'TRUE', '1'].includes(String(v)) ? 'ใช่' : '';
    if (f.type === 'select' && f.options && !Array.isArray(f.options)) { const m = lookups[f.key]; return (m && m[v]) || v; }
    return v;
  };
  const shown = meta.fields.filter((f) => f.type !== 'textarea').slice(0, 9);
  let query = '', sortKey = 'ID', sortDir = 1, page = 0; const PAGE = 50;
  const head = el('div', { class: 'page-head' },
    el('div', {}, el('h1', {}, meta.label), el('p', { class: 'muted' }, `${fmt(rows.length)} รายการ`)),
    el('div', { class: 'actions' },
      el('input', { class: 'search', placeholder: 'ค้นหา...', oninput: (e) => { query = e.target.value.toLowerCase(); page = 0; draw(); } }),
      can('export') ? el('button', { class: 'btn', onclick: () => exportXlsx(name, rows, meta) }, 'ดาวน์โหลด Excel') : null,
      can('import') ? el('a', { class: 'btn', href: `#import` }, 'นำเข้าไฟล์') : null,
      can('create') ? el('button', { class: 'btn primary', onclick: () => openForm(name, null, () => renderTable(name)) }, '+ เพิ่มข้อมูล') : null));
  const wrap = el('div', { class: 'table-wrap' }); const pager = el('div', { class: 'pager' });
  main.innerHTML = ''; if (state.banner) main.append(state.banner.cloneNode(true)); main.append(head, wrap, pager);
  function draw() {
    const filtered = rows.filter((r) => !query || Object.values(r).some((v) => String(v).toLowerCase().includes(query)));
    filtered.sort((a, b) => String(a[sortKey] ?? '').localeCompare(String(b[sortKey] ?? ''), undefined, { numeric: true }) * sortDir);
    const slice = filtered.slice(page * PAGE, page * PAGE + PAGE);
    const th = (k, text) => el('th', { onclick: () => { if (sortKey === k) sortDir *= -1; else { sortKey = k; sortDir = 1; } draw(); } }, text + (sortKey === k ? (sortDir > 0 ? ' ↑' : ' ↓') : ''));
    wrap.innerHTML = '';
    wrap.append(el('table', {}, el('thead', {}, el('tr', {}, th('ID', 'ID'), shown.map((f) => th(f.key, f.label)), el('th', {}, ''))),
      el('tbody', {}, slice.length ? slice.map((r) => el('tr', {}, el('td', {}, r.ID), shown.map((f) => el('td', { title: String(label(f, r[f.key]) ?? '') }, label(f, r[f.key]) ?? '')),
        el('td', { class: 'row-actions' },
          can('update') ? el('button', { class: 'btn ghost small', onclick: () => openForm(name, r, () => renderTable(name)) }, 'แก้ไข') : el('button', { class: 'btn ghost small', onclick: () => openForm(name, r, null, true) }, 'ดู'),
          can('delete') ? el('button', { class: 'btn ghost small danger', onclick: () => del(name, r) }, 'ลบ') : null)))
        : el('tr', {}, el('td', { colspan: shown.length + 2, class: 'muted' }, query ? 'ไม่พบข้อมูลที่ค้นหา' : 'ยังไม่มีข้อมูล — กด "เพิ่มข้อมูล" หรือนำเข้าจากไฟล์ Excel')))));
    pager.innerHTML = '';
    const pages = Math.max(1, Math.ceil(filtered.length / PAGE));
    pager.append(`หน้า ${page + 1} / ${pages} (${fmt(filtered.length)} รายการ)`,
      el('button', { class: 'btn small', disabled: page === 0 ? '' : null, onclick: () => { page--; draw(); } }, 'ก่อนหน้า'),
      el('button', { class: 'btn small', disabled: page >= pages - 1 ? '' : null, onclick: () => { page++; draw(); } }, 'ถัดไป'));
  }
  draw();
}
async function loadLookups(meta) {
  const out = {};
  for (const f of meta.fields) {
    if (f.type === 'select' && f.options && !Array.isArray(f.options)) {
      const src = await loadTable(f.options.table);
      out[f.key] = Object.fromEntries(src.map((r) => [r[f.options.value], r[f.options.label]]));
    }
  }
  return out;
}
async function del(name, r) {
  if (!confirm(`ลบ ${r.ID} ออกจาก ${state.meta[name].label}?`)) return;
  try { await api(`/api/data/${name}/${r.ID}`, { method: 'DELETE' }); toast('ลบแล้ว'); renderTable(name); } catch (e) { toast(e.message, true); }
}
function exportXlsx(name, rows, meta) {
  const cols = ['ID', ...meta.fields.map((f) => f.key), 'CreatedAt', 'CreatedBy', 'UpdatedAt', 'UpdatedBy'];
  const ws = XLSX.utils.json_to_sheet(rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c] ?? '']))), { header: cols });
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, name);
  XLSX.writeFile(wb, `${name}_${new Date().toISOString().slice(0, 10)}.xlsx`);
}

/* ---------------- form modal ---------------- */
async function openForm(name, record, onDone, readOnly = false) {
  const meta = state.meta[name];
  const form = $('#modalForm'); form.innerHTML = '';
  $('#modalTitle').textContent = (readOnly ? 'ดูข้อมูล: ' : record ? 'แก้ไข: ' : 'เพิ่ม: ') + meta.label + (record ? ` (${record.ID})` : '');
  const grid = el('div', { class: 'form-grid' });
  for (const f of meta.fields) {
    let input;
    const v = record ? record[f.key] : (f.default ?? '');
    if (f.type === 'select') {
      input = el('select', { name: f.key }, el('option', { value: '' }, '— เลือก —'));
      let opts = Array.isArray(f.options) ? f.options.map((o) => [o, o]) : (await loadTable(f.options.table)).map((r) => [r[f.options.value], `${r[f.options.label]}${f.options.value !== f.options.label ? ` (${r[f.options.value]})` : ''}`]);
      for (const [val, lab] of opts) input.append(el('option', { value: val, selected: String(val) === String(v) ? '' : null }, lab));
    } else if (f.type === 'boolean') {
      input = el('input', { type: 'checkbox', name: f.key }); if (v === true || ['true', 'TRUE', '1'].includes(String(v))) input.checked = true;
    } else if (f.type === 'textarea') input = el('textarea', { name: f.key }, String(v ?? ''));
    else input = el('input', { name: f.key, type: f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text', value: String(v ?? ''), step: f.type === 'number' ? 'any' : null });
    if (readOnly) input.disabled = true;
    if (f.required && !readOnly) input.required = true;
    const lab = el('label', { class: f.type === 'textarea' ? 'full' : f.type === 'boolean' ? 'check' : '' });
    if (f.type === 'boolean') lab.append(input, f.label); else lab.append(f.label + (f.required ? ' *' : ''), input);
    grid.append(lab);
  }
  const err = el('p', { class: 'error full' });
  grid.append(err, el('div', { class: 'form-foot' }, el('button', { type: 'button', class: 'btn', onclick: closeModal }, readOnly ? 'ปิด' : 'ยกเลิก'), readOnly ? null : el('button', { type: 'submit', class: 'btn primary' }, record ? 'บันทึกการแก้ไข' : 'บันทึก')));
  form.append(grid);
  form.onsubmit = async (e) => {
    e.preventDefault(); err.textContent = '';
    const body = {};
    for (const f of meta.fields) { const i = form.elements[f.key]; body[f.key] = f.type === 'boolean' ? i.checked : i.value; }
    try {
      if (record) await api(`/api/data/${name}/${record.ID}`, { method: 'PATCH', body }); else await api(`/api/data/${name}`, { method: 'POST', body });
      toast(record ? 'บันทึกการแก้ไขแล้ว' : 'บันทึกแล้ว'); delete state.cache[name]; closeModal(); onDone && onDone();
    } catch (e2) { err.textContent = e2.message; }
  };
  $('#modal').classList.remove('hidden');
}
function closeModal() { $('#modal').classList.add('hidden'); }
$('#modalClose').addEventListener('click', closeModal);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });

/* ---------------- import ---------------- */
async function renderImport(main) {
  const names = Object.keys(state.meta);
  const sel = el('select', {}, names.map((n) => el('option', { value: n }, state.meta[n].label)));
  const file = el('input', { type: 'file', accept: '.xlsx,.xls,.csv' });
  const zone = el('div', { class: 'dropzone' }, el('p', {}, 'ลากไฟล์ Excel/CSV มาวางที่นี่ หรือเลือกไฟล์'), file);
  const out = el('div');
  main.append(el('div', { class: 'page-head' }, el('div', {}, el('h1', {}, 'นำเข้าไฟล์ Excel'), el('p', { class: 'muted' }, 'ระบบจะจับคู่คอลัมน์ให้อัตโนมัติจากชื่อหัวตาราง ตรวจสอบก่อน แล้วค่อยยืนยันนำเข้า'))));
  main.append(el('div', { class: 'card', style: 'margin-bottom:16px' }, el('label', {}, 'นำเข้าไปที่ตาราง', sel), el('div', { style: 'margin-top:14px' }, zone),
    el('p', { class: 'muted small', style: 'margin-top:10px' }, 'เคล็ดลับ: ดาวน์โหลด Excel จากหน้าตารางนั้นก่อน แล้วใช้เป็นแบบฟอร์มกรอก หัวคอลัมน์จะตรงกันพอดี · ถ้าไฟล์มีคอลัมน์ ID ระบบจะใช้ ID นั้น (ถ้าซ้ำจะออกใหม่)')), out);
  ['dragover', 'dragleave', 'drop'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.toggle('over', ev === 'dragover'); if (ev === 'drop') handle(e.dataTransfer.files[0]); }));
  file.addEventListener('change', () => handle(file.files[0]));

  async function handle(f) {
    if (!f) return;
    const name = sel.value; const meta = state.meta[name];
    const buf = await f.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array', cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const raw = XLSX.utils.sheet_to_json(ws, { defval: '' });
    if (!raw.length) { out.innerHTML = ''; out.append(el('div', { class: 'card error' }, 'ไฟล์ไม่มีข้อมูล (ต้องมีหัวตารางในแถวแรก)')); return; }
    const srcCols = Object.keys(raw[0]);
    const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9\u0e00-\u0e7f\u4e00-\u9fff]/g, '');
    const mapping = {}; // field key -> source col
    for (const fld of meta.fields) {
      mapping[fld.key] = srcCols.find((c) => norm(c) === norm(fld.key)) || srcCols.find((c) => norm(c) === norm(fld.label)) || srcCols.find((c) => norm(c).includes(norm(fld.key))) || '';
    }
    const toVal = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v);
    const mapTable = el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'ฟิลด์ในระบบ'), el('th', {}, 'คอลัมน์ในไฟล์'), el('th', {}, 'ตัวอย่างค่า'))),
      el('tbody', {}, meta.fields.map((fld) => {
        const s = el('select', { onchange: (e) => { mapping[fld.key] = e.target.value; } }, el('option', { value: '' }, '— ไม่นำเข้า —'), srcCols.map((c) => el('option', { value: c, selected: mapping[fld.key] === c ? '' : null }, c)));
        return el('tr', {}, el('td', {}, fld.label + (fld.required ? ' *' : '')), el('td', {}, s), el('td', { class: 'muted' }, mapping[fld.key] ? String(toVal(raw[0][mapping[fld.key]])).slice(0, 40) : ''));
      })));
    const result = el('div', { style: 'margin-top:14px' });
    const idCol = srcCols.find((c) => norm(c) === 'id');
    const build = () => raw.map((r) => Object.assign(idCol ? { ID: r[idCol] } : {}, Object.fromEntries(meta.fields.map((fld) => [fld.key, mapping[fld.key] ? toVal(r[mapping[fld.key]]) : '']))));
    const checkBtn = el('button', { class: 'btn', onclick: async () => {
      result.innerHTML = 'กำลังตรวจสอบ...';
      try {
        const res = await api(`/api/import/${name}`, { method: 'POST', body: { rows: build(), commit: false } });
        result.innerHTML = '';
        result.append(el('p', {}, `ทั้งหมด ${fmt(res.total)} แถว · ผ่าน ${fmt(res.valid)} · ผิด ${fmt(res.problems.length)}`));
        if (res.problems.length) result.append(el('div', { class: 'table-wrap', style: 'max-height:260px' }, simpleTable(['แถว', 'ปัญหา'], res.problems.slice(0, 200).map((p) => [p.row, p.errors.join('; ')]))));
        commitBtn.disabled = res.problems.length > 0;
      } catch (e) { result.innerHTML = ''; result.append(el('p', { class: 'error' }, e.message)); }
    } }, 'ตรวจสอบข้อมูล');
    const commitBtn = el('button', { class: 'btn primary', disabled: '', onclick: async () => {
      commitBtn.disabled = true;
      try { const res = await api(`/api/import/${name}`, { method: 'POST', body: { rows: build(), commit: true } }); toast(`นำเข้า ${fmt(res.imported)} แถวแล้ว`); delete state.cache[name]; location.hash = `#table/${name}`; }
      catch (e) { toast(e.message, true); commitBtn.disabled = false; }
    } }, 'ยืนยันนำเข้า');
    out.innerHTML = '';
    out.append(el('div', { class: 'card' }, el('h3', {}, `${f.name} — ${fmt(raw.length)} แถว → ${meta.label}`), el('div', { class: 'table-wrap' }, mapTable),
      el('div', { class: 'actions', style: 'margin-top:14px' }, checkBtn, commitBtn), result));
  }
}

/* ---------------- users ---------------- */
async function renderUsers(main) {
  const users = await api('/api/users');
  const roles = ['executive', 'staff', 'admin'];
  main.append(el('div', { class: 'page-head' }, el('div', {}, el('h1', {}, 'ผู้ใช้ระบบ'), el('p', { class: 'muted' }, 'ผู้บริหารทำได้ทุกอย่าง · เจ้าหน้าที่กรอกและดูข้อมูล · แอดมินจัดการผู้ใช้')),
    el('button', { class: 'btn primary', onclick: () => userForm(null) }, '+ เพิ่มผู้ใช้')));
  main.append(el('div', { class: 'table-wrap' }, el('table', {}, el('thead', {}, el('tr', {}, ['ID', 'อีเมล', 'ชื่อ', 'สิทธิ์', 'สถานะ', ''].map((h) => el('th', {}, h)))),
    el('tbody', {}, users.map((u) => el('tr', {}, el('td', {}, u.ID), el('td', {}, u.Email), el('td', {}, u.Name), el('td', {}, el('span', { class: 'tag' }, roleLabel(u.Role))),
      el('td', {}, u.Active === true || ['true', 'TRUE', '1'].includes(String(u.Active)) ? 'ใช้งาน' : el('span', { class: 'tag bad' }, 'ระงับ')),
      el('td', { class: 'row-actions' }, el('button', { class: 'btn ghost small', onclick: () => userForm(u) }, 'แก้ไข'))))))));

  function userForm(u) {
    const form = $('#modalForm'); form.innerHTML = '';
    $('#modalTitle').textContent = u ? `แก้ไขผู้ใช้ ${u.Email}` : 'เพิ่มผู้ใช้';
    const grid = el('div', { class: 'form-grid' },
      el('label', {}, 'อีเมล *', el('input', { name: 'Email', type: 'email', value: u?.Email || '', disabled: u ? '' : null, required: '' })),
      el('label', {}, 'ชื่อ *', el('input', { name: 'Name', value: u?.Name || '', required: '' })),
      el('label', {}, 'สิทธิ์ *', el('select', { name: 'Role' }, roles.map((r) => el('option', { value: r, selected: u?.Role === r ? '' : null }, roleLabel(r))))),
      el('label', {}, u ? 'ตั้งรหัสผ่านใหม่ (เว้นว่างถ้าไม่เปลี่ยน)' : 'รหัสผ่าน * (อย่างน้อย 6 ตัว)', el('input', { name: 'Password', type: 'password', required: u ? null : '' })),
      u ? el('label', { class: 'check' }, el('input', { name: 'Active', type: 'checkbox', checked: (u.Active === true || ['true', 'TRUE', '1'].includes(String(u.Active))) ? '' : null }), 'เปิดใช้งานบัญชี') : null);
    const err = el('p', { class: 'error full' });
    grid.append(err, el('div', { class: 'form-foot' }, el('button', { type: 'button', class: 'btn', onclick: closeModal }, 'ยกเลิก'), el('button', { type: 'submit', class: 'btn primary' }, 'บันทึก')));
    form.append(grid);
    form.onsubmit = async (e) => {
      e.preventDefault(); err.textContent = '';
      const f = form.elements;
      const body = { Name: f.Name.value, Role: f.Role.value };
      if (f.Password.value) body.Password = f.Password.value;
      try {
        if (u) { body.Active = f.Active.checked; await api(`/api/users/${u.ID}`, { method: 'PATCH', body }); }
        else { body.Email = f.Email.value; await api('/api/users', { method: 'POST', body }); }
        toast('บันทึกแล้ว'); closeModal(); route();
      } catch (e2) { err.textContent = e2.message; }
    };
    $('#modal').classList.remove('hidden');
  }
}

boot();
