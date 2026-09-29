'use strict';

/**
 * test/frontend.test.js
 * ---------------------------------------------------------------------------
 * Runs public/app.js against a tiny fake browser (a "DOM stub"), so we can check
 * the page logic without opening a real browser. Run it with:  npm test
 *
 * This is a beginner-friendly test: no extra libraries, just the two helpers
 * below and a list of things to check.
 */

const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

let passed = 0;
let failed = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`        got:      ${JSON.stringify(actual)}\n        expected: ${JSON.stringify(expected)}`);
}

// ---------------------------------------------------------------------------
// A very small stand-in for the browser
// ---------------------------------------------------------------------------

class FakeElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.attrs = {};
    this.listeners = {};
    this._classes = new Set();
    this._text = '';
    this.type = '';
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.draggable = false;
    this.maxLength = 0;
    this.rows = 0;
    this.title = '';

    const self = this;
    this.classList = {
      add: (...names) => names.forEach((name) => self._classes.add(name)),
      remove: (...names) => names.forEach((name) => self._classes.delete(name)),
      contains: (name) => self._classes.has(name),
      toggle: (name, force) => {
        const on = force === undefined ? !self._classes.has(name) : !!force;
        if (on) self._classes.add(name);
        else self._classes.delete(name);
        return on;
      },
    };
  }

  set className(value) {
    this._classes = new Set(String(value).split(/\s+/).filter(Boolean));
  }

  get className() {
    return [...this._classes].join(' ');
  }

  set textContent(value) {
    this._text = String(value);
    this.children = [];
  }

  get textContent() {
    return this.children.length ? this.children.map((child) => child.textContent).join('') : this._text;
  }

  // Assigning innerHTML = '' is how app.js empties the list.
  set innerHTML(value) {
    if (value === '') this.children = [];
  }

  setAttribute(name, value) {
    this.attrs[name] = value;
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  replaceWith(node) {
    this.replaceNode = node;
  }

  remove() {}
  focus() {}
  select() {}

  addEventListener(type, handler) {
    (this.listeners[type] = this.listeners[type] || []).push(handler);
  }

  /** Pretend the user did something (click, change, submit ...). */
  fire(type, extra = {}) {
    (this.listeners[type] || []).forEach((handler) =>
      handler({ preventDefault() {}, target: this, ...extra })
    );
  }
}

// The page elements from index.html that app.js looks up by id.
const ids = [
  'add-form', 'new-title', 'search', 'sort', 'todo-list', 'empty-state',
  'counts', 'clear-completed', 'status', 'toast', 'toast-message', 'toast-undo',
];
const elements = {};
ids.forEach((id) => {
  elements[id] = new FakeElement(id === 'todo-list' ? 'ul' : 'div');
});

const filterButtons = ['all', 'active', 'completed'].map((name) => {
  const button = new FakeElement('button');
  button.dataset.filter = name;
  return button;
});

global.document = {
  getElementById: (id) => elements[id] || null,
  querySelectorAll: (selector) => (selector === '.filter' ? filterButtons : []),
  createElement: (tag) => new FakeElement(tag),
  addEventListener() {},
  activeElement: null,
};
global.window = { confirm: () => true };
global.setTimeout = () => 0; // stops the status/toast messages from clearing
global.clearTimeout = () => {};

// ---------------------------------------------------------------------------
// A fake API, so the tests never touch a real database
// ---------------------------------------------------------------------------

let serverState = [
  { id: 1, title: 'Buy milk', note: 'Two bottles', due: null, completed: false },
  { id: 2, title: 'Walk the dog', note: '', due: null, completed: true },
  { id: 3, title: 'Pay the rent', note: 'Due to the agent', due: '2026-10-01', completed: false },
];
let calls = [];
let failNextRequest = false;

