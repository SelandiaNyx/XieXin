const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = name => fs.readFileSync(path.join(__dirname, '../ui/js', name), 'utf8');
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const element = () => ({ value: '', style: {}, dataset: {}, readOnly: false, disabled: false,
  classList: { add() {}, remove() {} }, selectionStart: 0, selectionEnd: 0, scrollHeight: 100,
  focus() {}, setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; },
});

function harness() {
  const inserts = [];
  const api = {};
  const ctx = vm.createContext({ api, console, toast() {}, formatTime: () => '2026-09-29 12:00',
    animateNumber() {}, localStorage: { getItem: () => null, setItem() {} },
    document: { querySelector: () => null, getElementById: () => null, createElement: element,
      execCommand: (_a, _b, text) => { inserts.push(text); return true; } },
    window: { innerHeight: 900 },
  });
  const store = vm.runInContext(`(() => { ${source('store.js').replace(/^export /gm, '')}; return { state, setState, emit, findChapter, bookCharCount, statusInfo }; })()`, ctx);
  Object.assign(ctx, store);
  const code = source('editor.js').replace(/^import .*;\r?$/gm, '').replace(/^export \{.*\};?\r?$/gm, '').replace(/^export /gm, '');
  const editor = vm.runInContext(`(() => { ${code}; return { els, saveChapter, openChapter, openBookInEditor, flushPendingSave, markDirty, countLocal, onKeyDown, restoreChapterVersion, withEditorTransition, deleteFromBook }; })()`, ctx);
  for (const key of ['view', 'titleBig', 'titleTop', 'statusSelect', 'saveState', 'versionInfo', 'wcChapter', 'wcTotal', 'wcToday', 'page', 'crumbVolume', 'cursorInfo', 'selectionInfo']) editor.els[key] = element();
  const state = store.state;
  state.book = { id: 'book', volumes: [{ id: 'v', title: '卷', chapters: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }] }] };
  state.activeChapterId = 'a'; state.content = 'original';
  editor.els.view.value = 'original'; editor.els.titleBig.value = 'A'; editor.els.statusSelect.value = 'draft';
  api.saveChapter = async payload => ({ updatedAt: 1, charCount: editor.countLocal(payload.content), versions: 1 });
  api.readChapter = async (_book, id) => ({ content: `chapter ${id}`, createdAt: 1 });
  api.listVersions = async () => [];
  const type = text => { editor.els.view.value = text; state.content = text; editor.markDirty(); };
  return { editor, api, state, inserts, type, store };
}

test('typing while a save is in flight stays dirty and is saved on next flush', async () => {
  const h = harness(), pending = deferred(), saved = [];
  h.api.saveChapter = async payload => { saved.push(payload.content); if (saved.length === 1) await pending.promise; return { updatedAt: 1, versions: 1, charCount: 1 }; };
  h.type('first draft'); const saving = h.editor.saveChapter({ silent: true });
  await Promise.resolve(); await Promise.resolve();
  h.type('first draft plus new typing'); pending.resolve(); await saving;
  assert.equal(h.state.dirty, true);
  assert.equal(h.state.content, 'first draft plus new typing');
  await h.editor.flushPendingSave();
  assert.deepEqual(saved, ['first draft', 'first draft plus new typing']);
  assert.equal(h.state.dirty, false);
});

test('failed save prevents chapter navigation and leaves the draft editable', async () => {
  const h = harness(); let reads = 0;
  h.type('unsaved manuscript');
  h.api.saveChapter = async () => { throw new Error('disk full'); };
  h.api.readChapter = async () => { reads++; };
  assert.equal(await h.editor.openChapter('b'), false);
  assert.equal(reads, 0); assert.equal(h.state.activeChapterId, 'a');
  assert.equal(h.editor.els.view.value, 'unsaved manuscript');
  assert.equal(h.state.dirty, true); assert.equal(h.editor.els.view.readOnly, false);
});

test('corrupt destination chapter leaves the current chapter and book intact', async () => {
  const h = harness(); const originalBook = h.state.book;
  h.api.openBook = async () => ({ book: { id: 'other', volumes: [{ id: 'v2', chapters: [{ id: 'c' }] }] }, cards: [] });
  h.api.readChapter = async () => { throw new Error('corrupt JSON'); };
  assert.equal(await h.editor.openBookInEditor('other'), false);
  assert.equal(h.state.book, originalBook); assert.equal(h.state.activeChapterId, 'a');
  assert.equal(h.editor.els.view.value, 'original');
});

test('concurrent chapter requests do not mix content and chapter identity', async () => {
  const h = harness(), pending = deferred();
  h.api.readChapter = async () => { await pending.promise; return { content: 'chapter B' }; };
  const first = h.editor.openChapter('b'); await Promise.resolve();
  assert.equal(h.editor.els.view.readOnly, true);
  assert.equal(await h.editor.openBookInEditor('another'), false);
  pending.resolve(); assert.equal(await first, true);
  assert.equal(h.state.activeChapterId, 'b'); assert.equal(h.editor.els.view.value, 'chapter B');
});

test('queued saves retain each captured payload and never overlap', async () => {
  const h = harness(), pending = deferred(); const saved = []; let active = 0, maximum = 0;
  h.api.saveChapter = async payload => { active++; maximum = Math.max(maximum, active); saved.push(payload.content); if (saved.length === 1) await pending.promise; active--; return { updatedAt: 1, versions: 0, charCount: 1 }; };
  h.type('one'); const a = h.editor.saveChapter({ silent: true });
  h.type('two'); const b = h.editor.saveChapter({ silent: true });
  h.type('three'); const c = h.editor.saveChapter({ silent: true });
  pending.resolve(); await Promise.all([a, b, c]);
  assert.deepEqual(saved, ['one', 'two', 'three']); assert.equal(maximum, 1);
  assert.equal(h.state.dirty, false); assert.equal(h.state.saving, false);
});

