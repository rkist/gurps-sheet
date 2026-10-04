/*
 * Stand-in for Roll20's sheet-worker runtime.
 *
 * The GURPS sheet ships ~29k lines of "sheet worker" JavaScript written against
 * Roll20's globals (on, getAttrs, setAttrs, getSectionIDs, ...). This file
 * provides those globals inside a real Web Worker, then loads the sheet's own
 * code unmodified with importScripts().
 *
 * The worker owns the authoritative attribute store for the open character.
 * The page sends player edits/clicks in and receives batched updates back.
 *
 * Page -> worker: init, change, click, addRow, removeRow, reorder
 * Worker -> page: ready, update, roll, fatal
 */
'use strict';

(function () {
  const nativeSetTimeout = self.setTimeout.bind(self);
  const post = self.postMessage.bind(self);
  const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
  const dict = (src) => Object.assign(Object.create(null), src || {});

  let activeCharacterId = '';
  let attrs = dict();           // lowercase attribute name -> stored value
  let sectionRows = dict();     // 'repeating_x' -> [rowId, ...] in display order
  let defaults = dict();        // lowercase attribute name -> default from the sheet HTML
  let sectionDefaults = dict(); // 'repeating_x' -> { field: default }
  let translations = dict();
  let language = 'en';

  const handlers = dict();      // 'change:foo' -> [callback, ...]
  let context = null;           // { section, rowId } while handling a repeating-row event
  let clickContext = null;      // the row of the last clicked button, for startRoll

  function report(err) {
    console.error('[sheet worker]', err);
  }

  function later(fn) {
    queueMicrotask(() => {
      try {
        fn();
      } catch (err) {
        report(err);
      }
    });
  }

  function withContext(ctx, fn, arg) {
    const previous = context;
    context = ctx;
    try {
      const result = fn(arg);
      if (result && typeof result.then === 'function') result.then(null, report);
    } catch (err) {
      report(err);
    } finally {
      context = previous;
    }
  }

  // ---- attribute names --------------------------------------------------

  // repeating_<section>_<rowId>_<field>. Section names never contain "_" and
  // row ids always start with "-", so "repeating_skills_name" (no id) is the
  // implicit current-row form Roll20 allows inside repeating events.
  function parseRepeating(name) {
    const m = /^(repeating_[^_]+)_(.*)$/.exec(name);
    if (!m) return null;
    const rest = m[2];
    if (rest.charAt(0) === '-') {
      const i = rest.indexOf('_');
      return i < 0
        ? { section: m[1], rowId: rest, field: '' }
        : { section: m[1], rowId: rest.slice(0, i), field: rest.slice(i + 1) };
    }
    return { section: m[1], rowId: null, field: rest };
  }

  function resolveName(name, ctx) {
    const n = String(name).toLowerCase();
    if (ctx) {
      const p = parseRepeating(n);
      if (p && p.rowId === null && p.section === ctx.section) {
        return ctx.section + '_' + ctx.rowId + '_' + p.field;
      }
    }
    return n;
  }

  function sectionKey(section) {
    const s = String(section).toLowerCase();
    return s.indexOf('repeating_') === 0 ? s : 'repeating_' + s;
  }

  function defaultOf(name) {
    const p = parseRepeating(name);
    if (p && p.rowId !== null) {
      const d = sectionDefaults[p.section];
      return d && hasOwn(d, p.field) ? d[p.field] : undefined;
    }
    return defaults[name];
  }

  function valueOf(name) {
    return name in attrs ? attrs[name] : defaultOf(name);
  }

  function ensureRow(name) {
    const p = parseRepeating(name);
    if (!p || !p.rowId) return;
    const rows = sectionRows[p.section] || (sectionRows[p.section] = []);
    if (rows.indexOf(p.rowId) < 0) {
      rows.push(p.rowId);
      markSection(p.section);
    }
  }

  // ---- batching updates to the page -------------------------------------

  const pendingValues = new Map();
  const pendingSections = new Set();
  let flushScheduled = false;

  function scheduleFlush() {
    if (flushScheduled) return;
    flushScheduled = true;
    // A macrotask, so a whole cascade of microtask callbacks lands in one message.
    nativeSetTimeout(flush, 0);
  }

  function markValue(name, value) {
    pendingValues.set(name, value);
    scheduleFlush();
  }

  function markSection(section) {
    pendingSections.add(section);
    scheduleFlush();
  }

  function flush() {
    flushScheduled = false;
    const values = {};
    pendingValues.forEach((v, k) => {
      values[k] = v;
    });
    pendingValues.clear();
    const sections = {};
    pendingSections.forEach((s) => {
      sections[s] = (sectionRows[s] || []).slice();
    });
    pendingSections.clear();
    post({ type: 'update', values, sections });
  }

  // ---- events -------------------------------------------------------------

  function on(events, callback) {
    if (typeof callback !== 'function') return;
    String(events)
      .toLowerCase()
      .split(/\s+/)
      .forEach((ev) => {
        if (ev) (handlers[ev] || (handlers[ev] = [])).push(callback);
      });
  }

  function trigger(key, info, ctx) {
    const list = handlers[key];
    if (!list) return;
    list.slice().forEach((cb) => withContext(ctx, cb, Object.assign({}, info)));
  }

  // Roll20 reports the full attribute name as both sourceAttribute and
  // triggerName for change events; the GURPS code parses row ids out of them.
  function fireChange(name, previousValue, newValue, sourceType) {
    const info = { sourceAttribute: name, sourceType, previousValue, newValue, triggerName: name };
    const p = parseRepeating(name);
    if (p && p.rowId) {
      const ctx = { section: p.section, rowId: p.rowId };
      trigger('change:' + p.section + ':' + p.field, info, ctx);
      trigger('change:' + p.section, info, ctx);
    } else {
      trigger('change:' + name, info, null);
    }
  }

  // ---- Roll20 API ---------------------------------------------------------

  function getAttrs(names, callback) {
    const ctx = context;
    const out = {};
    (Array.isArray(names) ? names : [names]).forEach((name) => {
      const v = valueOf(resolveName(name, ctx));
      if (v !== undefined) out[name] = v;
    });
    if (typeof callback === 'function') later(() => withContext(ctx, callback, out));
  }

  function setAttrs(values, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = null;
    }
    const silent = !!(options && options.silent);
    const ctx = context;
    const changes = [];

    Object.keys(values || {}).forEach((key) => {
      let v = values[key];
      // The GURPS sheet does both of these in normal use (e.g. max_skill_nine,
      // repeating_hitlocation_crippled on a hit_points_max change). Roll20
      // drops them too, so they are only debug output.
      if (v === undefined) {
        console.debug('[sheet worker] setAttrs ignored undefined value for', key);
        return;
      }
      if (v === null) v = '';
      if (typeof v === 'object') v = String(v);

      const name = resolveName(key, ctx);
      const p = parseRepeating(name);
      if (p && p.rowId === null) {
        console.debug('[sheet worker] setAttrs ignored row-relative name outside a row event:', key);
        return;
      }
      ensureRow(name);

      const had = name in attrs;
      const previous = had ? attrs[name] : defaultOf(name);
      // Like Roll20, re-setting an identical value is not a change.
      if (had && String(previous) === String(v)) return;

      attrs[name] = v;
      markValue(name, v);
      changes.push([name, previous, v]);
    });

    later(() => {
      if (!silent) changes.forEach((c) => fireChange(c[0], c[1], c[2], 'sheetworker'));
      if (typeof callback === 'function') withContext(ctx, callback, values);
    });
  }

  function getSectionIDs(section, callback) {
    const ctx = context;
    const ids = (sectionRows[sectionKey(section)] || []).slice();
    if (typeof callback === 'function') later(() => withContext(ctx, callback, ids));
  }

  const ID_CHARS = '0123456789abcdefghijklmnopqrstuvwxyz';
  function generateRowID() {
    let t = Date.now();
    let id = '';
    for (let i = 0; i < 8; i++) {
      id = ID_CHARS[t % 36] + id;
      t = Math.floor(t / 36);
    }
    for (let i = 0; i < 11; i++) id += ID_CHARS[(Math.random() * 36) | 0];
    return '-' + id;
  }

  function removeRow(rowName, sourceType) {
    const p = parseRepeating(String(rowName).toLowerCase());
    if (!p || !p.rowId) return;
    const prefix = p.section + '_' + p.rowId + '_';
    const removedInfo = {};
    Object.keys(attrs).forEach((k) => {
      if (k.indexOf(prefix) === 0) {
        removedInfo[k] = attrs[k];
        delete attrs[k];
        pendingValues.delete(k);
      }
    });
    const rows = sectionRows[p.section];
    const i = rows ? rows.indexOf(p.rowId) : -1;
    if (i >= 0) rows.splice(i, 1);
    if (sourceType === 'sheetworker') markSection(p.section);

    later(() =>
      trigger(
        'remove:' + p.section,
        {
          sourceAttribute: p.section + '_' + p.rowId,
          sourceType,
          removedInfo,
          triggerName: 'remove:' + p.section,
        },
        null,
      ),
    );
  }

  function removeRepeatingRow(rowName) {
    removeRow(rowName, 'sheetworker');
  }

  function setSectionOrder(section, order, callback) {
    const key = sectionKey(section);
    const current = sectionRows[key] || [];
    const wanted = [];
    (Array.isArray(order) ? order : String(order).split(',')).forEach((id) => {
      const lower = String(id).toLowerCase();
      if (current.indexOf(lower) >= 0 && wanted.indexOf(lower) < 0) wanted.push(lower);
    });
    sectionRows[key] = wanted.concat(current.filter((id) => wanted.indexOf(id) < 0));
    markSection(key);
    if (typeof callback === 'function') later(callback);
  }

  function getTranslationByKey(key) {
    return hasOwn(translations, key) ? translations[key] : false;
  }

  function getTranslationLanguage() {
    return language;
  }

  // The page turns the roll text into a Roll20 chat command; nothing is rolled
  // here. The promise never resolves, so the sheet's handlers stop before
  // finishRoll(), which only fills in Roll20's chat card. The sheet often calls
  // this after an await, when the row context is gone, so the clicked row is
  // remembered too.
  function startRoll(text) {
    const ctx = context || clickContext;
    post({ type: 'roll', text: String(text), section: ctx ? ctx.section : null, rowId: ctx ? ctx.rowId : null });
    return new Promise(() => {});
  }

  function finishRoll() {}

  function getActiveCharacterId() {
    return activeCharacterId;
  }

  function setDefaultToken() {}

  // Roll20 exposes underscore.js to sheet workers; the GURPS sheet only uses
  // _.each and _.after, plus a few common helpers for safety.
  const _ = {
    each(obj, fn, thisArg) {
      if (Array.isArray(obj)) obj.forEach((v, i) => fn.call(thisArg, v, i, obj));
      else if (obj) Object.keys(obj).forEach((k) => fn.call(thisArg, obj[k], k, obj));
      return obj;
    },
    after(times, fn) {
      return function () {
        if (--times < 1) return fn.apply(this, arguments);
      };
    },
    map(obj, fn, thisArg) {
      if (Array.isArray(obj)) return obj.map((v, i) => fn.call(thisArg, v, i, obj));
      return Object.keys(obj || {}).map((k) => fn.call(thisArg, obj[k], k, obj));
    },
    filter(obj, fn, thisArg) {
      return (Array.isArray(obj) ? obj : Object.values(obj || {})).filter((v, i) => fn.call(thisArg, v, i, obj));
    },
    keys: (obj) => Object.keys(obj || {}),
    values: (obj) => Object.values(obj || {}),
    extend: Object.assign,
    isEmpty(obj) {
      if (obj == null) return true;
      if (Array.isArray(obj) || typeof obj === 'string') return obj.length === 0;
      return Object.keys(obj).length === 0;
    },
    isUndefined: (v) => v === undefined,
    contains: (list, v) => (Array.isArray(list) ? list : Object.values(list || {})).indexOf(v) >= 0,
  };

  Object.assign(self, {
    on,
    getAttrs,
    setAttrs,
    getSectionIDs,
    generateRowID,
    removeRepeatingRow,
    setSectionOrder,
    getTranslationByKey,
    getTranslationLanguage,
    startRoll,
    finishRoll,
    getActiveCharacterId,
    setDefaultToken,
    _,
  });

  // ---- messages from the page ---------------------------------------------

  function init(msg) {
    activeCharacterId = msg.characterId;
    attrs = dict(msg.attrs);
    sectionRows = dict();
    Object.keys(msg.sections || {}).forEach((k) => {
      sectionRows[k] = msg.sections[k].slice();
    });
    defaults = dict(msg.defaults);
    sectionDefaults = dict(msg.sectionDefaults);
    translations = dict(msg.translations);
    language = msg.language || 'en';

    try {
      importScripts(msg.sheetUrl);
    } catch (err) {
      post({ type: 'fatal', message: String((err && err.message) || err) });
      return;
    }
    post({ type: 'ready' });
    later(() => trigger('sheet:opened', { sourceType: 'player', triggerName: 'sheet:opened' }, null));
  }

  function playerChange(name, value) {
    const n = String(name).toLowerCase();
    ensureRow(n);
    const previous = valueOf(n);
    attrs[n] = value;
    later(() => fireChange(n, previous, value, 'player'));
  }

  function click(msg) {
    const name = String(msg.name).toLowerCase();
    const info = { sourceType: 'player', htmlAttributes: msg.htmlAttributes || {} };
    clickContext = msg.section && msg.rowId ? { section: msg.section, rowId: msg.rowId } : null;
    if (msg.section && msg.rowId) {
      const full = msg.section + '_' + msg.rowId + '_' + name;
      info.sourceAttribute = full;
      info.triggerName = 'clicked:' + full;
      trigger('clicked:' + msg.section + ':' + name, info, { section: msg.section, rowId: msg.rowId });
    } else {
      info.sourceAttribute = name;
      info.triggerName = 'clicked:' + name;
      trigger('clicked:' + name, info, null);
    }
  }

  self.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      // Sent by the sheet's own Roll20Async helpers via self.dispatchEvent().
      case 'setActiveCharacter':
        if (msg.data) activeCharacterId = msg.data;
        return;
      case 'init':
        init(msg);
        return;
      case 'change':
        playerChange(msg.name, msg.value);
        return;
      case 'click':
        click(msg);
        return;
      case 'addRow': {
        const rows = sectionRows[msg.section] || (sectionRows[msg.section] = []);
        if (rows.indexOf(msg.rowId) < 0) rows.push(msg.rowId);
        return;
      }
      case 'removeRow':
        removeRow(msg.section + '_' + msg.rowId, 'player');
        return;
      case 'reorder':
        sectionRows[msg.section] = msg.ids.slice();
        return;
    }
  });
})();
