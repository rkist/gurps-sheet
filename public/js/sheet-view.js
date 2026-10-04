// Mounts the prepared sheet markup for one character, keeps the DOM and the
// attribute store in sync, and relays player actions to the sheet worker.
import { computeAutocalc } from './autocalc.js';
import { generateRowId, parseRepeating } from './names.js';

const WORKER_URL = new URL('./roll20-worker.js', import.meta.url);
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
// HTML "valid floating-point number", what <input type="number"> accepts.
const VALID_NUMBER = /^-?(\d+(\.\d+)?|\.\d+)(e[-+]?\d+)?$/i;

// Number inputs show non-numbers (the sheet sometimes stores "NaN") as empty;
// set that directly instead of letting Chrome warn about it. With `attribute`,
// also mirror it to the value attribute, which the sheet's CSS selects on.
function setInputValue(el, value, { attribute = false } = {}) {
  const shown = el.type === 'number' && value !== '' && !VALID_NUMBER.test(value) ? '' : value;
  if (el.value !== shown) el.value = shown;
  if (attribute && el.getAttribute('value') !== shown) el.setAttribute('value', shown);
}

export class SheetView {
  constructor({ host, sheet, character, onChange, onRoll, onError }) {
    this.host = host;
    this.sheet = sheet;
    this.character = character;
    this.onChange = onChange;
    this.onRoll = onRoll;
    this.onError = onError;

    this.attrs = Object.assign(Object.create(null), character.attrs);
    this.sections = {};
    for (const [key, ids] of Object.entries(character.sections || {})) this.sections[key] = ids.slice();

    this.bound = new Map();        // attribute -> Set of elements showing it
    this.keyOf = new WeakMap();    // element -> attribute
    this.autocalc = new Map();     // disabled element -> { key, row }
    this.groups = new Map();       // section -> [{ container, control, template }]
    this.recomputeQueued = false;
  }

  mount() {
    this.host.replaceChildren(this.sheet.template.cloneNode(true));
    this.setUpRepeatingSections();

    for (const el of this.host.querySelectorAll('[name^="attr_"]')) {
      this.bind(el, el.getAttribute('name').slice(5).toLowerCase(), null);
    }
    for (const [key, els] of this.bound) {
      if (key in this.attrs) els.forEach((el) => this.applyToElement(el, this.attrs[key]));
    }
    for (const section of this.groups.keys()) this.renderSection(section);
    this.recomputeAutocalc();

    this.host.addEventListener('change', this.handleChange);
    this.host.addEventListener('click', this.handleClick);
    this.host.addEventListener('pointerdown', this.handlePointerDown);

    this.worker = new Worker(WORKER_URL);
    this.worker.addEventListener('message', this.handleWorkerMessage);
    this.worker.addEventListener('error', (e) => this.onError?.(e.message || 'Sheet worker failed'));
    this.worker.postMessage({
      type: 'init',
      sheetUrl: this.sheet.workerUrl,
      characterId: this.character.id,
      attrs: { ...this.attrs },
      sections: this.sections,
      defaults: this.sheet.defaults,
      sectionDefaults: this.sheet.sectionDefaults,
      translations: this.sheet.translations,
      language: this.sheet.language,
    });
  }

  destroy() {
    this.worker?.terminate();
    this.host.removeEventListener('change', this.handleChange);
    this.host.removeEventListener('click', this.handleClick);
    this.host.removeEventListener('pointerdown', this.handlePointerDown);
    this.host.replaceChildren();
  }

  snapshot() {
    return { attrs: { ...this.attrs }, sections: structuredClone(this.sections) };
  }

  // For values edited outside the sheet (e.g. the character name in the toolbar).
  setAttr(name, value) {
    const key = name.toLowerCase();
    this.attrs[key] = value;
    this.applyToAll(key, value);
    this.worker.postMessage({ type: 'change', name: key, value });
    this.queueRecompute();
    this.onChange?.();
  }

  // ---- binding ------------------------------------------------------------

  bind(el, key, row) {
    let set = this.bound.get(key);
    if (!set) this.bound.set(key, (set = new Set()));
    set.add(el);
    this.keyOf.set(el, key);
    if (el.hasAttribute('disabled') && el.tagName !== 'SPAN') this.autocalc.set(el, { key, row });
  }

  unbindTree(root) {
    for (const el of root.querySelectorAll('[name^="attr_"]')) {
      const key = this.keyOf.get(el);
      if (!key) continue;
      this.bound.get(key)?.delete(el);
      if (this.bound.get(key)?.size === 0) this.bound.delete(key);
      this.autocalc.delete(el);
    }
  }

  applyToElement(el, value) {
    if (this.autocalc.has(el)) return;
    const v = value == null ? '' : String(value);
    if (el.tagName === 'INPUT') {
      if (el.type === 'checkbox' || el.type === 'radio') {
        el.checked = v === (el.getAttribute('value') ?? 'on');
      } else {
        setInputValue(el, v, { attribute: true });
      }
    } else if (el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') {
      if (el.value !== v) el.value = v;
    } else {
      el.textContent = v;
    }
  }

