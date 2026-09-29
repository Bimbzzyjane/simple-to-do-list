'use strict';

/**
 * app.js — the browser side of the app.
 * It calls the REST API in server.js with fetch(), keeps the result in the
 * "todos" array, and re-draws the list whenever something changes.
 */

const API_URL = '/api/todos';
const MAX_NOTE_LENGTH = 1000;

const elements = {
  form: document.getElementById('add-form'),
  input: document.getElementById('new-title'),
  search: document.getElementById('search'),
  sort: document.getElementById('sort'),
  list: document.getElementById('todo-list'),
  emptyState: document.getElementById('empty-state'),
  counts: document.getElementById('counts'),
  clearCompleted: document.getElementById('clear-completed'),
  status: document.getElementById('status'),
  filters: document.querySelectorAll('.filter'),
  toast: document.getElementById('toast'),
  toastMessage: document.getElementById('toast-message'),
  toastUndo: document.getElementById('toast-undo'),
};

let todos = []; // every todo we know about, in the order the server stores them
let filter = 'all'; // 'all' | 'active' | 'completed'
let sortMode = 'manual'; // 'manual' | 'due' | 'az'
let searchTerm = ''; // text typed in the search box
let expandedIds = new Set(); // ids of rows whose Details panel is open
let draggingId = null; // id of the row currently being dragged, if any
let statusTimer = null;
let toastTimer = null;
let pendingUndo = null; // { items, order } kept so a delete can be undone

// ---------------------------------------------------------------------------
// Talking to the REST API
// ---------------------------------------------------------------------------

/** Send one HTTP request and give back the parsed JSON (or null for 204). */
async function request(url, { method = 'GET', body } = {}) {
  const options = { method, headers: {} };

  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  return response.status === 204 ? null : response.json();
}

/** Pull the "error" message out of a failed response. */
async function readErrorMessage(response) {
  try {
    const data = await response.json();
    if (data && typeof data.error === 'string') return data.error;
  } catch {
    // The server did not send JSON - use the generic message below.
  }
  return `Request failed with status ${response.status}.`;
}