global.fetch = async (url, options = {}) => {
  const method = options.method || 'GET';
  const body = options.body ? JSON.parse(options.body) : undefined;
  calls.push(`${method} ${url}${options.body ? ' ' + options.body : ''}`);

  if (failNextRequest) {
    failNextRequest = false;
    throw new Error('network down');
  }

  const ok = (data, status = 200) => ({ ok: true, status, json: async () => data });
  const last = Number(url.split('/').pop());

  switch (method) {
    case 'GET':
      return ok(serverState);
    case 'POST': {
      // Give the new task an id that is not in use yet, the way SQLite's
      // AUTOINCREMENT does.
      const highest = serverState.reduce((max, item) => Math.max(max, item.id), 0);
      const created = { id: highest + 1, note: '', due: null, completed: false, ...body };
      serverState.push(created);
      return ok(created, 201);
    }
    case 'PATCH': {
      const todo = serverState.find((item) => item.id === last);
      Object.assign(todo, body);
      return ok(todo);
    }
    case 'PUT': {
      serverState = body.ids.map((id) => serverState.find((item) => item.id === id));
      return ok(serverState);
    }
    case 'DELETE':
      if (url.endsWith('/completed')) {
        const before = serverState.length;
        serverState = serverState.filter((todo) => !todo.completed);
        return ok({ deleted: before - serverState.length, todos: serverState });
      }
      serverState = serverState.filter((item) => item.id !== last);
      return { ok: true, status: 204, json: async () => ({}) };
    default:
      return ok({ error: 'not found' }, 404);
  }
};

// Load app.js and hand back the bits the tests want to poke at.
const load = new Function(
  source +
    '\n; return { getTodos: () => todos, getFilter: () => filter, getSort: () => sortMode,' +
    ' setFilter: (value) => { filter = value; render(); },' +
    ' setSort: (value) => { sortMode = value; render(); },' +
    ' setSearch: (value) => { searchTerm = value; render(); },' +
    ' setTodos: (value) => { todos = value; render(); },' +
    ' toggleTodo, addTodo, deleteTodo, clearCompleted, undoDelete, moveBy,' +
    ' saveField, buildRow };'
);

const app = load();
const list = elements['todo-list'];

/** Let all the pending promises finish. */
const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve));
};

/** Find the first element with a given class, wherever it sits in the row. */
function findByClass(element, className) {
  if (element._classes && element._classes.has(className)) return element;
  for (const child of element.children) {
    const found = findByClass(child, className);
    if (found) return found;
  }
  return null;
}

/** The task title shown on a row. */
const titleOf = (row) => findByClass(row, 'todo__title').textContent;