  applyToAll(key, value, except) {
    const els = this.bound.get(key);
    if (els) for (const el of els) if (el !== except) this.applyToElement(el, value);
  }

  defaultOf(key) {
    const p = parseRepeating(key);
    if (p && p.rowId !== null) {
      const d = this.sheet.sectionDefaults[p.section];
      return d && hasOwn(d, p.field) ? d[p.field] : undefined;
    }
    return hasOwn(this.sheet.defaults, key) ? this.sheet.defaults[key] : undefined;
  }

  valueOf(key) {
    return key in this.attrs ? this.attrs[key] : this.defaultOf(key);
  }

  // Inside a repeating row, @{field} means that row's field when the section has it.
  // Also used to fill in roll macros.
  lookup(name, row) {
    const n = name.toLowerCase();
    if (row) {
      const full = `${row.section}_${row.rowId}_${n}`;
      if (full in this.attrs || hasOwn(this.sheet.sectionDefaults[row.section] || {}, n)) return this.valueOf(full);
    }
    return this.valueOf(n);
  }

  queueRecompute() {
    if (this.recomputeQueued) return;
    this.recomputeQueued = true;
    requestAnimationFrame(() => {
      this.recomputeQueued = false;
      this.recomputeAutocalc();
    });
  }

  recomputeAutocalc() {
    for (const [el, { key, row }] of this.autocalc) {
      const raw = this.valueOf(key);
      const text =
        raw != null && String(raw).includes('@{')
          ? computeAutocalc(String(raw), (name) => this.lookup(name, row))
          : String(raw ?? '');
      setInputValue(el, text);
    }
  }

  // ---- repeating sections ---------------------------------------------------

  // Rebuilds Roll20's runtime structure after each <fieldset class="repeating_x">:
  // a .repcontainer of .repitem rows and a .repcontrol with Modify / +Add.
  setUpRepeatingSections() {
    for (const fieldset of this.host.querySelectorAll('fieldset')) {
      const cls = [...fieldset.classList].find((c) => c.startsWith('repeating_'));
      if (!cls) continue;
      const section = cls.toLowerCase();

      const template = document.createDocumentFragment();
      template.append(...fieldset.childNodes);
      fieldset.style.display = 'none';

      const container = document.createElement('div');
      container.className = 'repcontainer ui-sortable';
      container.dataset.groupname = section;

      const control = document.createElement('div');
      control.className = 'repcontrol';
      control.dataset.groupname = section;
      control.innerHTML =
        '<button type="button" class="btn repcontrol_edit">Modify</button>' +
        '<button type="button" class="btn repcontrol_add">+Add</button>';

      fieldset.after(container, control);
      if (!this.groups.has(section)) this.groups.set(section, []);
      this.groups.get(section).push({ container, control, template });
    }
  }

  renderSection(section) {
    const ids = this.sections[section] || [];
    for (const group of this.groups.get(section) || []) {
      const existing = new Map([...group.container.children].map((item) => [item.dataset.reprowid, item]));
      for (const id of ids) {
        const item = existing.get(id) || this.createRow(section, id, group);
        existing.delete(id);
        if (group.container.lastElementChild !== item) group.container.append(item);
      }
      for (const item of existing.values()) {
        this.unbindTree(item);
        item.remove();
      }
    }
  }

  createRow(section, rowId, group) {
    const item = document.createElement('div');
    item.className = 'repitem';
    item.dataset.reprowid = rowId;

    const controls = document.createElement('div');
    controls.className = 'itemcontrol';
    controls.innerHTML =
      '<button type="button" class="btn btn-danger repcontrol_del" title="Delete row">✕</button>' +
      '<a class="btn repcontrol_move" title="Drag to reorder">≡</a>';

    item.append(controls, group.template.cloneNode(true));

    const row = { section, rowId };
    for (const el of item.querySelectorAll('[name^="attr_"]')) {
      const key = `${section}_${rowId}_${el.getAttribute('name').slice(5).toLowerCase()}`;
      this.bind(el, key, row);
      if (key in this.attrs) this.applyToElement(el, this.attrs[key]);
    }
    return item;
  }

  forgetRow(section, rowId) {
    const prefix = `${section}_${rowId}_`;
    for (const key of Object.keys(this.attrs)) if (key.startsWith(prefix)) delete this.attrs[key];
  }

  // ---- DOM events -----------------------------------------------------------