const api = {
  list: () => request(API_URL),
  create: (payload) => request(API_URL, { method: 'POST', body: payload }),
  update: (id, changes) => request(`${API_URL}/${id}`, { method: 'PATCH', body: changes }),
  remove: (id) => request(`${API_URL}/${id}`, { method: 'DELETE' }),
  reorder: (ids) => request(`${API_URL}/order`, { method: 'PUT', body: { ids } }),
  clearCompleted: () => request(`${API_URL}/completed`, { method: 'DELETE' }),
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Show a short message under the toolbar (green, or red when it is an error). */
function setStatus(message, isError = false) {
  elements.status.textContent = message;
  elements.status.classList.toggle('is-error', isError);

  clearTimeout(statusTimer);
  if (message) {
    statusTimer = setTimeout(() => {
      elements.status.textContent = '';
    }, 4000);
  }
}

/** Swap one todo in our local array for the fresher copy the server sent. */
function replaceTodo(updated) {
  todos = todos.map((todo) => (todo.id === updated.id ? updated : todo));
}

/** Change fields of one todo locally (used for instant feedback). */
function patchTodo(id, changes) {
  todos = todos.map((todo) => (todo.id === id ? { ...todo, ...changes } : todo));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Today's date as 'YYYY-MM-DD', the same format an <input type="date"> uses. */
function todayISO() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** '2026-10-01' -> '1 Oct 2026'. We split the string instead of using new Date()
 *  so the browser can never shift the date into another day or timezone. */
function formatDate(value) {
  const [year, month, day] = value.split('-').map(Number);
  return `${day} ${MONTHS[month - 1]} ${year}`;
}

// ---------------------------------------------------------------------------
// Actions - each one talks to the API and then re-draws the list
// ---------------------------------------------------------------------------

async function loadTodos() {
  try {
    todos = await api.list();
  } catch (error) {
    setStatus(`Could not load your list: ${error.message}`, true);
  }
  render();
}

async function addTodo(title) {
  try {
    // The server puts new todos at the end of the list.
    todos.push(await api.create({ title }));
    setStatus('Added.');
  } catch (error) {
    setStatus(error.message, true);
  }
  render();
}

async function toggleTodo(id, completed) {
  patchTodo(id, { completed }); // optimistic: update the screen immediately
  render();

  try {
    replaceTodo(await api.update(id, { completed }));
  } catch (error) {
    patchTodo(id, { completed: !completed }); // put it back on failure
    setStatus(error.message, true);
  }
  render();
}

/** Save one field (title, note or due) from the details panel. */
async function saveField(id, field, value) {
  try {
    replaceTodo(await api.update(id, { [field]: value }));
  } catch (error) {
    setStatus(error.message, true);
  }
  render();
}

/** Rename a task (used by double-click and by the panel's title field). */
async function renameTodo(id, title) {
  try {
    replaceTodo(await api.update(id, { title }));
    setStatus('Renamed.');
  } catch (error) {
    setStatus(error.message, true);
  }
  render();
}

/**
 * Save a new order. "ids" is the complete list of ids in the wanted order,
 * so this is used for drag-and-drop and for the up/down buttons.
 */
async function saveOrder(ids) {
  const backup = todos;
  const byId = new Map(todos.map((todo) => [todo.id, todo]));

  todos = ids.map((id) => byId.get(id)).filter(Boolean); // show the new order at once
  render();

  try {
    todos = await api.reorder(ids); // the server sends back the stored order
  } catch (error) {
    todos = backup;
    setStatus(error.message, true);
  }
  render();
}

/** Move one todo up (-1) or down (+1) in the full list. */
function moveBy(id, offset) {
  const ids = todos.map((todo) => todo.id);
  const from = ids.indexOf(id);
  const to = from + offset;

  if (from === -1 || to < 0 || to >= ids.length) return;

  [ids[from], ids[to]] = [ids[to], ids[from]];
  saveOrder(ids);
}

// ---------------------------------------------------------------------------
// Deleting, with a chance to change your mind
// ---------------------------------------------------------------------------

/** Remember what was just deleted so the Undo button can bring it back.
 *  "order" is the full id order from BEFORE the delete, which tells us where the
 *  tasks have to go back to. */
function showUndo(items, message, order) {
  pendingUndo = { items, order };

  elements.toastMessage.textContent = message;
  elements.toast.hidden = false;

  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 8000);
}

function hideToast() {
  elements.toast.hidden = true;
  pendingUndo = null;
  clearTimeout(toastTimer);
}

async function deleteTodo(id) {
  const todo = todos.find((item) => item.id === id);
  if (!todo) return;

  const order = todos.map((item) => item.id); // remember the order before deleting
  todos = todos.filter((item) => item.id !== id); // remove it from the screen first
  expandedIds.delete(id);
  render();

  try {
    await api.remove(id);
    showUndo([todo], `Deleted "${todo.title}"`, order);
  } catch (error) {
    setStatus(error.message, true);
    todos = await api.list(); // put the real list back on screen
    render();
  }
}

async function clearCompleted() {
  const items = todos.filter((todo) => todo.completed);
  if (items.length === 0) return;

  const order = todos.map((todo) => todo.id); // remember the order before deleting
  todos = todos.filter((todo) => !todo.completed);
  render();

  try {
    await api.clearCompleted();
    const word = items.length === 1 ? 'task' : 'tasks';
    showUndo(items, `Deleted ${items.length} finished ${word}`, order);
  } catch (error) {
    setStatus(error.message, true);
    todos = await api.list();
    render();
  }
}

/**
 * Bring the last deleted tasks back.
 * The tasks are created again from scratch, so they get brand-new ids; we then
 * put them back into their original positions with a single reorder call.
 */
async function undoDelete() {
  const snapshot = pendingUndo;
  if (!snapshot) return;

  hideToast();

  try {
    const restored = [];

    for (const item of snapshot.items) {
      const created = await api.create({ title: item.title, note: item.note, due: item.due });
      restored.push(item.completed ? await api.update(created.id, { completed: true }) : created);
    }

    const current = await api.list();
    const currentIds = new Set(current.map((todo) => todo.id));
    const newIdFor = new Map(snapshot.items.map((item, i) => [item.id, restored[i].id]));

    // Walk the order from before the delete. Restored tasks win the check, so a
    // new task can never be mistaken for an old one that still has that id.
    const wanted = [];
    for (const id of snapshot.order) {
      if (newIdFor.has(id)) wanted.push(newIdFor.get(id));
      else if (currentIds.has(id)) wanted.push(id);
    }
    // Anything added while the toast was showing goes at the end.
    for (const todo of current) {
      if (!wanted.includes(todo.id)) wanted.push(todo.id);
    }

    todos = await api.reorder(wanted);
    setStatus('Restored.');
  } catch (error) {
    setStatus(`Could not undo that: ${error.message}`, true);
    todos = await api.list();
  }
  render();
}

// ---------------------------------------------------------------------------
// Drawing the page
// ---------------------------------------------------------------------------

/** The todos that should be on screen right now (filter + search + sort). */
function visibleTodos() {
  const term = searchTerm.trim().toLowerCase();

  let rows = todos.filter((todo) => {
    if (filter === 'active' && todo.completed) return false;
    if (filter === 'completed' && !todo.completed) return false;

    if (term) {
      const haystack = `${todo.title} ${todo.note}`.toLowerCase();
      if (!haystack.includes(term)) return false;
    }
    return true;
  });

  if (sortMode === 'due') {
    rows = rows.slice().sort((a, b) => {
      if (a.due === b.due) return 0;
      if (a.due === null) return 1; // tasks without a due date go last
      if (b.due === null) return -1;
      return a.due < b.due ? -1 : 1; // 'YYYY-MM-DD' sorts alphabetically
    });
  } else if (sortMode === 'az') {
    rows = rows.slice().sort((a, b) => a.title.localeCompare(b.title));
  }

  return rows;
}

/** The message shown when the list on screen is empty. */
function emptyMessage() {
  const term = searchTerm.trim();
  if (term) return `Nothing matches "${term}".`;
  if (todos.length === 0) return 'Your list is empty - add your first task above.';
  if (filter === 'active') return 'Nothing left to do. Nice!';
  if (filter === 'completed') return 'Nothing ticked off yet.';
  return '';
}

/** Redraw the whole list and the counters. Called after every change. */
function render() {
  const rows = visibleTodos();
  // Reordering only makes sense when the visible order IS the stored order:
  // "All" tasks, no search box text, and the "My order" sort.
  const canMove = filter === 'all' && sortMode === 'manual';
  const canDrag = canMove && searchTerm.trim() === '';

  elements.list.innerHTML = '';
  rows.forEach((todo) => elements.list.appendChild(buildRow(todo, { canMove, canDrag })));

  elements.list.classList.toggle('todo-list--droppable', canDrag);

  elements.emptyState.hidden = rows.length > 0;
  elements.emptyState.textContent = emptyMessage();

  const done = todos.filter((todo) => todo.completed).length;
  const left = todos.length - done;
  let counts = todos.length === 0 ? 'Nothing on the list yet' : `${left} of ${todos.length} left`;
  if (rows.length !== todos.length) counts += ` · ${rows.length} shown`;
  elements.counts.textContent = counts;

  elements.clearCompleted.disabled = done === 0;

  elements.filters.forEach((button) => {
    button.classList.toggle('is-active', button.dataset.filter === filter);
  });
}

/** Build one <li> for a todo. */
function buildRow(todo, { canMove, canDrag }) {
  const row = document.createElement('li');
  row.className = 'todo' + (todo.completed ? ' is-done' : '');
  row.dataset.id = String(todo.id);
  row.draggable = canDrag;

  const main = document.createElement('div');
  main.className = 'todo__main';

  if (canDrag) {
    const handle = document.createElement('span');
    handle.className = 'todo__handle';
    handle.textContent = '\u2261'; // ≡ - just a visual "drag me" hint
    handle.setAttribute('aria-hidden', 'true');
    main.appendChild(handle);
  }

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'todo__checkbox';
  checkbox.dataset.action = 'toggle';
  checkbox.checked = todo.completed;
  checkbox.setAttribute('aria-label', `Mark "${todo.title}" as ${todo.completed ? 'not done' : 'done'}`);
  main.appendChild(checkbox);

  main.appendChild(buildText(todo));

  const isOpen = expandedIds.has(todo.id);
  const index = todos.findIndex((item) => item.id === todo.id);

  const actions = document.createElement('div');
  actions.className = 'todo__actions';
  actions.appendChild(
    textButton('details', isOpen ? 'Hide' : 'Details', `${isOpen ? 'Hide' : 'Show'} details for "${todo.title}"`, false, isOpen ? 'is-open' : '')
  );
  actions.appendChild(textButton('up', '\u2191', `Move "${todo.title}" up`, !canMove || index === 0));
  actions.appendChild(
    textButton('down', '\u2193', `Move "${todo.title}" down`, !canMove || index === todos.length - 1)
  );
  actions.appendChild(
    textButton('delete', 'Delete', `Delete "${todo.title}"`, false, 'btn-text--danger')
  );
  main.appendChild(actions);

  row.appendChild(main);

  const panel = buildPanel(todo);
  panel.hidden = !isOpen;
  row.appendChild(panel);

  return row;
}

/** The title plus the little labels under it (due date, "has a note"). */
function buildText(todo) {
  const block = document.createElement('div');
  block.className = 'todo__text';

  const title = document.createElement('span');
  title.className = 'todo__title';
  title.dataset.action = 'edit';
  title.title = 'Double-click to rename';
  // textContent (not innerHTML) so a task called "<b>hi</b>" stays plain text.
  title.textContent = todo.title;
  block.appendChild(title);

  const badges = document.createElement('div');
  badges.className = 'todo__badges';

  if (todo.due) {
    const today = todayISO();
    const overdue = todo.due < today && !todo.completed;
    const badge = document.createElement('span');
    badge.className =
      'badge' + (todo.due === today ? ' badge--today' : overdue ? ' badge--overdue' : '');
    badge.textContent = (overdue ? 'Overdue · ' : 'Due ') + formatDate(todo.due);
    badges.appendChild(badge);
  }

  if (todo.note) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = 'Note';
    badge.title = todo.note;
    badges.appendChild(badge);
  }

  if (badges.children.length > 0) block.appendChild(badges);
  return block;
}