async function run() {
  await settle();

  console.log('\nFRONTEND TESTS');

  console.log('\n1) First render');
  check('every task is drawn', list.children.length, 3);
  check('counter text', elements.counts.textContent, '2 of 3 left');
  check('empty message is hidden', elements['empty-state'].hidden, true);
  check('clear-done is enabled', elements['clear-completed'].disabled, false);

  console.log('\n2) A task row');
  const row = list.children[2]; // "Pay the rent" (has a note and a due date)
  const main = row.children[0];
  const actions = main.children[3];

  check('row classes', row.className, 'todo');
  check('four buttons', actions.children.map((b) => b.textContent), ['Details', '↑', '↓', 'Delete']);
  check('Delete is a labelled button', actions.children[3].className, 'btn-text btn-text--danger');

  const text = main.children[2];
  const badges = text.children[1];
  check('title text', text.children[0].textContent, 'Pay the rent');
  check('a due badge and a note badge', badges.children.length, 2);
  check('due badge text', badges.children[0].textContent, 'Due 1 Oct 2026');
  check('note badge text', badges.children[1].textContent, 'Note');

  console.log('\n3) The Details panel');
  const panel = row.children[1];
  const panelFields = panel.children.filter((child) => child.className === 'field');
  check('panel starts closed', panel.hidden, true);
  check('panel has three fields', panelFields.length, 3);
  check('field names', panelFields.map((f) => f.children[1].dataset.field), ['title', 'note', 'due']);
  check('note is filled in', panelFields[1].children[1].value, 'Due to the agent');
  check('due date is filled in', panelFields[2].children[1].value, '2026-10-01');

  console.log('\n4) Saving a note and a due date');
  calls = [];
  await app.saveField(3, 'note', 'Ask for a receipt');
  check('PATCH was sent', calls[0], 'PATCH /api/todos/3 {"note":"Ask for a receipt"}');
  check('the new note is in our data', app.getTodos()[2].note, 'Ask for a receipt');

  calls = [];
  await app.saveField(3, 'due', null);
  check('a due date can be cleared', calls[0], 'PATCH /api/todos/3 {"due":null}');
  check('due is now null', app.getTodos()[2].due, null);

  console.log('\n5) Ticking a task off');
  calls = [];
  await app.toggleTodo(1, true);
  check('PATCH was sent', calls[0], 'PATCH /api/todos/1 {"completed":true}');
  check('saved as done', app.getTodos()[0].completed, true);

  console.log('\n6) Search');
  app.setSearch('receipt');
  check('search finds a task by its note', list.children.length, 1);
  check('counter mentions the filter', elements.counts.textContent, '1 of 3 left · 1 shown');

  app.setSearch('nothing matches this');
  check('no matches shows a message', elements['empty-state'].hidden, false);
  check('message mentions the search', elements['empty-state'].textContent, 'Nothing matches "nothing matches this".');
  app.setSearch('');

  console.log('\n7) Sorting');
  // Task 1 was ticked off in step 5, and task 3's due date was cleared in step 4,
  // so the remaining due date belongs to nobody: the "due" sort is a stable tie.
  app.setSort('az');
  check('A to Z sorts by title', [titleOf(list.children[0]), titleOf(list.children[2])], ['Buy milk', 'Walk the dog']);
  check('rows are not draggable when sorted', list.children[0].draggable, false);

  app.setSort('due');
  check('due sort leaves the order alone when no dates are set', titleOf(list.children[0]), 'Buy milk');
  app.setSort('manual');
  check('manual order is back', titleOf(list.children[0]), 'Buy milk');
  check('rows are draggable again', list.children[0].draggable, true);

  console.log('\n8) Filters');
  app.setFilter('active');
  check('active hides the two finished tasks', list.children.length, 1);
  app.setFilter('completed');
  check('done shows only the finished ones', list.children.length, 2);
  app.setFilter('all');
  check('all shows everything', list.children.length, 3);

  console.log('\n9) Moving a task');
  calls = [];
  app.moveBy(1, 1);
  await settle();
  check('a new order was saved', calls[0], 'PUT /api/todos/order {"ids":[2,1,3]}');
  check('the order changed', app.getTodos().map((t) => t.id), [2, 1, 3]);

  console.log('\n10) Delete and Undo');
  calls = [];
  await app.deleteTodo(1);
  check('DELETE was sent', calls[0], 'DELETE /api/todos/1');
  check('the row is gone from the list', app.getTodos().length, 2);
  check('the undo bar is showing', elements.toast.hidden, false);
  check('the bar names the task', elements['toast-message'].textContent, 'Deleted "Buy milk"');

  await app.undoDelete();
  // Step 9 moved task 1 down, so it has to come back in that same slot - which
  // is where it already is, so the order is unchanged.
  check('the task is back', app.getTodos().map((t) => t.title), ['Walk the dog', 'Buy milk', 'Pay the rent']);
  check('its note came back too', app.getTodos()[1].note, 'Two bottles');
  check('it comes back finished, as it was', app.getTodos()[1].completed, true);
  check('the undo bar is hidden again', elements.toast.hidden, true);

  console.log('\n11) Clear done, then undo');
  await app.clearCompleted();
  check('both finished tasks are removed', app.getTodos().map((t) => t.id), [3]);
  check('the bar explains what happened', elements['toast-message'].textContent, 'Deleted 2 finished tasks');
  await app.undoDelete();
  check('both tasks come back', app.getTodos().map((t) => t.title), ['Walk the dog', 'Buy milk', 'Pay the rent']);
  check('and they are finished again', app.getTodos().filter((t) => t.completed).length, 2);
  check('no task is listed twice', new Set(app.getTodos().map((t) => t.id)).size, 3);

  console.log('\n12) When the server has a problem');
  const target = app.getTodos().find((todo) => todo.completed);
  failNextRequest = true;
  await app.toggleTodo(target.id, false);
  check('the tick is undone for the user', app.getTodos().find((t) => t.id === target.id).completed, true);
  check('an error message is shown', elements.status.classList.contains('is-error'), true);

  console.log('\n13) Empty list');
  app.setTodos([]);
  check('the empty message shows', elements['empty-state'].hidden, false);
  check('message text', elements['empty-state'].textContent, 'Your list is empty - add your first task above.');
  check('counter text', elements.counts.textContent, 'Nothing on the list yet');
  check('clear-done is disabled', elements['clear-completed'].disabled, true);

  console.log(`\n${failed === 0 ? 'ALL FRONTEND TESTS PASSED' : failed + ' FRONTEND TEST(S) FAILED'} (${passed} passed)\n`);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((error) => {
  console.error('\nThe frontend test run crashed:', error);
  process.exit(1);
});
