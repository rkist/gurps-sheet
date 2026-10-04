// The dialog that asks Roll20's ?{...} prompts, and the panel that lists the
// Roll20 commands to copy into the game's chat.

const MAX_ROLLS = 5;

// Resolves to a Map of prompt -> answer, or null if the player cancels.
export function askQueries(dialog, title, queries) {
  dialog.querySelector('.app-dialog-title').textContent = title || 'Roll';
  const inputs = queries.map((query) => {
    let input;
    if (query.options) {
      input = document.createElement('select');
      for (const option of query.options) input.append(new Option(option.label, option.value));
    } else {
      input = document.createElement('input');
      input.type = 'text';
      input.value = query.defaultValue;
      input.autocomplete = 'off';
      input.spellcheck = false;
    }
    const label = document.createElement('label');
    label.className = 'app-field';
    const text = document.createElement('span');
    text.textContent = query.prompt;
    label.append(text, input);
    return { input, label };
  });
  dialog.querySelector('.app-dialog-fields').replaceChildren(...inputs.map((i) => i.label));

  return new Promise((resolve) => {
    dialog.returnValue = '';
    dialog.addEventListener(
      'close',
      () => resolve(dialog.returnValue === 'roll' ? new Map(queries.map((q, n) => [q.prompt, inputs[n].input.value])) : null),
      { once: true },
    );
    dialog.showModal();
    const first = inputs[0]?.input;
    first?.focus();
    if (first?.select) first.select();
  });
}

export class RollPanel {
  constructor(el) {
    this.el = el;
    this.list = el.querySelector('.app-rolls-list');
    el.querySelector('.app-rolls-close').addEventListener('click', () => (el.hidden = true));
    this.list.addEventListener('click', (event) => {
      const button = event.target.closest('.app-roll-copy');
      if (button) this.copy(button);
    });
  }

  // Shows a roll from buildRoll() at the top and copies its first command.
  add(roll) {
    const item = document.createElement('li');
    item.className = 'app-roll';

    const head = document.createElement('p');
    head.className = 'app-roll-head';
    const title = document.createElement('strong');
    title.textContent = roll.title || roll.subtitle || 'Roll';
    const meta = document.createElement('span');
    meta.textContent = [roll.title ? roll.subtitle : '', roll.gm ? 'GM only' : ''].filter(Boolean).join(' · ');
    head.append(title, ' ', meta);
    item.append(head);

    for (const command of roll.commands) {
      const row = document.createElement('div');
      row.className = 'app-roll-command';
      const code = document.createElement('code');
      code.textContent = command.text;
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'app-btn app-roll-copy';
      copy.dataset.command = command.text;
      copy.textContent = 'Copy';
      row.append(code, copy);
      item.append(row);
      if (command.target != null) {
        const hint = document.createElement('p');
        hint.className = 'app-roll-hint';
        hint.textContent = `Succeeds on ${command.target} or less`;
        item.append(hint);
      }
    }

    this.list.prepend(item);
    while (this.list.children.length > MAX_ROLLS) this.list.lastElementChild.remove();
    this.el.hidden = false;
    this.copy(item.querySelector('.app-roll-copy'));
  }

  clear() {
    this.list.replaceChildren();
    this.el.hidden = true;
  }

  async copy(button) {
    for (const other of this.list.querySelectorAll('.app-roll-copy')) other.textContent = 'Copy';
    try {
      await navigator.clipboard.writeText(button.dataset.command);
      button.textContent = 'Copied';
    } catch {
      // No clipboard access (e.g. the page lost focus): select it for Ctrl+C instead.
      getSelection().selectAllChildren(button.previousElementSibling);
    }
  }
}
