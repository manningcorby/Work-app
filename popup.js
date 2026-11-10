/* global WT */
(() => {
  const $ = (id) => document.getElementById(id);
  const app = $('app');
  const taskInput = $('taskInput');
  const bubblesEl = $('bubbles');
  const catLabel = $('catLabel');
  const timerBtn = $('timerBtn');
  const timerText = $('timerText');
  const timerTask = $('timerTask');
  const toast = $('toast');

  let session = null;        // { startedAt, task, category, state, pushedTempId }
  let baseSummary = null;    // last summary from the sheet
  let outbox = [];           // ops not yet confirmed by the sheet
  let summary = null;        // baseSummary with outbox applied (what we show)
  let loading = false;
  let page = 0;
  let tickHandle = null;
  let customCats = [];       // categories added with +, remembered
  let journalCache = [];     // local record of every session, survives reloads and forgets
  let planCache = null;     // today's plan from Second Brain › Today
  let planView = null;      // planCache with queued plan writes applied
  const expanded = new Set(); // ritual rows the user has opened
  const dailyGoal = WT.TARGETS.logged;   // 3:00 logged a day
  const cashGoal = WT.TARGETS.cash;       // 1:00 of CASH a day

  // ---------- boot ----------
  (async function boot() {
    const st = await WT.storage.get(['session', 'summary', 'outbox', 'journal', 'plan', 'webAppUrl', 'sheetUrl', 'customCats', 'page', 'liveAt', 'liveDirty', 'deviceId']);
    liveAt = st.liveAt || 0; liveDirty = !!st.liveDirty;
    deviceId = st.deviceId || (WT.IS_APP ? 'app-' : 'ext-') + WT.newId();
    if (!st.deviceId) WT.storage.set({ deviceId });
    journalCache = st.journal || [];
    planCache = st.plan || null;
    session = st.session || null;
    baseSummary = st.summary || null;
    outbox = st.outbox || [];
    recompute();
    customCats = st.customCats || [];
    chrome.storage.onChanged.addListener(onStorageChange);
    $('hdrDate').textContent = WT.shortDate(new Date());
    if (st.sheetUrl) $('sheetBtn').href = st.sheetUrl;

    renderState(false);
    renderSummary();
    setPage(0, false);

    if (!st.webAppUrl) {
      showSetup();
    } else {
      refreshSummary();
    }
    if (!session) taskInput.focus();
    startTick();
    chrome.runtime.sendMessage({ type: 'flush' }).catch(() => {});
  })();

  // Today's sessions that live only in the local journal (refused, forgotten,
  // or parked in _inbox) are folded in, so nothing worked today ever drops
  // out of view or out of the total.
  function journalExtras() {
    const today = WT.dateLabel(new Date());
    const queued = new Set(outbox.map(o => o.id));
    return journalCache
      .filter(j => j.action !== 'delete' && ['failed', 'forgotten', 'parked'].includes(j.status) && !queued.has(j.opId))
      .filter(j => (j.date || WT.dateLabel(new Date(j.at))) === today && (j.hours || j.start))
      .map(j => ({ id: 'j' + j.at, action: 'append', tempId: 'j' + j.at, status: 'failed', journalAt: j.at, payload: { task: j.task || '', category: j.category || '', start: j.start || '', end: j.end || '', hours: j.hours || '' } }));
  }
  function recompute() {
    summary = WT.applyOps(baseSummary, outbox.concat(journalExtras()));
    planView = WT.applyPlanOps(planCache, outbox);
  }

  async function resendFromJournal(at) {
    const all = (await WT.storage.get('journal')).journal || [];
    const j = all.find(x => x.at === at);
    if (!j) return;
    const op = { action: 'append', tempId: WT.newId(), payload: { date: j.date || WT.dateLabel(new Date(j.at)), task: j.task || '', category: j.category || '', start: j.start || '', end: j.end || '', hours: j.hours || '' } };
    op.id = WT.newId(); op.status = 'pending';
    j.opId = op.id; j.status = 'pending'; delete j.note;
    await WT.storage.set({ journal: all });
    journalCache = all;
    outbox.push(op);
    recompute(); renderSummary(); renderSync();
    await WT.enqueue(op);
    showToast('Sending ' + (j.task || 'session') + ' to the sheet');
  }
  async function resendAllFromJournal() {
    const ats = journalExtras().map(x => x.journalAt);
    for (const at of ats) await resendFromJournal(at);
    return ats.length;
  }

  // Background worker and other popups write to storage; mirror it here.
  function onStorageChange(changes, area) {
    if (area !== 'local') return;
    let dirty = false;
    if (changes.summary) { baseSummary = changes.summary.newValue || null; dirty = true; }
    if (changes.journal) { journalCache = changes.journal.newValue || []; dirty = true; }
    if (changes.plan) { planCache = changes.plan.newValue || null; dirty = true; }
    if (changes.outbox) {
      const before = outbox.length, after = (changes.outbox.newValue || []).length;
      outbox = changes.outbox.newValue || [];
      if (before > 0 && after === 0) {
        WT.storage.get('lastParked').then(r => showToast(r.lastParked && Date.now() - r.lastParked < 10000 ? 'Saved to the _inbox tab (sheet refused the row)' : 'Saved to sheet'));
      }
      dirty = true;
    }
    if (changes.session) {
      // the 4 hour auto push marks the session from the worker; keep our copy in step
      const nv = changes.session.newValue || null;
      if (JSON.stringify(nv) !== JSON.stringify(session)) { session = nv; renderState(false); }
    }
    if (dirty) { recompute(); renderSummary(); }
    renderSync();
  }

  // header sync control: faint when idle, spins while sending or loading, ! when a write failed.
  // Click: push anything queued and re-read the sheet.
  function renderSync() {
    const el = $('sync');
    const failed = outbox.filter(o => o.status === 'failed').concat(journalExtras());
    const pending = outbox.filter(o => o.status === 'pending');
    el.className = 'sync' + (failed.length ? ' failed' : (pending.length || loading ? ' busy' : ''));
    el.title = failed.length ? (failed[0].error || 'Not in the sheet yet, tap to send') : (pending.length ? `Sending ${pending.length}…` : (loading ? 'Loading…' : 'Sync with sheet'));
  }
  $('sync').addEventListener('click', syncNow);
  // The ring: push everything, including today's sessions that only exist in
  // the local journal, then re-read the sheet. A refused entry no longer stops
  // the rest; it is reported after everything else has gone through.
  async function syncNow() {
    loading = true; renderSync();
    const resent = await resendAllFromJournal();
    const had = outbox.filter(o => o.status === 'pending').length;
    try { await chrome.runtime.sendMessage({ type: 'flush' }); } catch (e) { /* worker asleep; fall through */ }
    await refreshSummary();
    const left = (await WT.storage.get('outbox')).outbox || [];
    outbox = left; recompute(); renderSummary();
    loading = false; renderSync();
    const refused = left.filter(o => o.status === 'failed');
    if (refused.length) { showToast(`${refused.length} refused, rest synced`); showFailed(refused[0]); }
    else if (left.length) showToast('Still sending, will retry');
    else showToast(had || resent ? `Synced · ${had} sent` : 'Up to date');
  }
  function showFailed(op) {
    $('failMsg').textContent = op.error || 'Could not write to the sheet';
    $('failOverlay').hidden = false;
    $('failRetry').onclick = async () => {
      op.status = 'pending'; delete op.error;
      await WT.storage.set({ outbox });
      $('failOverlay').hidden = true;
      chrome.runtime.sendMessage({ type: 'flush' }).catch(() => {});
    };
    $('failNoCat').hidden = !(op.payload && op.payload.category);
    $('failCopy').hidden = op.action !== 'planUpdate';
    $('failCopy').onclick = () => { $('failOverlay').hidden = true; openSyncByHand(); };
    $('failNoCat').onclick = async () => {
      op.payload.category = ''; op.status = 'pending'; delete op.error;
      await WT.storage.set({ outbox });
      recompute(); renderSummary();
      $('failOverlay').hidden = true;
      chrome.runtime.sendMessage({ type: 'flush' }).catch(() => {});
    };
    $('failDrop').onclick = async () => {
      // drop the op and anything that depended on it
      const drop = new Set([op.id]);
      if (op.tempId) outbox.forEach(o => { if (o.tempId === op.tempId) drop.add(o.id); });
      outbox = outbox.filter(o => !drop.has(o.id));
      await WT.storage.set({ outbox });
      for (const id of drop) await WT.journalMark(id, 'forgotten', 'kept in the local journal, see settings');
      $('failOverlay').hidden = true;
      recompute(); renderSummary(); renderSync();
    };
  }

  // ---------- state ----------
  function stateOf() { return session ? session.state : 'idle'; }

  async function saveSession(fromLive) {
    if (session) await WT.storage.set({ session });
    else await WT.storage.remove('session');
    if (!fromLive) markLive();
  }

  // ---------- running session shared between devices ----------
  // Every change to the session is stamped and sent (debounced); whichever device
  // changed it last wins, so starting on the Mac and stopping on the phone works.
  let liveAt = 0, liveDirty = false, deviceId = '', liveTimer = null;
  function markLive() {
    liveAt = Date.now(); liveDirty = true;
    WT.storage.set({ liveAt, liveDirty: true });
    clearTimeout(liveTimer); liveTimer = setTimeout(pushLive, 1200);
  }
  function liveCopy(s) {
    if (!s) return null;
    const c = { ...s }; delete c.pushedTempId;   // that row id only means something on this device
    return c;
  }
  async function pushLive() {
    if (!liveDirty) return;
    const at = liveAt;
    try {
      const res = await WT.api('live', { at, session: liveCopy(session), device: deviceId });
      if (liveAt === at) { liveDirty = false; await WT.storage.set({ liveDirty: false }); }
      if (res && res.stale && res.live) adoptLive(res.live);
    } catch (e) { /* offline: retried on the next refresh */ }
  }
  async function adoptLive(live) {
    if (!live || !live.at || live.at <= liveAt || live.device === deviceId) return;
    const had = session && session.state === 'focus';
    liveAt = live.at; liveDirty = false;
    session = live.session ? { ...live.session } : null;
    await WT.storage.set({ liveAt, liveDirty: false });
    await saveSession(true);
    renderState(false); updateTimer(); renderSummary();
    const now = session && session.state === 'focus';
    if (now) chrome.runtime.sendMessage({ type: 'session-started', startedAt: session.startedAt }).catch(() => {});
    else chrome.runtime.sendMessage({ type: 'session-ended' }).catch(() => {});
    if (now && !had) showToast(`Running from your other device · ${session.task || ''}`);
    else if (had && !now) showToast('Stopped on your other device');
  }

  function renderState(animateIntro) {
    const s = stateOf();
    app.dataset.state = s;
    taskInput.value = session ? (session.task || '') : '';
    taskInput.readOnly = s === 'bubbles' || s === 'focus';
    taskInput.placeholder = s === 'idle' ? 'Start now' : 'Task';
    if (s === 'bubbles') renderBubbles(bubblesEl, session.category, null);
    catLabel.textContent = session && s === 'focus' ? WT.splitCats(session.category).join(' + ') : '';

    if (s === 'focus') {
      updateTimer();
      if (animateIntro) playIntro();
      timerTask.textContent = session.task || '';
    }
    // only grab focus on the home page, or the hidden input drags the page strip sideways
    if (s === 'typing' && page === 0) { taskInput.focus({ preventScroll: true }); taskInput.setSelectionRange(taskInput.value.length, taskInput.value.length); }
    if (s === 'bubbles' || s === 'focus') taskInput.blur();
    if (s === 'idle' && page === 0) { taskInput.focus({ preventScroll: true }); }
    renderHeaderTotal();
    renderDay();
  }

  // ---------- bubbles ----------
  function allCategories() {
    const list = WT.DEFAULT_CATEGORIES.map(c => ({ ...c }));
    customCats.forEach(k => { if (!list.find(c => c.key === k)) list.push({ key: k, letter: null }); });
    return list;
  }

  function renderBubbles(container, selected, onPick) {
    container.innerHTML = '';
    allCategories().forEach(c => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'bubble' + (WT.hasCat(selected, c.key) ? ' selected' : '');
      b.dataset.key = c.key;
      const icon = iconFor(c.key);
      const label = c.letter ? `<u>${c.key[0]}</u>${c.key.slice(1)}` : c.key;
      b.innerHTML = `${icon}<span>${label}</span>`;
      b.addEventListener('click', (e) => {
        e.preventDefault();
        const cur = [...container.querySelectorAll('.selected')].map(x => x.dataset.key);
        // Shift (or ⌘) click adds a second category, or takes one off, without leaving the picker
        if ((e.shiftKey || e.metaKey || e.ctrlKey) && container._onMulti) {
          const next = cur.includes(c.key) ? cur.filter(k => k !== c.key) : cur.concat([c.key]);
          container._onMulti(WT.joinCats(next)); return;
        }
        if (cur.length === 1 && cur[0] === c.key) { container._onDeselect && container._onDeselect(); return; }
        container._onPick && container._onPick(c.key);
      });
      container.appendChild(b);
    });
    if (onPick) container._onPick = onPick;
    const plus = document.createElement('button');
    plus.type = 'button';
    plus.className = 'bubble plus';
    plus.setAttribute('aria-label', 'Add a category');
    plus.innerHTML = '<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M5 1 V9 M1 5 H9"/></svg>';
    plus.addEventListener('click', () => customBubble(container));
    container.appendChild(plus);
  }

  function customBubble(container) {
    const plus = container.querySelector('.plus');
    const wrap = document.createElement('span');
    wrap.className = 'bubble custom-input';
    const inp = document.createElement('input');
    inp.placeholder = 'CATEGORY';
    inp.setAttribute('aria-label', 'New category');
    wrap.appendChild(inp);
    container.replaceChild(wrap, plus);
    inp.focus();
    const done = async (commit) => {
      const val = inp.value.trim().toUpperCase();
      if (commit && val) {
        if (!customCats.includes(val)) { customCats.push(val); await WT.storage.set({ customCats }); }
        container._onPick && container._onPick(val);
        return;
      }
      renderBubbles(container, WT.joinCats([...container.querySelectorAll('.selected')].map(x => x.dataset.key)), container._onPick);
    };
    inp.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); done(true); if (container === bubblesEl) setTimeout(enterFocus, 0); }
      if (e.key === 'Escape') { e.preventDefault(); done(false); }
    });
    inp.addEventListener('blur', () => setTimeout(() => { if (document.body.contains(inp)) done(false); }, 120));
  }

  function iconFor(key) {
    const k = key.toUpperCase();
    const svg = (p) => `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">${p}</svg>`;
    if (k === 'CASH') return svg('<path d="M6 1.5 V10.5 M8.5 3.6 C8.5 2.8 7.5 2.3 6 2.3 C4.6 2.3 3.6 2.9 3.6 3.9 C3.6 6 8.4 5.4 8.4 7.9 C8.4 9 7.3 9.7 6 9.7 C4.6 9.7 3.5 9.1 3.5 8.2"/>');
    if (k === 'TV ADMIN') return svg('<rect x="1" y="2" width="10" height="6.5" rx="1"/><path d="M4 10.5 H8"/>');
    if (k === 'ENTREP') return svg('<path d="M1.5 9.5 L4.5 5.5 L7 7.5 L10.5 2.5 M7.5 2.5 H10.5 V5.5"/>');
    if (k === 'BETS') return svg('<path d="M1.5 10.5 H10.5 M3 10.5 V6 M6 10.5 V2.5 M9 10.5 V4.5"/>');
    return svg('<circle cx="6" cy="6" r="4.2"/>');
  }

  // ---------- flow ----------
  async function startSession(initialText) {
    session = { startedAt: Date.now(), task: initialText || '', category: 'CASH', state: 'typing', pushedTempId: null };
    await saveSession();
    chrome.runtime.sendMessage({ type: 'session-started', startedAt: session.startedAt }).catch(() => {});
    renderState(false);
  }

  async function lockTask() {
    const t = taskInput.value.trim();
    if (!t) return;
    session.task = t;
    session.state = 'bubbles';
    await saveSession();
    renderState(false);
  }

  async function unlockTask() {
    session.state = 'typing';
    await saveSession();
    renderState(false);
  }

  async function enterFocus() {
    if (!session) return;
    session.state = 'focus';
    await saveSession();
    renderState(true);
  }

  async function stopSession() {
    if (!session || session.state !== 'focus') return;
    const start = new Date(session.startedAt), end = new Date();
    const mins = Math.max(1, Math.round((end - start) / 60000));
    const payload = { task: session.task || '', category: session.category || '', start: WT.hhmm(start), end: WT.hhmm(end), hours: WT.hoursText(mins) };
    const done = session;
    session = null;
    await saveSession();
    chrome.runtime.sendMessage({ type: 'session-ended' }).catch(() => {});
    renderState(false);
    showToast(`Logged ${WT.hoursText(mins)} · ${payload.task}`);
    let op;
    if (done.pushedTempId) op = { action: 'update', tempId: done.pushedTempId, payload: { date: WT.dateLabel(start), ...payload } };
    else op = { action: 'append', tempId: WT.newId(), payload: { date: WT.dateLabel(start), ...payload } };
    await localOp(op);
    if (done.planRow) {
      const actual = WT.hoursText((done.planPrevActualMin || 0) + mins);
      await planOp({ row: done.planRow, task: done.planTask, status: 'done', actual });
      askNote(done);
    }
  }

  // Optional progress note after stopping a plan item. Finished keeps it done; Not finished puts it back in progress.
  function askNote(done) {
    const ov = $('noteOverlay'), txt = $('noteText');
    $('noteTitle').textContent = 'Logged · ' + (done.planTask || done.task || '');
    txt.value = ''; ov.hidden = false;
    setTimeout(() => txt.focus(), 30);
    const close = () => { ov.hidden = true; document.removeEventListener('keydown', onKey, true); };
    const save = async (finished) => {
      const note = txt.value.trim();
      close();
      if (!note && finished) return;
      const p = { row: done.planRow, task: done.planTask };
      if (note) p.note = note;
      if (!finished) p.status = 'in progress';
      await planOp(p);
      if (page === 1) renderDay();
    };
    const onKey = (e) => {
      if (ov.hidden) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
      else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); save(true); }
    };
    document.addEventListener('keydown', onKey, true);
    $('noteDone').onclick = () => save(true);
    $('notePart').onclick = () => save(false);
    $('noteClose').onclick = close;
  }

  // Sync by hand: lay what the popup knows over a fresh read of the plan, show it as paste-ready blocks.
  async function openSyncByHand() {
    const ov = $('syncOverlay'), steps = $('syncSteps');
    steps.innerHTML = '<span class="hint">Reading the sheet…</span>';
    ov.hidden = false;
    let fresh = null;
    try { fresh = await WT.fetchPlan(); } catch (e) { fresh = null; }
    const local = WT.applyPlanOps(planCache, outbox);
    const blocks = WT.sheetCopy(fresh || planCache, local);
    if (!blocks.length) { steps.innerHTML = '<span class="hint">No plan rows for today.</span>'; return; }
    steps.innerHTML = '';
    const hasNotes = blocks.some(b => b.noteTsv.replace(/\n/g, '').trim());
    blocks.forEach(b => {
      const add = (label, range, text) => {
        const btn = document.createElement('button'); btn.className = 'sync-step';
        btn.innerHTML = `<span>${label}</span><b class="mono">Today!${range}</b>`;
        btn.onclick = async () => {
          try { await navigator.clipboard.writeText(text); btn.classList.add('copied'); btn.querySelector('span').textContent = 'Copied, paste into'; }
          catch (e) { showToast('Could not copy'); }
        };
        steps.appendChild(btn);
      };
      add('Copy status, actual, ticks', b.range, b.tsv);
      if (hasNotes) add('Copy progress notes', b.noteRange, b.noteTsv);
    });
    if (!fresh) steps.insertAdjacentHTML('afterbegin', '<span class="hint">Could not reach the sheet, using the last copy.</span>');
    $('syncClose').onclick = () => { ov.hidden = true; };
    $('syncDone').onclick = async () => {
      // the sheet now has it by hand: stop retrying the plan writes that failed
      outbox = outbox.filter(o => !(o.action === 'planUpdate' && o.status === 'failed'));
      await WT.storage.set({ outbox });
      ov.hidden = true;
      recompute(); renderSummary(); renderSync();
      chrome.runtime.sendMessage({ type: 'flush' }).catch(() => {});
    };
  }

  // Plan writes go through the same queue, but not the session journal.
  async function planOp(payload) {
    const op = { action: 'planUpdate', payload, id: WT.newId(), status: 'pending' };
    outbox.push(op);
    recompute(); renderSummary(); renderSync();
    await WT.enqueue(op);
  }

  // Apply an op locally right away, then hand it to the background worker.
  async function localOp(op) {
    op.id = WT.newId(); op.status = 'pending';
    // journal first, so the record exists locally before anything else can go wrong
    await WT.journal({ opId: op.id, action: op.action, status: 'pending', ...(op.payload || {}) });
    outbox.push(op);
    recompute(); renderSummary(); renderSync();
    await WT.enqueue(op);
  }

  async function discardSession() {
    if (!session) return;
    const was = session;
    session = null;
    if (was.planRow) planOp({ row: was.planRow, task: was.planTask, status: was.planPrevStatus || 'todo' });
    await saveSession();
    chrome.runtime.sendMessage({ type: 'session-ended' }).catch(() => {});
    renderState(false);
    showToast('Discarded');
  }

  // ---------- timer ----------
  function startTick() {
    if (tickHandle) clearInterval(tickHandle);
    tickHandle = setInterval(() => { updateTimer(); renderHeaderTotal(); if (page === 1 || page === 2) renderSummary(); }, 15000);
  }

  function elapsedMinutes() { return session ? (Date.now() - session.startedAt) / 60000 : 0; }

  function renderTimerEst() {
    const el = $('timerEst');
    if (!session || !session.planEstMin) { el.textContent = ''; return; }
    const total = (session.planPrevActualMin || 0) + elapsedMinutes();
    el.textContent = '/ ' + WT.hoursText(session.planEstMin);
    el.classList.toggle('over', total > session.planEstMin);
  }
  function updateTimer() {
    renderTimerEst();
    if (!session || session.state !== 'focus') return;
    const text = WT.elapsedText(elapsedMinutes());
    if (timerBtn.classList.contains('intro')) return; // intro renders its own spans
    timerText.textContent = text;
  }

  function playIntro() {
    const text = WT.elapsedText(elapsedMinutes());
    timerText.innerHTML = '';
    let delay = 0.15;
    text.split(/(\s+)/).forEach(part => {
      if (!part) return;
      if (/^\s+$/.test(part)) { timerText.appendChild(document.createTextNode(' ')); return; }
      for (const ch of part) {
        const s = document.createElement('span');
        s.className = 'ch'; s.textContent = ch; s.style.animationDelay = delay + 's';
        timerText.appendChild(s); delay += 0.08;
      }
    });
    timerBtn.classList.add('intro');
    setTimeout(() => { timerBtn.classList.remove('intro'); updateTimer(); }, 1800);
  }

  function showToast(msg) {
    toast.textContent = msg;
    toast.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { toast.hidden = true; }, 2600);
  }

  // ---------- summary / stats ----------
  async function refreshSummary() {
    loading = true; renderSync();
    try {
      if (liveDirty) await pushLive();
      const s = await WT.fetchSummary();
      baseSummary = s;
      await adoptLive(s.live);
      await WT.storage.set({ summary: s, sheetUrl: s.sheetUrl });
      if (s.sheetUrl) $('sheetBtn').href = s.sheetUrl;
      recompute(); renderSummary();
    } catch (e) { /* keep cached */ }
    finally { loading = false; renderSync(); }
    refreshPlan();
  }
  async function refreshPlan() {
    try {
      const pl = await WT.fetchPlan();
      planCache = pl;
      await WT.storage.set({ plan: pl });
      recompute(); renderDay();
    } catch (e) { /* keep cached plan */ }
  }

  function todayMinutes() {
    const base = summary ? summary.today.minutes : 0;
    return base + (session && session.state === 'focus' ? elapsedMinutes() : 0);
  }

  function renderHeaderTotal() {
    $('hdrTotal').textContent = WT.hoursText(todayMinutes());
  }

  // live session minutes per category (a two-category session counts in full for each)
  function liveByCat() {
    if (!(session && session.state === 'focus')) return {};
    const m = elapsedMinutes(), out = {};
    (WT.splitCats(session.category).length ? WT.splitCats(session.category) : ['OTHER']).forEach(c => { out[c] = m; });
    return out;
  }
  function todayByCat() {
    const out = { ...(summary ? summary.today.byCategory : {}) };
    const live = liveByCat(); for (const k in live) out[k] = (out[k] || 0) + live[k];
    return out;
  }

  // Meter: red while filling, green once full, neon green when every target on the page is full.
  function setMeter(el, value, goal, allDone) {
    if (!el) return;
    const full = value >= goal;
    el.querySelector('span').style.width = Math.min(100, goal ? (value / goal) * 100 : 0) + '%';
    el.classList.toggle('full', full && !allDone);
    el.classList.toggle('neon', full && !!allDone);
    el.setAttribute('aria-valuenow', String(value)); el.setAttribute('aria-valuemax', String(goal));
  }

  // Lap bar: fills red to the goal, turns green when hit, glows when every target is hit.
  // Past the goal each full lap settles into a gold line underneath and a new green lap starts.
  // o.cash / o.cashGoal shade the cash part and put a dot at the cash target (first lap only).
  const LAP_GRACE = 15; // minutes a just-hit bar stays full and green before the next lap starts
  function lapBar(el, total, goal, o = {}) {
    if (!el || !goal) return;
    const done = Math.floor(total / goal), rem = total - done * goal;
    let golds, pct, green, mult;
    if (done === 0) { golds = 0; pct = (rem / goal) * 100; green = false; mult = 0; }
    else if (rem < LAP_GRACE) { golds = done - 1; pct = 100; green = true; mult = done > 1 ? done : 0; }
    else { golds = done; pct = (rem / goal) * 100; green = true; mult = done + 1; }
    const prev = el.dataset.golds === undefined ? null : Number(el.dataset.golds);
    if (prev !== golds || !el.firstChild) {
      el.innerHTML = '<div class="trk"><span class="f"></span><span class="c"></span><i class="notch"></i></div>'
        + '<div class="golds">' + '<i class="gold"></i>'.repeat(golds) + '</div><span class="x mono"></span>';
      if (prev !== null && golds > prev) { el.classList.remove('lapped'); void el.offsetWidth; el.classList.add('lapped'); }
      el.dataset.golds = String(golds);
    }
    const trk = el.querySelector('.trk'), f = el.querySelector('.f'), c = el.querySelector('.c'), n = el.querySelector('.notch');
    trk.classList.toggle('lap', green);
    f.style.width = pct + '%';
    f.classList.toggle('ok', green);
    f.classList.toggle('glow', green && !!o.glow);
    const showCash = !green && o.cash !== undefined;
    c.style.width = showCash ? (Math.min(o.cash, total) / goal) * 100 + '%' : '0';
    n.hidden = !(showCash && o.cashGoal);
    if (o.cashGoal) { n.style.left = `calc(${(o.cashGoal / goal) * 100}% - 2px)`; n.classList.toggle('hit', o.cash >= o.cashGoal); }
    el.querySelector('.x').textContent = mult ? '×' + mult : '';
    el.classList.toggle('full', green); el.classList.toggle('neon', green && !!o.glow);
    el.setAttribute('aria-valuenow', String(total)); el.setAttribute('aria-valuemax', String(goal));
    el.title = `${WT.hoursText(total)} of ${WT.hoursText(goal)}` + (o.cash !== undefined ? ` · cash ${WT.hoursText(o.cash)} of ${WT.hoursText(o.cashGoal)}` : '');
  }

  async function renderSummary() {
    renderHeaderTotal();
    renderDay();

    // Today: logged against 3:00, cash against 1:00. Floors, not ceilings.
    const t = todayMinutes();
    const cash = todayByCat().CASH || 0;
    const bothToday = t >= dailyGoal && cash >= cashGoal;
    $('todayBig').textContent = WT.hoursText(t);
    $('loggedLeft').textContent = t >= dailyGoal ? (t > dailyGoal ? '+' + WT.hoursText(t - dailyGoal) : '') : `${WT.hoursText(dailyGoal - t)} to go`;
    $('cashVal').innerHTML = `${WT.hoursText(cash)} <em>/ ${WT.hoursText(cashGoal)}</em>`;
    lapBar($('loggedMeter'), t, dailyGoal, { glow: bothToday });
    lapBar($('cashMeter'), cash, cashGoal, { glow: bothToday });
    lapBar($('dayBar'), t, dailyGoal, { cash, cashGoal, glow: bothToday });
    $('dayDone').hidden = !bothToday;
    renderPie($('todayPie'), $('todayLegend'), todayByCat());
    renderSessions();

    // Week: rolling 7 days (the 6 before today from the sheet, plus today live). Average over a 6 day week.
    const prev = summary && summary.week ? summary.week.days.slice(-6) : [];
    const days = prev.concat([{ key: 'today', label: new Date().toLocaleDateString('en-AU', { weekday: 'short' }), minutes: t, today: true }]);
    const byCat = { ...(summary && summary.week ? summary.week.byCategory : {}) };
    const tb = todayByCat(); for (const k in tb) byCat[k] = (byCat[k] || 0) + tb[k];
    const total = days.reduce((a, d) => a + d.minutes, 0);
    const wGoal = dailyGoal * WT.TARGETS.days, wCashGoal = cashGoal * WT.TARGETS.days;
    const wCash = byCat.CASH || 0;
    const bothWeek = total >= wGoal && wCash >= wCashGoal;
    $('weekBig').textContent = WT.hoursText(Math.round(total / WT.TARGETS.days));
    $('weekVal').innerHTML = `${WT.hoursText(total)} <em>/ ${WT.hoursText(wGoal)}</em>`;
    $('weekCashVal').innerHTML = `${WT.hoursText(wCash)} <em>/ ${WT.hoursText(wCashGoal)}</em>`;
    setMeter($('weekMeter'), total, wGoal, bothWeek);
    setMeter($('weekCashMeter'), wCash, wCashGoal, bothWeek);

    const bars = $('weekBars'); bars.innerHTML = '';
    const max = Math.max(1, dailyGoal, ...days.map(d => d.minutes));
    const H = 40, BASE = 18; // BASE = day-letter row + gap under the bars
    const line = document.createElement('span'); line.className = 'goal-line';
    line.style.bottom = (BASE + Math.round((dailyGoal / max) * H)) + 'px';
    line.title = `target ${WT.hoursText(dailyGoal)}`;
    bars.appendChild(line);
    days.forEach(d => {
      const el = document.createElement('div'); el.className = 'wb' + (d.today ? ' today' : '');
      el.tabIndex = 0;
      el.setAttribute('aria-label', `${d.label} ${WT.hoursText(d.minutes)}`);
      const barH = Math.max(2, Math.round((d.minutes / max) * H));
      const v = document.createElement('b'); v.className = 'wb-val mono'; v.textContent = WT.hoursText(d.minutes);
      v.style.bottom = (BASE + barH + 3) + 'px';
      const i = document.createElement('i'); i.style.height = barH + 'px';
      if (!d.minutes) i.className = 'zero'; else if (d.minutes >= dailyGoal) i.className = 'hit';
      const l = document.createElement('span'); l.textContent = d.label[0];
      el.appendChild(v); el.appendChild(i); el.appendChild(l); bars.appendChild(el);
    });
    renderPie($('weekPie'), $('weekLegend'), byCat);
  }

  // Pie of time by category. Colours are fixed per category (WT.catColor), never by rank.
  function renderPie(svg, legend, byCat) {
    const rows = Object.entries(byCat).filter(([, m]) => m > 0).sort((a, b) => b[1] - a[1]);
    const R = Number(svg.getAttribute('width')) / 2, NS = 'http://www.w3.org/2000/svg';
    svg.innerHTML = ''; legend.innerHTML = '';
    if (!rows.length) {
      svg.innerHTML = `<circle cx="${R}" cy="${R}" r="${R - 1}" fill="none" stroke="var(--rule)" stroke-width="1"/>`;
      legend.innerHTML = '<span class="empty">Fills in as you log.</span>';
      return;
    }
    const total = rows.reduce((s, [, m]) => s + m, 0);
    let a = -Math.PI / 2;
    rows.forEach(([k, m]) => {
      const col = WT.catColor(k);
      const frac = m / total;
      let el;
      if (frac >= 0.9999) {
        el = document.createElementNS(NS, 'circle'); el.setAttribute('cx', R); el.setAttribute('cy', R); el.setAttribute('r', R);
      } else {
        const b = a + 2 * Math.PI * frac;
        const x1 = R + R * Math.cos(a), y1 = R + R * Math.sin(a), x2 = R + R * Math.cos(b), y2 = R + R * Math.sin(b);
        el = document.createElementNS(NS, 'path');
        el.setAttribute('d', `M${R},${R} L${x1.toFixed(2)},${y1.toFixed(2)} A${R},${R} 0 ${b - a > Math.PI ? 1 : 0} 1 ${x2.toFixed(2)},${y2.toFixed(2)} Z`);
        a = b;
      }
      el.setAttribute('fill', col); el.setAttribute('class', 'slice'); el.dataset.cat = k;
      const tt = document.createElementNS(NS, 'title'); tt.textContent = `${k} ${WT.hoursText(m)}`; el.appendChild(tt);
      svg.appendChild(el);
      const row = document.createElement('div'); row.className = 'legend-row'; row.dataset.cat = k;
      row.innerHTML = `<b><i style="background:${col}"></i>${esc(k)}</b><span class="mono">${WT.hoursText(m)}</span>`;
      row.addEventListener('mouseenter', () => svg.classList.add('focus') || svg.querySelector(`[data-cat="${CSS.escape(k)}"]`)?.classList.add('on'));
      row.addEventListener('mouseleave', () => { svg.classList.remove('focus'); svg.querySelectorAll('.on').forEach(x => x.classList.remove('on')); });
      legend.appendChild(row);
    });
  }


  // ---------- pages ----------
  function setPage(n, save = true) {
    page = Math.max(0, Math.min(3, n));
    app.dataset.page = String(page);
    if (page === 0 && (stateOf() === 'idle' || stateOf() === 'typing')) taskInput.focus({ preventScroll: true });
    else taskInput.blur();
    if (save) WT.storage.set({ page });
  }
  document.querySelectorAll('.dot-btn').forEach(b => b.addEventListener('click', () => setPage(Number(b.dataset.page))));

  let wheelLock = 0;
  document.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaX) < 30 || Math.abs(e.deltaX) < Math.abs(e.deltaY)) return;
    const now = Date.now(); if (now - wheelLock < 500) return; wheelLock = now;
    setPage(page + (e.deltaX > 0 ? 1 : -1));
  }, { passive: true });

  // touch: swipe sideways between pages (phone app)
  let touch0 = null;
  document.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1 || (e.target.closest && e.target.closest('.overlay'))) { touch0 = null; return; }
    touch0 = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() };
  }, { passive: true });
  document.addEventListener('touchend', (e) => {
    if (!touch0) return;
    const dx = e.changedTouches[0].clientX - touch0.x, dy = e.changedTouches[0].clientY - touch0.y;
    const quick = Date.now() - touch0.t < 700;
    touch0 = null;
    if (quick && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) setPage(page + (dx < 0 ? 1 : -1));
  }, { passive: true });

  // ---------- keyboard ----------
  taskInput.addEventListener('input', () => {
    if (!session) { startSession(taskInput.value); return; }
    session.task = taskInput.value; saveSession();
  });
  taskInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && stateOf() === 'typing') { e.preventDefault(); e.stopPropagation(); lockTask(); }
  });
  document.querySelector('.start-arrow').addEventListener('click', () => { if (!session) startSession(''); });

  document.addEventListener('keydown', (e) => {
    if (!$('manualOverlay').hidden || !$('setupOverlay').hidden || !$('noteOverlay').hidden || !$('syncOverlay').hidden) return;
    const tag = document.activeElement && document.activeElement.tagName;
    const inField = (tag === 'INPUT' || tag === 'TEXTAREA') && document.activeElement !== taskInput;
    if (inField) return;
    const s = stateOf();

    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      if (s === 'typing' && taskInput.value) return; // let the caret move
      e.preventDefault(); setPage(page + (e.key === 'ArrowRight' ? 1 : -1)); return;
    }
    if (page !== 0) return;

    if (s === 'bubbles') {
      if (e.key === 'Enter') { e.preventDefault(); enterFocus(); return; }
      if (e.key === 'Backspace' || e.key === 'Escape') { e.preventDefault(); unlockTask(); return; }
      if (e.key === '+' || e.key === '=') { e.preventDefault(); customBubble(bubblesEl); return; }
      if (e.key.length === 1) {
        const hit = allCategories().find(c => c.letter && c.letter === e.key.toLowerCase());
        if (hit) {
          e.preventDefault();
          const cur = WT.splitCats(session.category);
          if (e.shiftKey) session.category = WT.joinCats(cur.includes(hit.key) ? cur.filter(k => k !== hit.key) : cur.concat([hit.key])); // Shift+letter adds a second
          else session.category = cur.length === 1 && cur[0] === hit.key ? '' : hit.key;
          saveSession(); renderBubbles(bubblesEl, session.category, bubblesEl._onPick);
        }
      }
      return;
    }
    if (s === 'focus') {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); stopSession(); }
      return;
    }
    if (s === 'idle' && e.key.length === 1 && document.activeElement !== taskInput) {
      taskInput.focus();
    }
  });

  bubblesEl._onPick = (cat) => { if (session) { session.category = cat; saveSession(); enterFocus(); } };
  bubblesEl._onDeselect = () => { if (session) { session.category = ''; saveSession(); renderBubbles(bubblesEl, '', bubblesEl._onPick); } };
  bubblesEl._onMulti = (cats) => { if (session) { session.category = cats; saveSession(); renderBubbles(bubblesEl, cats, bubblesEl._onPick); } };

  timerBtn.addEventListener('click', stopSession);
  $('discardBtn').addEventListener('click', discardSession);

  // ---------- manual entry / edit ----------
  const mOverlay = $('manualOverlay');
  let mCat = 'CASH';
  let mEditTarget = null; // { entryId } or { tempId } of the entry being edited, null for a new one

  function openSheet(edit) {
    mEditTarget = edit ? (edit.id ? { entryId: edit.id } : { tempId: edit.tempId }) : null;
    delete $('mDelete').dataset.armed; $('mDelete').textContent = 'Delete';
    mCat = edit ? (edit.category && edit.category !== 'OTHER' ? edit.category : '') : 'CASH';
    $('mTitle').textContent = edit ? 'Edit session' : 'Input your own';
    $('mAdd').textContent = edit ? 'Save' : 'Add to sheet';
    $('mAdd').disabled = false;
    $('mDelete').hidden = !edit;
    $('mStartFrom').hidden = !!edit;
    $('mTask').value = edit ? edit.task : '';
    $('mStart').value = edit && edit.start ? edit.start : '';
    $('mStop').value = edit && edit.end ? edit.end : '';
    $('mDur').value = edit && edit.minutes ? WT.hoursText(edit.minutes) : '';
    delete $('mDur').dataset.touched;
    renderBubbles($('mBubbles'), mCat, (c) => { mCat = c; renderBubbles($('mBubbles'), c, $('mBubbles')._onPick); });
    $('mBubbles')._onDeselect = () => { mCat = ''; renderBubbles($('mBubbles'), '', $('mBubbles')._onPick); };
    $('mBubbles')._onMulti = (cats) => { mCat = cats; renderBubbles($('mBubbles'), cats, $('mBubbles')._onPick); };
    mOverlay.hidden = false;
    setTimeout(() => $('mTask').focus(), 50);
  }
  $('manualBtn').addEventListener('click', () => openSheet(null));
  $('manualClose').addEventListener('click', () => { mOverlay.hidden = true; });
  mOverlay.addEventListener('click', (e) => { if (e.target === mOverlay) mOverlay.hidden = true; });
  mOverlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') mOverlay.hidden = true; });

  const recomputeDur = () => {
    const a = WT.parseClock($('mStart').value), b = WT.parseClock($('mStop').value);
    if (a && b) $('mDur').value = WT.hoursText(WT.minutesBetween(a, b));
  };
  $('mStart').addEventListener('change', () => { delete $('mDur').dataset.touched; recomputeDur(); });
  $('mStop').addEventListener('change', () => { delete $('mDur').dataset.touched; recomputeDur(); });
  $('mDur').addEventListener('input', () => { $('mDur').dataset.touched = '1'; });

  function readSheetForm() {
    const task = $('mTask').value.trim();
    const a = WT.parseClock($('mStart').value), b = WT.parseClock($('mStop').value);
    let mins = null, startText = '', endText = '';
    if (a) startText = `${WT.pad(a.h)}:${WT.pad(a.min)}`;
    if (b) endText = `${WT.pad(b.h)}:${WT.pad(b.min)}`;
    const dv = $('mDur').value; const dc = WT.parseClock(dv);
    const typed = WT.parseDuration(dv) || (dc && dc.h * 60 + dc.min) || null;
    // a duration you typed wins; otherwise it comes from start and stop
    if ($('mDur').dataset.touched && typed) mins = typed;
    else if (a && b) mins = WT.minutesBetween(a, b) || typed;
    else mins = typed;
    return { task, a, b, mins, startText, endText };
  }

  $('mAdd').addEventListener('click', async () => {
    const f = readSheetForm();
    if (!f.mins) { showToast('Need start and stop, or a duration'); return; }
    const payload = { task: f.task, category: mCat, start: f.startText, end: f.endText, hours: WT.hoursText(f.mins) };
    mOverlay.hidden = true;
    showToast(`${mEditTarget ? 'Saved' : 'Added'} ${WT.hoursText(f.mins)}${f.task ? ' · ' + f.task : ''}`);
    if (mEditTarget) await localOp({ action: 'update', ...mEditTarget, payload });
    else await localOp({ action: 'append', tempId: WT.newId(), payload: { date: WT.dateLabel(new Date()), ...payload } });
  });

  $('mDelete').addEventListener('click', async () => {
    if (!mEditTarget) return;
    if (!$('mDelete').dataset.armed) { $('mDelete').dataset.armed = '1'; $('mDelete').textContent = 'Delete, really?'; return; }
    delete $('mDelete').dataset.armed; $('mDelete').textContent = 'Delete';
    mOverlay.hidden = true;
    showToast('Deleted');
    await localOp({ action: 'delete', ...mEditTarget });
  });

  // Make the typed start time the running session
  $('mStartFrom').addEventListener('click', async () => {
    const f = readSheetForm();
    if (!f.a) { showToast('Type a start time first'); $('mStart').focus(); return; }
    if (session && session.state === 'focus') { showToast('Stop the current session first'); return; }
    const d = new Date(); d.setHours(f.a.h, f.a.min, 0, 0);
    if (d > new Date()) d.setDate(d.getDate() - 1);
    session = { startedAt: d.getTime(), task: f.task, category: mCat, state: f.task ? 'focus' : 'typing', pushedTempId: null };
    await saveSession();
    chrome.runtime.sendMessage({ type: 'session-started', startedAt: session.startedAt }).catch(() => {});
    mOverlay.hidden = true;
    setPage(0);
    renderState(true);
  });

  // today's sessions list
  function renderSessions() {
    const box = $('todaySessions');
    box.innerHTML = '';
    const list = summary && summary.today.list ? summary.today.list : [];
    const items = list.slice().reverse();
    if (session && session.state === 'focus') items.unshift({ live: true, task: session.task, category: session.category, start: WT.hhmm(new Date(session.startedAt)), end: null, minutes: elapsedMinutes() });
    if (!items.length) return;
    items.forEach(it => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'session' + (it.live || !it.minutes ? ' open' : '') + (it.pending ? ' pending' : '') + (it.failed ? ' failed' : '');
      const cs = WT.splitCats(it.category).filter(c => c !== 'OTHER');
      const dot = cs.length > 1 ? `<i class="s-dot" style="background:conic-gradient(${WT.catColor(cs[0])} 0 50%, ${WT.catColor(cs[1])} 0 100%)"></i>`
        : `<i class="s-dot" style="background:${cs.length ? WT.catColor(cs[0]) : 'var(--pill)'}"></i>`;
      b.title = cs.join(' + ');
      b.innerHTML = `${dot}<span class="s-task">${esc(it.task || '(untitled)')}</span><span class="s-hours mono">${WT.hoursText(it.minutes || 0)}</span>`;
      if (it.live) { b.title = 'Running now'; b.addEventListener('click', () => setPage(0)); }
      else if (it.tempId && String(it.tempId).startsWith('j')) { b.title = 'Not in the sheet yet. Tap to send.'; b.addEventListener('click', () => resendFromJournal(Number(String(it.tempId).slice(1)))); }
      else if (!it.id && !it.tempId) { b.title = 'Edit this one in the sheet'; b.addEventListener('click', () => showToast('Edit this one in the sheet')); }
      else b.addEventListener('click', () => openSheet(it));
      box.appendChild(b);
    });
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  // ---------- day plan ----------
  const hmMin = (x) => WT.parseDuration(String(x || '').trim()) || 0;
  function dayKeyLocal(d) { return `${d.getFullYear()}-${WT.pad(d.getMonth() + 1)}-${WT.pad(d.getDate())}`; }
  function planRows() {
    const pl = planView;
    return pl && pl.date === dayKeyLocal(new Date()) ? (pl.rows || []) : [];
  }
  const SVG12 = (path, sw, fill) => `<svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill="${fill || 'none'}" stroke="currentColor" stroke-width="${sw || 1.3}" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
  const P_CHECK = '<path d="M2.5 6.2 L5 8.6 L9.5 3.6"/>';
  const P_PLAY = '<path d="M3.5 2.2 L9.8 6 L3.5 9.8 Z"/>';
  const P_STOP = '<rect x="3" y="3" width="6" height="6" rx="1"/>';
  const P_LINK = '<path d="M5 7 L7 5 M4.2 5.6 L3.3 6.5 A1.8 1.8 0 0 0 5.5 8.7 L6.4 7.8 M7.8 6.4 L8.7 5.5 A1.8 1.8 0 0 0 6.5 3.3 L5.6 4.2"/>';

  // notes -> text with clickable links (http(s) urls, shown by host)
  function notesHtml(text) {
    const parts = String(text || '').split(/(https?:\/\/[^\s,]+)/g);
    return parts.map(part => {
      if (/^https?:\/\//.test(part)) {
        let label = part;
        try {
          const u = new URL(part); const host = u.hostname.replace(/^www\./, '');
          label = /docs\.google\.com$/.test(host) ? ({ document: 'Google Doc', spreadsheets: 'Google Sheet', presentation: 'Google Slides', forms: 'Google Form' }[u.pathname.split('/')[1]] || host) : host;
        } catch (e) { /* keep raw */ }
        return `<a href="${esc(part)}" target="_blank" rel="noopener">${SVG12(P_LINK)}<span>${esc(label)}</span></a>`;
      }
      return esc(part).replace(/\n/g, '<br>');
    }).join('');
  }

  function renderDay() {
    const list = $('rail');
    if (!list) return;
    const rows = planRows();
    $('dayEmpty').hidden = rows.length > 0;
    list.hidden = rows.length === 0;
    $('dayLogged').textContent = WT.hoursText(todayMinutes());
    const planned = rows.filter(r => !WT.isRitual(r)).reduce((s, r) => s + hmMin(r.estimate), 0);
    $('dayPlanned').textContent = ` / ${WT.hoursText(dailyGoal)} goal`;
    const planFailed = outbox.some(o => o.action === 'planUpdate' && o.status === 'failed');
    const lab = $('dayFootLabel');
    if (planFailed) {
      lab.innerHTML = '<button class="link danger" id="syncHandBtn">Sync by hand</button>';
      $('syncHandBtn').onclick = openSyncByHand;
    } else lab.textContent = planned ? `${WT.hoursText(planned)} planned` : 'Logged today';

    const runningRow = session && session.state === 'focus' && session.planRow ? session.planRow : null;
    const nextRow = (rows.find(r => r.row !== runningRow && r.status !== 'done') || {}).row;
    list.innerHTML = '';
    rows.forEach(r => {
      const ritual = WT.isRitual(r);
      const running = r.row === runningRow;
      const st = running ? 'running' : r.status === 'done' ? 'done' : r.status === 'in progress' ? 'partial' : 'todo';
      const open = expanded.has(r.row);
      const items = ritual ? WT.parseItems(r.items) : [];

      const wrap = document.createElement('div');
      wrap.className = `pitem ${st}` + (ritual ? ' ritual' : ' work') + (open ? ' open' : '') + (r.pending ? ' pending' : '') + (r.row === nextRow && !runningRow ? ' next' : '');
      const act = running ? WT.hoursText((session.planPrevActualMin || 0) + elapsedMinutes()) : (r.actual || '');
      // rows stay number-free; only the running row shows its estimate and live actual
      const nums = running ? `<span class="est">${esc(r.estimate || '')}</span><span class="act">${esc(act)}</span>` : '';
      const play = ritual ? '<span class="play-slot"></span>'
        : `<button type="button" class="play" aria-label="${running ? 'Stop' : 'Start'} ${esc(r.task)}" title="${running ? 'Stop and log' : st === 'done' ? 'Resume' : 'Start'}">${SVG12(running ? P_STOP : P_PLAY, 1.2, 'currentColor')}</button>`;
      wrap.innerHTML = `<div class="prow"><button type="button" class="node" aria-label="${st === 'done' ? 'Untick' : 'Tick off'} ${esc(r.task)}" title="${st === 'done' ? 'Untick' : 'Tick off'}"><i>${st === 'done' ? SVG12(P_CHECK, 1.8) : ''}</i></button><button type="button" class="main" aria-expanded="${open}"><span class="name"></span><span class="nums">${nums}</span></button>${play}</div>`;
      wrap.querySelector('.name').textContent = r.task;

      wrap.querySelector('.node').addEventListener('click', (e) => { e.stopPropagation(); ritual ? toggleRitual(r, items) : tickWork(r, st); });
      wrap.querySelector('.main').addEventListener('click', () => { const was = open; expanded.clear(); if (!was) expanded.add(r.row); renderDay(); }); // one open at a time
      const pb = wrap.querySelector('.play');
      if (pb) pb.addEventListener('click', (e) => { e.stopPropagation(); running ? stopSession() : startFromPlan(r); });

      if (open) wrap.appendChild(detailPanel(r, ritual, items, running, act));
      list.appendChild(wrap);
    });
    markTrail(list);
  }

  // Map-style trail: red dashes join every ticked item from the first to the last,
  // faint dots carry on from the last one to the end of the day.
  function markTrail(list) {
    const items = [...list.querySelectorAll('.pitem')];
    const done = items.map(el => el.classList.contains('done'));
    const F = done.indexOf(true), L = done.lastIndexOf(true);
    items.forEach((el, i) => {
      el.classList.remove('tr-up', 'tr-down', 'ah-up', 'ah-down');
      if (F < 0) return;
      if (i > F && i <= L) el.classList.add('tr-up');
      if (i >= F && i < L) el.classList.add('tr-down');
      if (i > L) el.classList.add('ah-up');
      if (i >= L && i < items.length - 1) el.classList.add('ah-down');
    });
  }

  function detailPanel(r, ritual, items, running, act) {
    const d = document.createElement('div');
    d.className = 'pdetail';
    const facts = [];
    if (!ritual && r.category) facts.push(`<span class="chip">${esc(r.category)}</span>`);
    let html = facts.length ? `<div class="facts">${facts.join('')}</div>` : '';
    if (items.length) html += `<div class="subs"></div>`;
    if (r.notes) html += `<div class="notes">${notesHtml(r.notes)}</div>`;
    if (r.note) html += `<div class="notes pnote"><span class="faint">Progress</span> ${esc(r.note)}</div>`;
    const sheet = planView && planView.sheetUrl ? `${planView.sheetUrl}&range=C${r.row}` : '';
    if (sheet) html += `<a class="in-sheet" href="${esc(sheet)}" target="_blank" rel="noopener">Open in Second Brain ↗</a>`;
    if (!html) html = '<span class="hint">No notes. Navi can add links or detail in the Notes column.</span>';
    d.innerHTML = html;
    if (items.length) {
      const subs = d.querySelector('.subs');
      items.forEach((it, i) => {
        const c = document.createElement('button');
        c.type = 'button';
        c.className = 'sub' + (it.done ? ' done' : '');
        c.innerHTML = (it.done ? SVG12(P_CHECK, 1.6) : '') + '<span></span>';
        c.querySelector('span').textContent = it.name;
        c.addEventListener('click', () => { items[i].done = !items[i].done; writeRitual(r, items); });
        subs.appendChild(c);
      });
    }
    return d;
  }

  function toggleRitual(r, items) {
    const toDone = r.status !== 'done';
    items.forEach(i => { i.done = toDone; });
    writeRitual(r, items, toDone ? 'done' : 'todo');
  }
  function writeRitual(r, items, force) {
    const n = items.filter(i => i.done).length;
    const status = force || (items.length && n === items.length ? 'done' : n ? 'in progress' : 'todo');
    const payload = { row: r.row, task: r.task, status };
    if (items.length) payload.items = WT.formatItems(items);
    planOp(payload);
  }

  // Bullet: tick off (or untick) without the timer. On the running row it finishes and logs.
  async function tickWork(r, st) {
    if (st === 'running') { await stopSession(); return; }
    if (st === 'done') { await planOp({ row: r.row, task: r.task, status: 'todo' }); return; }
    await planOp({ row: r.row, task: r.task, status: 'done' });
  }

  async function startFromPlan(r) {
    let startedAt = Date.now();
    if (session && session.state === 'focus') await stopSession();          // log what was running, then switch
    else if (session) startedAt = session.startedAt;                         // clock already going from typing: give it to this item
    session = {
      startedAt, task: r.task, category: r.category || '', state: 'focus', pushedTempId: null,
      planRow: r.row, planTask: r.task, planEstMin: hmMin(r.estimate), planPrevActualMin: hmMin(r.actual) < 16 * 60 ? hmMin(r.actual) : 0,
      planPrevStatus: r.status, planPrevStart: r.start || ''
    };
    await saveSession();
    chrome.runtime.sendMessage({ type: 'session-started', startedAt }).catch(() => {});
    renderState(true);
    showToast(`Started ${r.task}`);
    await planOp({ row: r.row, task: r.task, status: 'in progress' });
  }

  // ---------- setup ----------
  function showSetup() { $('setupOverlay').hidden = false; setTimeout(() => $('setupUrl').focus(), 50); }
  $('setupSave').addEventListener('click', async () => {
    const url = $('setupUrl').value.trim();
    if (!/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec/.test(url)) { $('setupStatus').textContent = 'That does not look like an Apps Script /exec link.'; return; }
    $('setupStatus').textContent = 'Checking…';
    await WT.storage.set({ webAppUrl: url });
    try {
      await refreshSummary();
      if (!summary) throw new Error('no summary');
      $('setupOverlay').hidden = true;
      showToast('Connected to your sheet');
      taskInput.focus();
    } catch (e) {
      $('setupStatus').textContent = 'Could not read the sheet. Check the deployment is set to Anyone.';
    }
  });
  $('setupUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('setupSave').click(); });
})();
