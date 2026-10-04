// Loads the Roll20 GURPS sheet files and prepares them the way Roll20's
// legacy sheet pipeline would: class prefixing, i18n, defaults, icon fonts.

const BASE = new URL('../sheet/', import.meta.url);

// Roll20 serves proprietary icon fonts (Pictos, dicefont*). We can't ship
// them, so glyphs are mapped to Unicode symbols instead.
const ICON_GLYPHS = {
  pictos: {
    y: '⚙', i: 'ℹ', W: '✎', F: '▤', 0: '↻', 3: '✓', '&': '▸', _: '▾',
    '~': '⇄', L: '☛', t: '✸', '#': '✕', x: '✕', '+': '+', '?': '?',
  },
  'pictos custom': { t: '✸' },
  'pictos three': {},
  dicefontd6: { L: '⚅' },
  dicefontd20: { 0: '⬢', T: '⬢' },
  dicefontd4: { '@': '☠' },
};
const ICON_FONT = /font-family\s*:\s*["']?(pictos three|pictos custom|pictos|dicefontd20|dicefontd6|dicefontd4)["']?/i;

// Elements whose text content is a Pictos letter.
const TEXT_ICON_SELECTOR = [
  '.sheet-info-icon',
  '.sheet-pencil-pad-icon',
  '.sheet-paper-icon',
  '.sheet-reset-icon',
  '.sheet-conditional-marker',
  '.sheet-help-icon',
  '.sheet-col-mod-tool .sheet-icon',
  'input.sheet-tab0 + span',
].join(',');

// Languages with real translations upstream. Left out: pb, ca, fi, hu, sl
// (untranslated) and zu (Crowdin placeholder strings).
export const LANGUAGES = [
  'en', 'pt', 'es', 'fr', 'de', 'it', 'nl', 'pl', 'ru', 'uk', 'cs', 'sv', 'da',
  'tr', 'el', 'he', 'ja', 'ko', 'zh', 'af',
];
// Crowdin file names -> BCP 47, for display names.
export const LANGUAGE_TAGS = { zh: 'zh-TW' };

async function fetchText(name) {
  const res = await fetch(new URL(name, BASE));
  if (!res.ok) throw new Error(`Could not load sheet/${name} (${res.status})`);
  return res.text();
}

async function fetchJSON(name) {
  return JSON.parse(await fetchText(name));
}

export async function loadSheet(language = 'en') {
  const [html, css, meta, english] = await Promise.all([
    fetchText('gurps.html'),
    fetchText('gurps.css'),
    fetchJSON('sheet.json'),
    fetchJSON('translation.json'),
  ]);

  let translations = english;
  if (language !== 'en') {
    try {
      translations = { ...english, ...(await fetchJSON(`translations/${language}.json`)) };
    } catch (err) {
      console.warn(`No translation for "${language}", using English`, err);
      language = 'en';
    }
  }

  const worker = /<script\s+type=["']text\/worker["']\s*>([\s\S]*?)<\/script>/i.exec(html);
  if (!worker) throw new Error('gurps.html has no sheet worker script');
  const markup = html.slice(0, worker.index) + html.slice(worker.index + worker[0].length);
  const version = /const\s+version\s*=\s*"([^"]+)"/.exec(worker[1])?.[1] ?? 'unknown';

  const doc = new DOMParser().parseFromString(
    `<!DOCTYPE html><html><body>${closeFormattingTags(markup)}</body></html>`,
    'text/html',
  );
  prepareMarkup(doc.body, translations);
  const { defaults, sectionDefaults } = collectDefaults(doc.body);

  const template = document.createDocumentFragment();
  template.append(...document.importNode(doc.body, true).childNodes);

  return {
    version,
    authors: meta.authors || '',
    language,
    translations,
    template,
    defaults,
    sectionDefaults,
    css: rewriteIconFonts(css),
    workerUrl: URL.createObjectURL(new Blob([worker[1]], { type: 'text/javascript' })),
    newCharacterAttrs: userOptionDefaults(meta),
  };
}

const FORMATTING_TAGS = new Set(['a', 'b', 'big', 'code', 'em', 'font', 'i', 'nobr', 's', 'small', 'strike', 'strong', 'tt', 'u']);
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW_TEXT_TAGS = new Set(['textarea', 'script', 'style', 'title']);

// The sheet has a few unclosed <b> tags. Roll20's sanitizer closes them at the
// end of their parent; a browser parser instead re-opens them around later
// content, which wraps whole tabs in <b> and breaks the tab CSS. Insert the
// missing closing tags before parsing.
function closeFormattingTags(html) {
  const lower = html.toLowerCase();
  const tagPattern = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  const stack = [];
  let out = '';
  let last = 0;
  let m;
  while ((m = tagPattern.exec(html))) {
    if (!m[2]) continue; // comment
    const tag = m[2].toLowerCase();
    if (m[1] !== '/') {
      if (VOID_TAGS.has(tag) || /\/\s*$/.test(m[3])) continue;
      stack.push(tag);
      if (RAW_TEXT_TAGS.has(tag)) {
        const end = lower.indexOf('</' + tag, tagPattern.lastIndex);
        if (end < 0) break;
        tagPattern.lastIndex = end;
      }
      continue;
    }
    const index = stack.lastIndexOf(tag);
    if (index < 0) continue; // stray closing tag; the parser ignores it
    let missing = '';
    while (stack.length - 1 > index) {
      const open = stack.pop();
      if (FORMATTING_TAGS.has(open)) missing += `</${open}>`;
    }
    stack.pop();
    if (missing) {
      out += html.slice(last, m.index) + missing;
      last = m.index;
    }
  }
  return out + html.slice(last);
}

