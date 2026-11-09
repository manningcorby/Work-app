// Shared helpers for popup and background. Loaded as a classic script in the
// popup and via importScripts in the service worker.

const WT = (() => {
  const DEFAULT_CATEGORIES = [
    { key: 'CASH', letter: 'c' },
    { key: 'TV ADMIN', letter: 't' },
    { key: 'ENTREP', letter: 'e' },
    { key: 'BETS', letter: 'b' }
  ];

  const AUTO_PUSH_MINUTES = 240;
  const IS_APP = typeof window !== 'undefined' && !!window.__WORK_APP__;

  // Fixed targets: a floor, not a ceiling.
  const TARGETS = { logged: 180, cash: 60, days: 6 };

  // A session can carry more than one category, stored as "CASH, ENTREP" (same as a Sheets multi-select dropdown).
  function splitCats(v) { return String(v || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean).filter((c, i, a) => a.indexOf(c) === i); }
  function joinCats(list) { return splitCats((list || []).join(',')).join(', '); }
  function hasCat(v, k) { return splitCats(v).includes(k); }

  // Stable colour per category, so the same category looks the same every week.
  const CAT_COLORS = {
    'CASH': '#008300', 'TV ADMIN': '#2a78d6', 'WALL WIZARD': '#eb6834', 'SHEERS': '#e87ba4',
    'ENTREP': '#6250d6', 'BETS': '#e34948', 'LIFE ADMIN': '#1baf7a', 'LIFE': '#eda100'
  };
  const EXTRA_COLORS = ['#8F8B83', '#9C7A54', '#4F8A8B', '#A35C7A', '#6B7F3A', '#5B6475'];
  function catColor(k) {
    k = String(k || '').toUpperCase();
    if (CAT_COLORS[k]) return CAT_COLORS[k];
    let h = 0; for (let i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) >>> 0;
    return EXTRA_COLORS[h % EXTRA_COLORS.length];
  }

  function pad(n) { return String(n).padStart(2, '0'); }

  function dateLabel(d = new Date()) {
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return `${days[d.getDay()]} ${d.getDate()}/${d.getMonth() + 1}/${String(d.getFullYear()).slice(-2)}`;
  }

  function shortDate(d = new Date()) {
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${days[d.getDay()]} ${d.getDate()} ${months[d.getMonth()]}`;
  }

  function hhmm(d) { return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }

  // 0:45 style, used for the Hours column and totals
  function hoursText(minutes) {
    const m = Math.max(0, Math.round(minutes));
    return `${Math.floor(m / 60)}:${pad(m % 60)}`;
  }

  // "53 min" / "1 h 12 min", used for the live timer
  function elapsedText(minutes) {
    const m = Math.max(0, Math.floor(minutes));
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60), r = m % 60;
    return r ? `${h} h ${r} min` : `${h} h`;
  }

  // Accepts "14:10", "1410", "2:05pm", "14.10"
  function parseClock(text) {
    if (!text) return null;
    const t = String(text).trim().toLowerCase();
    let m = t.match(/^(\d{1,2})[:.]?(\d{2})\s*(am|pm)?$/);
    if (!m) return null;
    let h = Number(m[1]), min = Number(m[2]);
    if (m[3] === 'pm' && h < 12) h += 12;
    if (m[3] === 'am' && h === 12) h = 0;
    if (h > 23 || min > 59) return null;
    return { h, min };
  }

  // Accepts "45", "45m", "1:05", "1h 5m", "1.5h"
  function parseDuration(text) {
    if (!text) return null;
    const t = String(text).trim().toLowerCase();
    let m;
    if ((m = t.match(/^(\d+):(\d{1,2})$/))) return Number(m[1]) * 60 + Number(m[2]);
    if ((m = t.match(/^(\d+(?:\.\d+)?)\s*h(?:\s*(\d+)\s*m?)?$/))) return Math.round(Number(m[1]) * 60) + Number(m[2] || 0);
    if ((m = t.match(/^(\d+)\s*m(?:in)?$/))) return Number(m[1]);
    if ((m = t.match(/^(\d+)$/))) return Number(m[1]);
    return null;
  }

  function minutesBetween(start, end) {
    let a = start.h * 60 + start.min, b = end.h * 60 + end.min;
    if (b < a) b += 24 * 60; // crossed midnight
    return b - a;
  }

  const storage = {
    get: (keys) => new Promise(res => chrome.storage.local.get(keys, res)),
    set: (obj) => new Promise(res => chrome.storage.local.set(obj, res)),
    remove: (keys) => new Promise(res => chrome.storage.local.remove(keys, res))
  };

  async function api(action, payload) {
    const { webAppUrl } = await storage.get('webAppUrl');
    if (!webAppUrl) throw new Error('NO_URL');
    const res = await fetch(webAppUrl, {
      method: 'POST',
      redirect: 'follow',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, ...payload })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return data;
  }

  async function fetchSummary() {
    const { webAppUrl } = await storage.get('webAppUrl');
    if (!webAppUrl) throw new Error('NO_URL');
    const url = webAppUrl + (webAppUrl.includes('?') ? '&' : '?') + 'action=summary&t=' + Date.now();
    const res = await fetch(url, { redirect: 'follow' });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return data;
  }

  // ---------- daily plan (Second Brain › Today) ----------
  async function fetchPlan() {
    const { webAppUrl } = await storage.get('webAppUrl');
    if (!webAppUrl) throw new Error('NO_URL');
    const url = webAppUrl + (webAppUrl.includes('?') ? '&' : '?') + 'action=plan&t=' + Date.now();
    const res = await fetch(url, { redirect: 'follow' });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return data;
  }

  const RITUAL_CATS = ['HYGIENE', 'SETUP', 'SET UP', 'RITUAL'];
  function isRitual(r) { return RITUAL_CATS.includes(String(r.category || '').toUpperCase()) || !!String(r.items || '').trim(); }

  // "Teeth ✓, Face, Sunscreen" <-> [{ name, done }]
  function parseItems(text) {
    return String(text || '').split(/[,;\n]/).map(x => x.trim()).filter(Boolean).map(x => {
      const done = /✓$/.test(x) || /^\[x\]/i.test(x);
      return { name: x.replace(/\s*✓$/, '').replace(/^\[x\]\s*/i, '').replace(/^\[ \]\s*/, '').trim(), done };
    });
  }
  function formatItems(list) { return list.map(i => i.name + (i.done ? ' ✓' : '')).join(', '); }

  // Same rule as the sheet: the row it was aimed at if it still holds that task,
  // otherwise the one row today with that task (exact, then "one contains the other").
  function normTask(v) { return String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
  function findPlanRow(rows, payload) {
    const want = normTask(payload.task);
    const at = rows.find(x => x.row === payload.row);
    if (at && (!want || normTask(at.task) === want)) return at;
    if (!want) return null;
    const exact = rows.filter(x => normTask(x.task) === want);
    if (exact.length) return exact.length === 1 ? exact[0] : null;
    const near = rows.filter(x => { const t = normTask(x.task); return t && (t.includes(want) || want.includes(t)); });
    return near.length === 1 ? near[0] : null;
  }

  // Copy-paste fallback: today's rows as the popup sees them, laid over a fresh read of the sheet,
  // grouped into runs of consecutive rows so each block pastes into one range.
  // Returns [{ range: 'F12:J19', tsv, noteRange: 'L12:L19', noteTsv }].
  function sheetCopy(fresh, local) {
    const rows = ((fresh && fresh.rows) || []).slice().sort((a, b) => a.row - b.row);
    const mine = (local && local.rows) || [];
    const clean = v => String(v == null ? '' : v).replace(/[\t\r\n]+/g, ' ').trim();
    const lines = rows.map(r => {
      const m = findPlanRow(mine, { row: r.row, task: r.task }) || r;
      return { row: r.row, f: [m.status || 'todo', m.start || '', m.end || '', m.actual || '', m.items || ''].map(clean).join('\t'), l: clean(m.note) };
    });
    const runs = [];
    lines.forEach(x => { const last = runs[runs.length - 1]; if (last && x.row === last[last.length - 1].row + 1) last.push(x); else runs.push([x]); });
    return runs.map(run => {
      const a = run[0].row, z = run[run.length - 1].row;
      return { range: `F${a}:J${z}`, tsv: run.map(x => x.f).join('\n'), noteRange: `L${a}:L${z}`, noteTsv: run.map(x => x.l).join('\n') };
    });
  }

  // Plan as it will be once queued plan writes land.
  function applyPlanOps(plan, ops) {
    if (!plan) return plan;
    const p = JSON.parse(JSON.stringify(plan));
    (ops || []).forEach(op => {
      if (op.action !== 'planUpdate' || op.status === 'sent') return;
      const r = findPlanRow(p.rows || [], op.payload);
      if (!r) return;
      ['status', 'start', 'end', 'actual', 'items', 'note'].forEach(k => { if (op.payload[k] !== undefined) r[k] = op.payload[k]; });
      r.pending = true;
    });
    return p;
  }

  // Push a finished (or in-progress) session. Updates in place if the
  // 4-hour auto push already created the row.
  async function pushSession(session, endDate) {
    const start = new Date(session.startedAt);
    const payload = {
      date: dateLabel(start),
      task: session.task || '',
      category: session.category || '',
      start: hhmm(start),
      end: endDate ? hhmm(endDate) : '',
      hours: endDate ? hoursText((endDate - start) / 60000) : ''
    };
    if (session.pushedId) {
      return api('update', { id: session.pushedId, ...payload });
    }
    return api('append', payload);
  }

  // ---------- outbox: local-first writes ----------
  // Every sheet write is an op in storage.outbox. The popup applies ops to its
  // cached summary immediately; the background worker sends them in order.
  // op: { id, action: 'append'|'update'|'delete', tempId?, entryId?, payload, status: 'pending'|'sent'|'failed', error? }
  // An append gets a tempId until the sheet answers with the row's entryId; later ops may target either.

  function newId() { return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  // Local journal: every session or edit is written here the moment it happens,
  // before any sync. Nothing removes entries except the user on the settings page.
  const JOURNAL_MAX = 400;
  async function journal(entry) {
    const { journal = [] } = await storage.get('journal');
    journal.push({ at: Date.now(), ...entry });
    while (journal.length > JOURNAL_MAX) journal.shift();
    await storage.set({ journal });
  }
  async function journalMark(opId, status, note, st) {
    const S = st || storage;
    const { journal = [] } = await S.get('journal');
    let changed = false;
    journal.forEach(j => { if (j.opId === opId) { j.status = status; if (note) j.note = note; changed = true; } });
    if (changed) await S.set({ journal });
  }

  async function enqueue(op) {
    const { outbox = [] } = await storage.get('outbox');
    op.id = op.id || newId();
    op.status = 'pending';
    op.createdAt = Date.now();
    outbox.push(op);
    await storage.set({ outbox });
    try { await chrome.runtime.sendMessage({ type: 'flush' }); } catch (e) { /* worker may be asleep; alarm covers it */ }
    return op;
  }

  // Fold ops into a copy of the cached summary so the UI shows the sheet as
  // it will be once everything is sent.
  function applyOps(summary, ops) {
    if (!summary) return summary;
    const s = JSON.parse(JSON.stringify(summary));
    const list = s.today.list || [];
    const find = (op) => list.findIndex(it => (op.entryId && it.id === op.entryId) || (op.tempId && it.tempId === op.tempId));
    (ops || []).forEach(op => {
      if (op.status === 'sent') return; // already in the refreshed summary
      const p = op.payload || {};
      if (op.action === 'append') {
        list.push({ id: null, tempId: op.tempId, task: p.task || '', category: p.category || '', start: p.start || null, end: p.end || null, minutes: p.hours ? hmToMinutes(p.hours) : 0, pending: true, failed: op.status === 'failed' });
      } else if (op.action === 'update') {
        const i = find(op); if (i < 0) return;
        const it = list[i];
        if (p.task !== undefined) it.task = p.task;
        if (p.category !== undefined) it.category = p.category;
        if (p.start !== undefined) it.start = p.start || null;
        if (p.end !== undefined) it.end = p.end || null;
        if (p.hours !== undefined) it.minutes = p.hours ? hmToMinutes(p.hours) : 0;
        it.pending = true; it.failed = op.status === 'failed';
      } else if (op.action === 'delete') {
        const i = find(op); if (i >= 0) list.splice(i, 1);
      }
    });
    s.today.list = list;
    s.today.minutes = 0; s.today.sessions = 0; s.today.byCategory = {}; s.today.firstStart = null;
    list.forEach(it => {
      if (!it.minutes) return;
      s.today.minutes += it.minutes; s.today.sessions += 1;
      (splitCats(it.category).length ? splitCats(it.category) : ['OTHER']).forEach(c => { s.today.byCategory[c] = (s.today.byCategory[c] || 0) + it.minutes; });
      if (it.start && (!s.today.firstStart || it.start < s.today.firstStart)) s.today.firstStart = it.start;
    });
    return s;
  }

  function hmToMinutes(t) { const m = String(t).match(/(\d+):(\d{1,2})/); return m ? Number(m[1]) * 60 + Number(m[2]) : 0; }

  // Send pending ops in order. Stops at the first failure so later ops that
  // depend on an earlier append keep their place. Returns { sent, failed }.
  // Send pending ops in order. A refused op no longer blocks the queue: only
  // later ops on the *same* entry wait behind it, everything else goes through.
  // Returns { sent, failed }.
  async function flushOutbox(deps) {
    const d = deps || { storage, api, fetchSummary, fetchPlan };
    let { outbox = [], idMap = {}, summary = null } = await d.storage.get(['outbox', 'idMap', 'summary']);
    if (!outbox.length) return { sent: 0, failed: 0 };
    const keyOf = (op) => op.action === 'planUpdate' ? 'plan:' + (op.payload && op.payload.row) : (op.entryId || (op.tempId && idMap[op.tempId]) || op.tempId || null);

    // Which sheet row does this op mean? Persistent map first, then the
    // matching open row in today's sheet (the 4 hour auto-push case).
    const resolve = (op) => {
      if (op.entryId) return op.entryId;
      if (op.tempId && idMap[op.tempId]) return idMap[op.tempId];
      const a = outbox.find(o => o.action === 'append' && o.tempId === op.tempId && o.status === 'sent' && o.entryId);
      if (a) return a.entryId;
      const p = op.payload || {};
      if (summary && summary.today && p.start) {
        const hit = (summary.today.list || []).find(it => it.id && it.start === p.start && !it.end && (!p.task || !it.task || it.task === p.task));
        if (hit) return hit.id;
      }
      return null;
    };
    const appendStillQueued = (op) => op.tempId && outbox.some(o => o !== op && o.action === 'append' && o.tempId === op.tempId && o.status === 'pending');

    const blocked = new Set();   // entry keys with a refused op ahead of them
    let sent = 0, failed = 0;
    for (const op of outbox) {
      if (op.status === 'sent') continue;
      const key = keyOf(op);
      if (op.status === 'failed') { failed++; if (key) blocked.add(key); continue; }
      if (key && blocked.has(key)) { op.error = 'waiting on an earlier change to this entry'; continue; }
      try {
        let res;
        if (op.action === 'planUpdate') {
          res = await d.api('planUpdate', op.payload);
          // the sheet found the task on another row (the plan was reordered): aim later writes there too
          if (res && res.row && res.row !== op.payload.row) {
            const old = op.payload.row, t = normTask(op.payload.task);
            outbox.forEach(o => { if (o !== op && o.action === 'planUpdate' && o.status !== 'sent' && o.payload.row === old && normTask(o.payload.task) === t) o.payload.row = res.row; });
            op.payload.row = res.row;
          }
        } else if (op.action === 'append') {
          res = await d.api('append', op.payload);
          op.entryId = res.id; op.row = res.row;
          if (op.tempId && res.id) idMap[op.tempId] = res.id;
        } else {
          const id = resolve(op);
          if (!id) {
            if (appendStillQueued(op)) { op.error = 'waiting for the entry to reach the sheet'; continue; }
            if (op.action === 'delete') { res = { ok: true }; }           // nothing in the sheet to delete
            else {
              // The row it meant to change never made it: write the session as a new row instead.
              const p = op.payload || {};
              const date = p.date || dateLabel(new Date(op.createdAt || Date.now()));
              res = await d.api('append', { date, task: p.task || '', category: p.category || '', start: p.start || '', end: p.end || '', hours: p.hours || '' });
              op.entryId = res.id; if (op.tempId && res.id) idMap[op.tempId] = res.id;
              op.converted = true;
            }
          } else {
            op.entryId = id;
            res = await d.api(op.action, { id, ...(op.payload || {}) });
          }
        }
        op.status = 'sent'; delete op.error; sent++;
        if (res && res.parked) { op.parked = true; op.error = res.error; await journalMark(op.id, 'parked', res.error, d.storage); }
        else await journalMark(op.id, 'synced', null, d.storage);
        await d.storage.set({ outbox, idMap });
      } catch (e) {
        const msg = (e && e.message) || String(e);
        const network = msg === 'Failed to fetch' || /NetworkError|network|timeout|NO_URL/i.test(msg);
        if (network) { op.error = 'offline'; await d.storage.set({ outbox, idMap }); break; }  // nothing else will get through either
        op.status = 'failed'; op.error = msg; failed++;
        if (key) blocked.add(key);
        await journalMark(op.id, 'failed', msg, d.storage);
        await d.storage.set({ outbox, idMap });
      }
    }
    // keep the id map from growing forever
    const keys = Object.keys(idMap); if (keys.length > 500) { keys.slice(0, keys.length - 500).forEach(k => delete idMap[k]); }
    if (sent) {
      // Refresh from the sheet first, then drop the sent ops in the same write,
      // so the UI never flickers between "pending" and "gone".
      try {
        const fresh = await d.fetchSummary();
        const { outbox: latest = [] } = await d.storage.get('outbox');
        const parked = latest.filter(o => o.status === 'sent' && o.parked).length;
        const write = { summary: fresh, sheetUrl: fresh.sheetUrl, outbox: latest.filter(o => o.status !== 'sent'), idMap, lastSyncAt: Date.now(), lastParked: parked ? Date.now() : 0 };
        if (d.fetchPlan && latest.some(o => o.status === 'sent' && o.action === 'planUpdate')) {
          try { write.plan = await d.fetchPlan(); } catch (e) { /* keep cached plan */ }
        }
        await d.storage.set(write);
      } catch (e) { /* keep sent ops marked; next flush drops them */ }
    }
    return { sent, failed };
  }

  // One-off unstick after an update: give every refused op another go
  // under the new rules.
  async function retryFailed(st) {
    const S = st || storage;
    const { outbox = [] } = await S.get('outbox');
    let n = 0;
    outbox.forEach(o => { if (o.status === 'failed') { o.status = 'pending'; delete o.error; n++; } });
    if (n) await S.set({ outbox });
    return n;
  }

  return {
    DEFAULT_CATEGORIES, AUTO_PUSH_MINUTES, IS_APP, TARGETS, splitCats, joinCats, hasCat, catColor, normTask, findPlanRow, sheetCopy,
    newId, enqueue, applyOps, flushOutbox, retryFailed, journal, journalMark,
    fetchPlan, isRitual, parseItems, formatItems, applyPlanOps,
    pad, dateLabel, shortDate, hhmm, hoursText, elapsedText,
    parseClock, parseDuration, minutesBetween,
    storage, api, fetchSummary, pushSession
  };
})();

if (typeof self !== 'undefined') self.WT = WT;
if (typeof module !== 'undefined') module.exports = { WT };
