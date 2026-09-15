const path = require('path');
const Module = require('module');

const ROOT = path.resolve('/tmp/lr-watch-root');
const created = [];   // one entry per createFileSystemWatcher call

const vscodeStub = {
  Uri: {
    file: (p) => ({ scheme: 'file', fsPath: p, toString: () => `file://${p}` }),
    joinPath: (base, ...parts) => vscodeStub.Uri.file(path.join(base.fsPath, ...parts)),
  },
  RelativePattern: class {
    constructor(base, pattern) { this.base = base; this.pattern = pattern; }
  },
  workspace: {
    workspaceFolders: [{ uri: { scheme: 'file', fsPath: ROOT, toString: () => `file://${ROOT}` } }],
    getConfiguration: () => ({ get: (_k, d) => d }),
    createFileSystemWatcher: (pattern) => {
      const handlers = [];
      const watcher = {
        pattern, disposed: false,
        onDidChange: (h) => handlers.push(h),
        onDidCreate: (h) => handlers.push(h),
        onDidDelete: (h) => handlers.push(h),
        dispose() { this.disposed = true; },
        fire: (uri) => handlers.forEach((h) => h(uri)),
      };
      created.push(watcher);
      return watcher;
    },
  },
};

const original = Module._load;
Module._load = function (request, ...rest) {
  return request === 'vscode' ? vscodeStub : original.call(this, request, ...rest);
};
const { SourceWatcher } = require(__dirname + '/../out/sourcewatch.js');

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? '  ok  ' : ' FAIL '} ${n}${e ? ' — ' + e : ''}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const abs = (rel) => vscodeStub.Uri.file(path.join(ROOT, ...rel.split('/')));
/** The live (undisposed) watchers, since `update` replaces rather than mutates. */
const live = () => created.filter((w) => !w.disposed);

(async () => {
  const seen = [];
  const watcher = new SourceWatcher((p) => seen.push(p));

  watcher.update(['src/a.ts', 'src/b.ts', 'lib/c.ts']);
  check('one watcher per directory, not per file', live().length === 2, `${live().length} watchers`);
  check('watching is on', watcher.watching === true);

  // debounce: a burst of writes is one re-anchor
  const src = live().find((w) => w.pattern.base.fsPath.endsWith('src'));
  src.fire(abs('src/a.ts'));
  src.fire(abs('src/a.ts'));
  src.fire(abs('src/a.ts'));
  check('nothing fires before the debounce', seen.length === 0);
  await wait(450);
  check('a burst of writes re-anchors once', seen.length === 1 && seen[0] === 'src/a.ts', JSON.stringify(seen));

  // a neighbour in a watched directory is not our business
  src.fire(abs('src/unrelated.ts'));
  await wait(450);
  check('a file with no threads is ignored', seen.length === 1, JSON.stringify(seen));

  // two different files debounce independently
  seen.length = 0;
  src.fire(abs('src/a.ts'));
  src.fire(abs('src/b.ts'));
  await wait(450);
  check('each file gets its own re-anchor', seen.sort().join(',') === 'src/a.ts,src/b.ts', JSON.stringify(seen));

  // rebuilding only when the directories change
  const before = created.length;
  watcher.update(['src/a.ts', 'src/b.ts', 'src/d.ts', 'lib/c.ts']);
  check('adding a file in a watched directory builds no new watchers', created.length === before);
  watcher.update(['src/a.ts', 'deep/nested/e.ts']);
  check('a new directory rebuilds them', created.length > before && live().length === 2,
    `${created.length - before} created, ${live().length} live`);
  check('the replaced watchers are disposed',
    created.slice(0, before).every((w) => w.disposed));

  // a path that no longer has threads stops being watched
  seen.length = 0;
  const deep = live().find((w) => w.pattern.base.fsPath.includes('nested'));
  deep.fire(abs('deep/nested/e.ts'));
  await wait(450);
  check('a watched file still fires after a rebuild', seen.join(',') === 'deep/nested/e.ts', JSON.stringify(seen));

  // too broad to watch: the caller falls back to its sweep
  watcher.update(Array.from({ length: 65 }, (_, i) => `d${i}/f.ts`));
  check('a review spread too wide switches watching off', watcher.watching === false);
  check('and holds no watchers open', live().length === 0, `${live().length} live`);

  watcher.dispose();
  check('dispose closes everything', live().length === 0);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