function prepareMarkup(root, translations) {
  root.querySelectorAll('script, rolltemplate').forEach((el) => el.remove());

  // Translations first: some contain markup that also needs class prefixing.
  for (const el of root.querySelectorAll('[data-i18n]')) {
    const key = el.getAttribute('data-i18n');
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) continue;
    if (Object.prototype.hasOwnProperty.call(translations, key)) el.innerHTML = translations[key];
  }

  for (const el of root.querySelectorAll('*')) {
    for (const attr of [...el.attributes]) {
      if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
    }
    // Legacy Roll20 sheets: classes also get a "sheet-" prefixed copy. The
    // originals stay too; the GURPS CSS relies on both (e.g. `.roll_damage`).
    const cls = el.getAttribute('class');
    if (cls) {
      const names = new Set();
      for (const c of cls.split(/\s+/)) {
        if (!c) continue;
        names.add(c);
        if (!c.startsWith('sheet-') && !(el.tagName === 'FIELDSET' && c.startsWith('repeating_'))) names.add('sheet-' + c);
      }
      el.setAttribute('class', [...names].join(' '));
    }
  }

  for (const el of root.querySelectorAll(TEXT_ICON_SELECTOR)) {
    if (el.children.length) continue;
    const glyph = ICON_GLYPHS.pictos[el.textContent.trim()];
    if (glyph) el.textContent = glyph;
  }
}

function fieldDefault(el) {
  if (el.tagName === 'INPUT') {
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    if (type === 'checkbox') return el.hasAttribute('checked') ? el.getAttribute('value') ?? 'on' : '0';
    if (type === 'radio') return el.hasAttribute('checked') ? el.getAttribute('value') ?? 'on' : undefined;
    return el.getAttribute('value') ?? '';
  }
  if (el.tagName === 'TEXTAREA') return el.textContent;
  if (el.tagName === 'SELECT') {
    const options = [...el.querySelectorAll('option')];
    const selected = options.find((o) => o.hasAttribute('selected')) || options[0];
    return selected ? selected.getAttribute('value') ?? selected.textContent : '';
  }
  return undefined; // spans only display values
}

function collectDefaults(root) {
  const defaults = {};
  const sectionDefaults = {};

  const record = (target, el) => {
    const field = el.getAttribute('name').slice(5).toLowerCase();
    const value = fieldDefault(el);
    if (value === undefined) return;
    const isCheckedRadio = el.type === 'radio';
    if (!(field in target) || isCheckedRadio) target[field] = value;
  };

  for (const fieldset of root.querySelectorAll('fieldset')) {
    const section = [...fieldset.classList].find((c) => c.startsWith('repeating_'));
    if (!section) continue;
    const target = (sectionDefaults[section.toLowerCase()] ||= {});
    fieldset.querySelectorAll('[name^="attr_"]').forEach((el) => record(target, el));
  }

  for (const el of root.querySelectorAll('[name^="attr_"]')) {
    if (el.closest('fieldset')) continue;
    record(defaults, el);
  }

  return { defaults, sectionDefaults };
}

// sheet.json "useroptions" are the defaults Roll20 applies to new characters.
function userOptionDefaults(meta) {
  const out = {};
  for (const option of meta.useroptions || []) {
    if (!option.attribute) continue;
    const key = option.attribute.toLowerCase();
    if (option.type === 'checkbox') out[key] = option.checked === 'checked' ? String(option.value ?? '1') : '0';
    else if (option.default !== undefined) out[key] = String(option.default);
  }
  return out;
}

function rewriteIconFonts(css) {
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return css.replace(/([^{}]*)\{([^{}]*)\}/g, (rule, selector, body) => {
    const match = ICON_FONT.exec(body);
    let font = match ? match[1].toLowerCase() : null;
    // These set only `content`; the Pictos font comes from another rule.
    if (!font && /content\s*:/.test(body) && /sheet-checkbox:before/.test(selector)) font = 'pictos';
    if (!font) return rule;
    const glyphs = ICON_GLYPHS[font];
    const newBody = body
      .replace(new RegExp(ICON_FONT.source, 'gi'), 'font-family: var(--r20-icon-font)')
      .replace(/content\s*:\s*(["'])(.)\1/g, (decl, quote, ch) => (glyphs[ch] ? `content: "${glyphs[ch]}"` : decl));
    return `${selector}{${newBody}}`;
  });
}