/** The "Details" panel: title, note and due date inputs. */
function buildPanel(todo) {
  const panel = document.createElement('div');
  panel.className = 'todo__panel';

  const title = document.createElement('input');
  title.type = 'text';
  title.className = 'field__input';
  title.dataset.field = 'title';
  title.value = todo.title;
  title.maxLength = 200;
  panel.appendChild(field('Title', title));

  const note = document.createElement('textarea');
  note.className = 'field__input';
  note.dataset.field = 'note';
  note.rows = 3;
  note.maxLength = MAX_NOTE_LENGTH;
  note.placeholder = 'Add extra details, links, reminders...';
  note.value = todo.note;
  panel.appendChild(field('Note', note));

  const due = document.createElement('input');
  due.type = 'date';
  due.className = 'field__input';
  due.dataset.field = 'due';
  if (todo.due) due.value = todo.due;
  panel.appendChild(field('Due date', due));

  const hint = document.createElement('p');
  hint.className = 'field__hint';
  hint.textContent = 'Changes save automatically when you click away.';
  panel.appendChild(hint);

  return panel;
}

/** Wrap a labelled control for the details panel. */
function field(labelText, control) {
  const label = document.createElement('label');
  label.className = 'field';

  const caption = document.createElement('span');
  caption.className = 'field__label';
  caption.textContent = labelText;
  label.appendChild(caption);
  label.appendChild(control);

  return label;
}

