// The player's own GURPS PDFs, kept in this browser only (never in the group
// library), and the links that open a Ref field's page references in them:
// hovering or focusing a Ref field shows a button per reference.
import { guessBook, parseRefs, resolveRef } from './page-refs.js';
import * as store from './store.js';

const REF_FIELDS = 'input[name="attr_ref"], input[name="attr_race_ref"]';
const HOVER_MS = 300;

const newBookId = () => `k-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const numberOrNull = (text) => (text.trim() === '' || !Number.isFinite(Number(text)) ? null : Math.trunc(Number(text)));
const byCode = (a, b) => a.code.localeCompare(b.code) || (a.first ?? 0) - (b.first ?? 0) || a.name.localeCompare(b.name);

const BOOK_FIELDS = `
  <p class="app-book-name"></p>
  <div class="app-book-fields">
    <label class="app-field app-book-code"><span>Code</span><input name="code" autocomplete="off" spellcheck="false" placeholder="B"></label>
    <label class="app-field"><span>First page</span><input name="first" type="number" min="1" placeholder="any"></label>
    <label class="app-field"><span>Last page</span><input name="last" type="number" min="1" placeholder="any"></label>
    <label class="app-field"><span>Printed page</span><input name="anchor" type="number" min="1"></label>
    <label class="app-field"><span>is PDF page</span><input name="pdf" type="number" min="1"></label>
    <span class="app-book-actions">
      <button type="button" class="app-btn" data-action="open">Open</button>
      <button type="button" class="app-btn" data-action="remove">Remove</button>
    </span>
  </div>`;

export class Books {
  // host: the sheet's container. dialog: the Books dialog. links: the popover
  // with a Ref field's buttons. notify(message, isError) tells the player.
  constructor({ host, dialog, links, notify }) {
    this.host = host;
    this.dialog = dialog;
    this.links = links;
    this.notify = notify;
    this.books = [];
    this.files = new Map(); // book id -> the PDF, as a Blob
    this.urls = new Map();  // book id -> the blob: URL its tab shows
    this.field = null;      // the Ref field the popover shows
    this.timer = 0;
    this.ready = Promise.resolve();

    this.list = dialog.querySelector('.app-books');
    this.fileInput = dialog.querySelector('input[type="file"]');
    dialog.querySelector('[data-action="add"]').addEventListener('click', () => {
      this.fileInput.value = '';
      this.fileInput.click();
    });
    this.fileInput.addEventListener('change', () => this.report(this.addFiles([...this.fileInput.files])));
    this.list.addEventListener('input', (e) => this.report(this.update(e.target.closest('.app-book'))));
    this.list.addEventListener('click', (e) => {
      const button = e.target.closest('button[data-action]');
      const book = button && this.books.find((b) => b.id === button.closest('.app-book').dataset.id);
      if (!book) return;
      if (button.dataset.action === 'open') this.openPage(book, (book.anchor ?? 1) + book.offset);
      if (button.dataset.action === 'remove') this.report(this.remove(book));
    });

    host.addEventListener('pointerover', (e) => {
      const field = e.target.closest?.(REF_FIELDS);
      if (field) this.later(() => this.showLinks(field));
    });
    host.addEventListener('pointerout', (e) => {
      if (e.target.matches?.(REF_FIELDS)) this.later(() => this.settle());
    });
    host.addEventListener('focusin', (e) => {
      if (e.target.matches?.(REF_FIELDS)) this.showLinks(e.target);
    });
    host.addEventListener('focusout', (e) => {
      if (e.target === this.field && !links.contains(e.relatedTarget)) this.hideLinks();
    });
    host.addEventListener('input', (e) => {
      if (e.target === this.field) this.renderLinks();
    });
    // The links come after the sheet in the page, so the down arrow takes the
    // focus there from a Ref field, and the up arrow or Escape brings it back.
    host.addEventListener('keydown', (e) => {
      if (e.target !== this.field) return;
      if (e.key === 'Escape') this.hideLinks();
      if (e.key === 'ArrowDown' && !this.links.hidden) {
        e.preventDefault();
        this.links.firstElementChild?.focus();
      }
    });
    links.addEventListener('keydown', (e) => {
      if (!['ArrowUp', 'Escape'].includes(e.key) || !this.field) return;
      e.preventDefault();
      this.field.focus();
      if (e.key === 'Escape') this.hideLinks();
    });
    links.addEventListener('focusout', (e) => {
      if (e.relatedTarget !== this.field && !links.contains(e.relatedTarget)) this.hideLinks();
    });

    // Clicking a button keeps the focus in the Ref field, so the popover stays.
    links.addEventListener('mousedown', (e) => e.preventDefault());
    links.addEventListener('pointerenter', () => clearTimeout(this.timer));
    links.addEventListener('pointerleave', () => this.later(() => this.settle()));
    links.addEventListener('click', (e) => {
      const button = e.target.closest('button');
      if (!button) return;
      if (button.dataset.action === 'books') return this.showDialog();
      const book = this.books.find((b) => b.id === button.dataset.book);
      if (book) this.openPage(book, Number(button.dataset.page));
    });
    window.addEventListener('scroll', () => this.place(), { capture: true, passive: true });
    window.addEventListener('resize', () => this.place());
    window.addEventListener('hashchange', () => this.hideLinks());
  }

  load() {
    this.ready = (async () => {
      const books = await store.listBooks();
      await Promise.all(books.map(async (book) => this.files.set(book.id, await store.getBookFile(book.id))));
      this.books = books.sort(byCode);
    })();
    return this.ready;
  }

  report(promise) {
    promise.catch((err) => {
      console.error(err);
      this.notify(err.message || String(err), true);
    });
  }

  later(action) {
    clearTimeout(this.timer);
    this.timer = setTimeout(action, HOVER_MS);
  }

  // Opens the PDF at a page, in one tab per book. Chrome's PDF viewer doesn't
  // follow a change of #page alone, so each time gets a new blob: URL, and the
  // one the tab showed before can go.
  openPage(book, pdfPage) {
    const file = this.files.get(book.id);
    if (!file) return this.notify(`The PDF ${book.name} is missing; add it again in Books.`, true);
    const url = URL.createObjectURL(file);
    if (!window.open(`${url}#page=${pdfPage}`, `gurps-book-${book.id}`)) {
      URL.revokeObjectURL(url);
      return this.notify('The browser blocked the new tab. Allow pop-ups for this site to open your books.', true);
    }
    this.forgetUrl(book);
    this.urls.set(book.id, url);
  }

  forgetUrl(book) {
    if (this.urls.has(book.id)) URL.revokeObjectURL(this.urls.get(book.id));
    this.urls.delete(book.id);
  }

  // ---- the Ref field popover ---------------------------------------------------

  showLinks(field) {
    clearTimeout(this.timer);
    this.field = field;
    this.renderLinks();
  }

  hideLinks() {
    clearTimeout(this.timer);
    this.field = null;
    this.links.hidden = true;
  }

  // Once the pointer leaves: back to the focused Ref field, if there is one.
  settle() {
    const focused = document.activeElement;
    if (this.links.contains(focused)) return;
    if (focused?.matches(REF_FIELDS) && this.host.contains(focused)) this.showLinks(focused);
    else this.hideLinks();
  }

  renderLinks() {
    const refs = this.field?.isConnected ? parseRefs(this.field.value) : [];
    if (!refs.length) {
      this.links.hidden = true;
      return;
    }
    const buttons = [];
    const missing = new Set();
    for (const ref of refs) {
      const found = resolveRef(this.books, ref);
      if (!found) {
        missing.add(ref.code);
        continue;
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'app-ref-link';
      button.textContent = ref.text;
      button.title = `${found.book.name}, PDF page ${found.pdfPage}`;
      button.dataset.book = found.book.id;
      button.dataset.page = found.pdfPage;
      buttons.push(button);
    }
    if (missing.size) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'app-ref-missing';
      button.textContent = `No PDF for ${[...missing].join(', ')}`;
      button.title = 'Add your PDFs in Books';
      button.dataset.action = 'books';
      buttons.push(button);
    }
    this.links.replaceChildren(...buttons);
    this.links.hidden = false;
    this.place();
  }

  // Below the field, or above it near the bottom of the window.
  place() {
    if (this.links.hidden || !this.field) return;
    const box = this.field.getBoundingClientRect();
    if (!this.field.isConnected || !box.width || box.bottom < 0 || box.top > innerHeight) return this.hideLinks();
    const { offsetWidth: width, offsetHeight: height } = this.links;
    const below = box.bottom + 4 + height <= innerHeight;
    this.links.style.left = `${Math.max(8, Math.min(box.left, innerWidth - width - 8))}px`;
    this.links.style.top = `${below ? box.bottom + 4 : box.top - height - 4}px`;
  }

  // ---- the Books dialog ----------------------------------------------------------

  async showDialog() {
    this.hideLinks();
    await this.ready.catch(() => {});
    this.renderDialog();
    this.dialog.showModal();
  }

  renderDialog() {
    this.list.replaceChildren(
      ...this.books.map((book) => {
        const item = document.createElement('li');
        item.className = 'app-book';
        item.dataset.id = book.id;
        item.innerHTML = BOOK_FIELDS;
        item.querySelector('.app-book-name').textContent = book.name;
        const set = (name, value) => (item.querySelector(`[name="${name}"]`).value = value ?? '');
        set('code', book.code);
        set('first', book.first);
        set('last', book.last);
        set('anchor', book.anchor);
        set('pdf', book.anchor + book.offset);
        return item;
      }),
    );
    this.dialog.querySelector('.app-books-empty').hidden = this.books.length > 0;
  }

  async addFiles(files) {
    for (const file of files) {
      if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) {
        this.notify(`${file.name} is not a PDF.`, true);
        continue;
      }
      const guess = guessBook(file.name);
      const book = {
        id: newBookId(),
        name: file.name,
        code: guess.code || '',
        first: guess.first ?? null,
        last: guess.last ?? null,
        anchor: guess.first ?? 1,
        offset: 0,
        addedAt: Date.now(),
      };
      await store.addBook(book, file);
      this.books.push(book);
      this.files.set(book.id, file);
    }
    this.books.sort(byCode);
    this.renderDialog();
  }

  // Saves a book's fields as the player types. The offset changes only when
  // both the printed page and its PDF page are filled in.
  async update(item) {
    const book = this.books.find((b) => b.id === item?.dataset.id);
    if (!book) return;
    const text = (name) => item.querySelector(`[name="${name}"]`).value;
    book.code = text('code').trim().toUpperCase();
    book.first = numberOrNull(text('first'));
    book.last = numberOrNull(text('last'));
    const anchor = numberOrNull(text('anchor'));
    const pdf = numberOrNull(text('pdf'));
    if (anchor != null && pdf != null) Object.assign(book, { anchor, offset: pdf - anchor });
    await store.putBook(book);
  }

  async remove(book) {
    await store.deleteBook(book.id);
    this.books = this.books.filter((b) => b !== book);
    this.files.delete(book.id);
    this.forgetUrl(book);
    this.renderDialog();
  }
}