test('title or status edits during save remain dirty', async () => {
  const h = harness(), pending = deferred();
  h.api.saveChapter = () => pending.promise;
  const saving = h.editor.saveChapter({ silent: true });
  h.editor.els.titleBig.value = 'renamed'; h.editor.markDirty();
  pending.resolve({ updatedAt: 1, versions: 0, charCount: 1 }); await saving;
  assert.equal(h.state.dirty, true); assert.equal(h.editor.els.titleBig.value, 'renamed');
});

test('close barrier does not close after a failed save', async () => {
  const h = harness(); let closed = false;
  h.type('last sentence'); h.api.saveChapter = async () => { throw new Error('locked'); };
  await h.editor.withEditorTransition(async () => { closed = true; });
  assert.equal(closed, false); assert.equal(h.state.dirty, true);
  assert.equal(h.state.transitioning, false);
});

test('deleting the active chapter saves its draft before deletion and opens the next chapter', async () => {
  const h = harness(); const calls = [];
  h.type('draft before deletion');
  h.api.saveChapter = async p => { calls.push(['save', p.chapterId, p.content]); return { updatedAt: 1, versions: 1, charCount: 3 }; };
  const result = await h.editor.deleteFromBook(async () => {
    calls.push(['delete', 'a']);
    return { id: 'book', volumes: [{ id: 'v', title: '卷', chapters: [{ id: 'b', title: 'B' }] }] };
  });
  assert.equal(result, true);
  assert.deepEqual(calls, [['save', 'a', 'draft before deletion'], ['delete', 'a']]);
  assert.equal(h.state.activeChapterId, 'b'); assert.equal(h.editor.els.view.value, 'chapter b');
  assert.equal(h.state.dirty, false);
});

test('deletion is blocked when the current manuscript cannot be saved', async () => {
  const h = harness(); let deleted = false;
  h.type('keep this draft'); h.api.saveChapter = async () => { throw new Error('disk full'); };
  assert.equal(await h.editor.deleteFromBook(async () => { deleted = true; }), false);
  assert.equal(deleted, false); assert.equal(h.editor.els.view.value, 'keep this draft');
  assert.equal(h.state.activeChapterId, 'a'); assert.equal(h.state.dirty, true);
});

test('restoring the active chapter saves edits first and displays restored content', async () => {
  const h = harness(); const calls = [];
  h.type('current unsaved');
  h.api.saveChapter = async p => { calls.push(['save', p.content]); return { updatedAt: 1, versions: 2, charCount: 2 }; };
  h.api.restoreVersion = async () => { calls.push(['restore']); };
  h.api.openBook = async () => ({ book: h.state.book, cards: [] });
  h.api.readChapter = async () => ({ content: 'restored draft' });
  assert.equal(await h.editor.restoreChapterVersion('book', 'a', 'version'), true);
  assert.deepEqual(calls, [['save', 'current unsaved'], ['restore']]);
  assert.equal(h.editor.els.view.value, 'restored draft'); assert.equal(h.state.dirty, false);
});

test('local counts match the Rust grouping contract', () => {
  const { editor } = harness();
  for (const [text, expected] of [['hello', 1], ['123', 1], ['hello 世界', 3], ['abc123', 1], ['你好，world！123', 4], ['éclair café', 2], ['𠀀😀', 1], ['', 0]]) assert.equal(editor.countLocal(text), expected, text);
});

test('brackets and quotes insert complete pairs and do not intercept IME composition', () => {
  const h = harness();
  for (const [key, expected] of [['(', '（）'], ['（', '（）'], ['「', '「」'], ['《', '《》'], ['【', '【】'], ['"', '“”'], ["'", '‘’']]) {
    h.editor.onKeyDown({ key, preventDefault() {} }); assert.equal(h.inserts.at(-1), expected);
  }
  const n = h.inserts.length;
  h.editor.onKeyDown({ key: '(', isComposing: true, preventDefault() { throw new Error('IME intercepted'); } });
  assert.equal(h.inserts.length, n);
});

test('chapter metadata updates affect the real store object', async () => {
  const h = harness(); h.type('你好 world'); await h.editor.saveChapter({ silent: true });
  assert.equal(h.state.book.volumes[0].chapters[0].charCount, 3);
});

test('confirmation accepts OK and closing an old modal cannot remove its replacement', async () => {
  const nodes = new Map(); const timers = [];
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { hidden: false, style: {}, classList: { add() {}, remove() {} }, querySelector: key => key.startsWith('[data-role') ? node(key) : null, addEventListener() {} });
    return nodes.get(id);
  };
  const ctx = vm.createContext({ document: { getElementById: node }, window: { matchMedia: () => ({ matches: false }) }, setTimeout: f => timers.push(f) });
  const ui = vm.runInContext(`(() => { ${source('ui.js').replace(/^export /gm, '')}; return { confirmDialog, openModal }; })()`, ctx);
  const accepted = ui.confirmDialog('确认', '继续');
  node('[data-role="ok"]').onclick();
  assert.equal(await accepted, true);
  ui.openModal({ title: '下一步', body: 'new modal' });
  timers.forEach(f => f());
  assert.equal(node('overlay').hidden, false); assert.equal(node('modalBody').innerHTML, 'new modal');
});