/** Small labelled button: Details, the arrows, and Delete. */
function textButton(action, label, ariaLabel, disabled = false, extraClass = '') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn-text' + (extraClass ? ` ${extraClass}` : '');
  button.dataset.action = action;
  button.textContent = label;
  button.title = ariaLabel;
  button.setAttribute('aria-label', ariaLabel);
  button.disabled = disabled;
  return button;
}

// ---------------------------------------------------------------------------
// Renaming a task straight inside the row
// ---------------------------------------------------------------------------

function startEditing(row) {
  if (row.querySelector('.todo__edit')) return; // already editing this row

  const id = Number(row.dataset.id);
  const todo = todos.find((item) => item.id === id);
  if (!todo) return;

  const titleElement = row.querySelector('.todo__title');
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'todo__edit';
  input.value = todo.title;
  input.maxLength = 200;
  input.setAttribute('aria-label', 'Task title');

  let finished = false;
  const finish = (save) => {
    if (finished) return;
    finished = true;

    const title = input.value.trim();
    if (!save || title === '' || title === todo.title) {
      render(); // nothing to change - just put the text back
      return;
    }
    renameTodo(id, title);
  };

  input.addEventListener('blur', () => finish(true));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      finish(true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      finish(false);
    }
  });

  titleElement.replaceWith(input);
  input.focus();
  input.select();
}

// ---------------------------------------------------------------------------
// Drag and drop reordering (HTML5 drag events)
// ---------------------------------------------------------------------------

function onDragStart(event) {
  const row = event.target.closest('.todo');
  if (!row || !elements.list.classList.contains('todo-list--droppable')) {
    event.preventDefault(); // reordering is only allowed in the full manual list
    return;
  }

  draggingId = Number(row.dataset.id);
  row.classList.add('is-dragging');
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', String(draggingId)); // Firefox needs this
}