  handleChange = (event) => {
    const el = event.target;
    const key = this.keyOf.get(el);
    if (!key) return;

    let value;
    if (el.type === 'checkbox') {
      value = el.checked ? el.getAttribute('value') ?? 'on' : '0';
    } else if (el.type === 'radio') {
      if (!el.checked) return;
      value = el.getAttribute('value') ?? 'on';
    } else {
      value = el.value;
      if (el.tagName === 'INPUT') el.setAttribute('value', value);
    }

    this.attrs[key] = value;
    this.applyToAll(key, value, el);
    this.worker.postMessage({ type: 'change', name: key, value });
    this.queueRecompute();
    this.onChange?.();
  };

  handleClick = (event) => {
    const target = event.target.closest('button');
    if (!target || !this.host.contains(target)) return;

    if (target.classList.contains('repcontrol_add')) return this.addRow(target.closest('.repcontrol').dataset.groupname);
    if (target.classList.contains('repcontrol_edit')) return this.toggleEditMode(target);
    if (target.classList.contains('repcontrol_del')) return this.deleteRow(target.closest('.repitem'));

    const type = target.getAttribute('type');
    const row = this.rowOf(target);
    if (type === 'roll') {
      event.preventDefault();
      this.onRoll?.({ text: target.getAttribute('value') || '', row });
      return;
    }
    if (type !== 'action') return;

    const name = target.getAttribute('name') || '';
    if (!/^act_/i.test(name)) return;
    const htmlAttributes = {};
    for (const attr of target.attributes) htmlAttributes[attr.name] = attr.value;
    this.worker.postMessage({ type: 'click', name: name.slice(4).toLowerCase(), htmlAttributes, ...row });
  };

  // { section, rowId } of the repeating row an element is in, or null.
  rowOf(el) {
    const item = el.closest('.repitem');
    if (!item || !this.host.contains(item)) return null;
    return { section: item.parentElement.dataset.groupname, rowId: item.dataset.reprowid };
  }

  addRow(section) {
    const rowId = generateRowId();
    (this.sections[section] ||= []).push(rowId);
    this.renderSection(section);
    this.worker.postMessage({ type: 'addRow', section, rowId });
    this.queueRecompute();
    this.onChange?.();
  }

  toggleEditMode(button) {
    const control = button.closest('.repcontrol');
    const container = control.previousElementSibling;
    const editing = !container.classList.contains('editmode');
    container.classList.toggle('editmode', editing);
    button.textContent = editing ? 'Done' : 'Modify';
    control.querySelector('.repcontrol_add').style.display = editing ? 'none' : '';
  }

  deleteRow(item) {
    if (!item || !confirm('Delete this row?')) return;
    const section = item.parentElement.dataset.groupname;
    const rowId = item.dataset.reprowid;
    this.sections[section] = (this.sections[section] || []).filter((id) => id !== rowId);
    this.forgetRow(section, rowId);
    this.renderSection(section);
    this.worker.postMessage({ type: 'removeRow', section, rowId });
    this.queueRecompute();
    this.onChange?.();
  }

  // Drag a row by its handle to reorder it within the section.
  handlePointerDown = (event) => {
    const handle = event.target.closest('.repcontrol_move');
    if (!handle || !this.host.contains(handle)) return;
    event.preventDefault();

    const item = handle.closest('.repitem');
    const container = item.parentElement;
    const section = container.dataset.groupname;
    const before = (this.sections[section] || []).join(',');
    item.classList.add('r20-dragging');

    const move = (e) => {
      let next = null;
      for (const sibling of container.children) {
        if (sibling === item) continue;
        const box = sibling.getBoundingClientRect();
        if (e.clientY < box.top + box.height / 2) {
          next = sibling;
          break;
        }
      }
      if (next) {
        if (item.nextElementSibling !== next) container.insertBefore(item, next);
      } else if (container.lastElementChild !== item) {
        container.append(item);
      }
    };

    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      item.classList.remove('r20-dragging');
      const ids = [...container.children].map((c) => c.dataset.reprowid);
      if (ids.join(',') === before) return;
      this.sections[section] = ids;
      this.renderSection(section);
      this.worker.postMessage({ type: 'reorder', section, ids });
      this.onChange?.();
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  };

  // ---- worker -----------------------------------------------------------------

  handleWorkerMessage = (event) => {
    const msg = event.data;
    if (msg.type === 'update') {
      this.applyUpdate(msg);
    } else if (msg.type === 'roll') {
      const row = msg.section && msg.rowId ? { section: msg.section, rowId: msg.rowId } : null;
      this.onRoll?.({ text: msg.text, row });
    } else if (msg.type === 'fatal') {
      this.onError?.(msg.message);
    }
  };

  applyUpdate({ values, sections }) {
    for (const [section, ids] of Object.entries(sections)) {
      for (const id of this.sections[section] || []) {
        if (!ids.includes(id)) this.forgetRow(section, id);
      }
      this.sections[section] = ids.slice();
      this.renderSection(section);
    }
    for (const [key, value] of Object.entries(values)) {
      this.attrs[key] = value;
      this.applyToAll(key, value);
    }
    this.queueRecompute();
    this.onChange?.();
  }
}
