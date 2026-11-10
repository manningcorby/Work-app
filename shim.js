// Runs the Work popup as a phone/desktop web app: stands in for the chrome.* APIs
// the extension uses (storage, background messages) with localStorage and an in-page sync loop.
window.__WORK_APP__ = true;
(function () {
  const P = 'work:';
  const listeners = [];
  const read = (k) => { try { const v = localStorage.getItem(P + k); return v == null ? undefined : JSON.parse(v); } catch (e) { return undefined; } };
  const write = (k, v) => { try { localStorage.setItem(P + k, JSON.stringify(v)); } catch (e) { /* storage full or blocked */ } };
  const copy = (v) => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  const fire = (ch) => listeners.forEach(f => { try { f(ch, 'local'); } catch (e) { console.error(e); } });

  const local = {
    get(keys, cb) {
      const list = keys == null ? Object.keys(localStorage).filter(k => k.startsWith(P)).map(k => k.slice(P.length))
        : Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys);
      const out = {};
      list.forEach(k => { const v = read(k); if (v !== undefined) out[k] = v; else if (keys && typeof keys === 'object' && !Array.isArray(keys)) out[k] = keys[k]; });
      setTimeout(() => cb && cb(out), 0);
    },
    set(obj, cb) {
      const ch = {};
      for (const k in obj) { ch[k] = { oldValue: read(k), newValue: copy(obj[k]) }; write(k, obj[k]); }
      setTimeout(() => { fire(ch); cb && cb(); }, 0);
    },
    remove(keys, cb) {
      const ch = {};
      (Array.isArray(keys) ? keys : [keys]).forEach(k => { ch[k] = { oldValue: read(k), newValue: undefined }; try { localStorage.removeItem(P + k); } catch (e) {} });
      setTimeout(() => { fire(ch); cb && cb(); }, 0);
    }
  };

  // another tab or window of the app changed something
  window.addEventListener('storage', (e) => {
    if (!e.key || !e.key.startsWith(P)) return;
    const k = e.key.slice(P.length);
    let nv; try { nv = e.newValue == null ? undefined : JSON.parse(e.newValue); } catch (x) { nv = undefined; }
    fire({ [k]: { newValue: nv } });
  });

  let flushing = null, retry = null;
  async function flush() {
    if (flushing) return flushing;
    flushing = (async () => {
      try { return await window.WT.flushOutbox(); }
      catch (e) { return { sent: 0, failed: 0, error: String(e) }; }
      finally {
        flushing = null;
        const out = read('outbox') || [];
        clearTimeout(retry);
        if (out.some(o => o.status === 'pending')) retry = setTimeout(flush, 60000);
      }
    })();
    return flushing;
  }

  window.chrome = {
    storage: { local, onChanged: { addListener: (f) => listeners.push(f) } },
    runtime: {
      sendMessage: (msg) => {
        if (msg && msg.type === 'flush') return flush();
        return Promise.resolve({});
      }
    }
  };

  window.addEventListener('online', () => flush());

  // coming back to the app after a while: reload so the plan, totals and any
  // session started on another device are fresh
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    if (hiddenAt && Date.now() - hiddenAt > 30000) location.reload();
  });

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
      .then(reg => { reg.update().catch(() => {}); })
      .catch(() => {}));
    // a new version took over: reload once so the new code is what's running
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloaded) { reloaded = true; location.reload(); } });
  }
})();