function onDragOver(event) {
  if (draggingId === null) return;

  event.preventDefault(); // without this, the browser refuses the drop
  event.dataTransfer.dropEffect = 'move';

  const dragged = elements.list.querySelector('.is-dragging');
  if (!dragged) return;

  // Move the dragged row to wherever the mouse is while we drag.
  const rowUnderPointer = rowAfterPointer(event.clientY);
  if (rowUnderPointer === null) {
    elements.list.appendChild(dragged);
  } else {
    elements.list.insertBefore(dragged, rowUnderPointer);
  }
}

/** Which row should the dragged row be placed in front of? */
function rowAfterPointer(pointerY) {
  const rows = Array.from(elements.list.querySelectorAll('.todo:not(.is-dragging)'));
  let closest = { offset: Number.NEGATIVE_INFINITY, row: null };

  for (const row of rows) {
    const box = row.getBoundingClientRect();
    const offset = pointerY - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) closest = { offset, row };
  }

  return closest.row;
}

function onDragEnd() {
  const dragged = elements.list.querySelector('.is-dragging');
  if (dragged) dragged.classList.remove('is-dragging');
  if (draggingId === null) return;

  draggingId = null;

  const newIds = Array.from(elements.list.querySelectorAll('.todo')).map((row) => Number(row.dataset.id));
  const oldIds = todos.map((todo) => todo.id);

  if (newIds.join(',') === oldIds.join(',')) {
    render(); // nothing moved - just tidy up
  } else {
    saveOrder(newIds);
  }
}

// ---------------------------------------------------------------------------
// Event wiring + start
// ---------------------------------------------------------------------------

function bindEvents() {
  // Adding a task (pressing Enter in the box also submits the form)
  elements.form.addEventListener('submit', (event) => {
    event.preventDefault();
    const title = elements.input.value.trim();
    if (title === '') return;

    elements.input.value = '';
    elements.input.focus();
    addTodo(title);
  });

  // Search: filters as you type, without touching the server
  elements.search.addEventListener('input', () => {
    searchTerm = elements.search.value;
    render();
  });

  // Sorting
  elements.sort.addEventListener('change', () => {
    sortMode = elements.sort.value;
    render();
  });

  // Filter buttons
  elements.filters.forEach((button) => {
    button.addEventListener('click', () => {
      filter = button.dataset.filter;
      render();
    });
  });

  // Bulk delete + undo
  elements.clearCompleted.addEventListener('click', clearCompleted);
  elements.toastUndo.addEventListener('click', undoDelete);

  // Press "/" to jump to the search box (unless you are already typing)
  document.addEventListener('keydown', (event) => {
    const typing =
      document.activeElement === elements.input || document.activeElement === elements.search;
    if (event.key === '/' && !typing) {
      event.preventDefault();
      elements.search.focus();
    }
  });

  // One listener per event type on the <ul>, using event delegation: rows come
  // and go as we re-render, but the <ul> itself always stays put.
  elements.list.addEventListener('change', (event) => {
    // a field inside the details panel was edited
    const control = event.target.closest('[data-field]');
    if (control) {
      const id = Number(control.closest('.todo').dataset.id);
      const name = control.dataset.field;

      if (name === 'title') {
        const title = control.value.trim();
        if (title === '') {
          control.value = todos.find((todo) => todo.id === id).title; // never allow empty
          return;
        }
        saveField(id, 'title', title);
      } else if (name === 'note') {
        saveField(id, 'note', control.value);
      } else if (name === 'due') {
        saveField(id, 'due', control.value === '' ? null : control.value);
      }
      return;
    }

    // the checkbox was ticked or unticked
    const checkbox = event.target.closest('[data-action="toggle"]');
    if (checkbox) {
      toggleTodo(Number(checkbox.closest('.todo').dataset.id), checkbox.checked);
    }
  });

  elements.list.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button || button.disabled) return;

    const id = Number(button.closest('.todo').dataset.id);
    const action = button.dataset.action;

    if (action === 'details') {
      if (expandedIds.has(id)) expandedIds.delete(id);
      else expandedIds.add(id);
      render();
    } else if (action === 'up') {
      moveBy(id, -1);
    } else if (action === 'down') {
      moveBy(id, 1);
    } else if (action === 'delete') {
      deleteTodo(id);
    }
  });

  elements.list.addEventListener('dblclick', (event) => {
    const title = event.target.closest('.todo__title');
    if (title) startEditing(title.closest('.todo'));
  });

  elements.list.addEventListener('dragstart', onDragStart);
  elements.list.addEventListener('dragover', onDragOver);
  elements.list.addEventListener('drop', (event) => event.preventDefault());
  elements.list.addEventListener('dragend', onDragEnd);
}

bindEvents();
loadTodos();


