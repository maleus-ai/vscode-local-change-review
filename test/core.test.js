const fs = require('fs'); const os = require('os'); const path = require('path');
const { execFileSync } = require('child_process');
const { ReviewFiles } = require(__dirname + '/../out/core/files.js');
const ops = require(__dirname + '/../out/core/operations.js');
const SP = __dirname;

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${extra ? ' — ' + extra : ''}`); };

// 0. summaryLine: fenced blocks are skipped, inline backticks are not fences
const { summaryLine } = require(__dirname + '/../out/core/format.js');
check('an inline ``` does not eat the line',
  summaryLine('The `foo` helper and the ```ts block below disagree.') === 'The foo helper and the ```ts block below disagree.',
  JSON.stringify(summaryLine('The `foo` helper and the ```ts block below disagree.')));
check('an inline ``` mid-sentence keeps what follows',
  summaryLine('Use ``` to fence code here, not indentation.') === 'Use ``` to fence code here, not indentation.',
  JSON.stringify(summaryLine('Use ``` to fence code here, not indentation.')));
check('a body opening with a fence labels from its prose',
  summaryLine('```ts\nconst a = 1;\n```\nThe real point.') === 'The real point.',
  JSON.stringify(summaryLine('```ts\nconst a = 1;\n```\nThe real point.')));
check('an unclosed fence hides the code after it',
  summaryLine('```\nconst a = 1;') === '', JSON.stringify(summaryLine('```\nconst a = 1;')));
check('a ~~~ fence is skipped too',
  summaryLine('~~~\ncode\n~~~\nProse.') === 'Prose.', JSON.stringify(summaryLine('~~~\ncode\n~~~\nProse.')));
check('a longer closing fence still closes',
  summaryLine('```\ncode\n`````\nProse.') === 'Prose.', JSON.stringify(summaryLine('```\ncode\n`````\nProse.')));

// normalizeSession must quarantine anything it cannot keep as written — not
// only entries it had to drop. Coercing a value silently destroys just as much.
const { normalizeSession } = require(__dirname + '/../out/core/files.js');
const lossy = {
  'an unrecognised session status': { status: 'archived', threads: [] },
  'an unrecognised thread status': { threads: [{ path: 'a', status: 'needs-work', comments: [] }] },
  'a non-boolean outdated': { threads: [{ path: 'a', outdated: 'yes', comments: [] }] },
  'comments written as an object': { threads: [{ path: 'a', comments: { c1: { body: 'hi' } } }] },
  'a snippet written as a string': { threads: [{ path: 'a', snippet: 'x', comments: [] }] },
  'a non-numeric startLine': { threads: [{ path: 'a', startLine: 'abc', comments: [] }] },
  'a non-boolean agent flag': { threads: [{ path: 'a', comments: [{ body: 'hi', agent: 'yes' }] }] },
  'threads written as an object': { threads: { t1: { path: 'a' } } },
};
check('a clean session is writable', normalizeSession({ threads: [] }, 'f').lossless === true);
for (const [name, raw] of Object.entries(lossy)) {
  check(`quarantines ${name}`, normalizeSession(raw, 'f').lossless === false);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-core-'));
const files = new ReviewFiles(root);

// 1. create + persist
const session = files.transaction((s) => ops.createSession(s, 'Test Session', { branch: 'main', sha: 'abc123' })).result;
check('session file written', fs.existsSync(files.sessionPath(session.id)));
check('index points at it', JSON.parse(fs.readFileSync(files.indexPath, 'utf8')).activeSessionId === session.id);

// 2. thread + comment round-trips through disk
const thread = files.transaction((s) => ops.addThread(s, session.id, {
  path: 'README.md', startLine: 10, endLine: 12, snippet: ['a', 'b', 'c'],
  languageId: 'markdown', author: 'Shiranuit', agent: false, body: 'Original note',
})).result;
files.transaction((s) => ops.addComment(s, thread.id, 'claude', 'Fixed it', true));
const provenance = ops.findThread(files.read(), thread.id).thread.comments;
check('agent flag round-trips through disk', provenance[0].agent === false && provenance[1].agent === true,
  JSON.stringify(provenance.map((c) => [c.author, c.agent])));
// A comment written before the flag existed stays unknown rather than becoming false.
const legacyFile = files.sessionPath(session.id);
const raw = JSON.parse(fs.readFileSync(legacyFile, 'utf8'));
delete raw.threads[0].comments[0].agent;
fs.writeFileSync(legacyFile, JSON.stringify(raw, null, 2));
check('a pre-flag comment is left unknown, not false',
  ops.findThread(new ReviewFiles(root).read(), thread.id).thread.comments[0].agent === undefined);
const onDisk = new ReviewFiles(root).read();
check('reads back from a fresh handle', ops.findThread(onDisk, thread.id)?.thread.comments.length === 2);

// 3. THE regression this refactor exists for: a stale in-memory snapshot
//    must not erase a concurrent writer's work.
const stale = files.read();                                   // editor's cached view
execFileSync(process.execPath, ['-e', `
  const { ReviewFiles } = require('${__dirname + '/../out/core/files.js'}');
  const ops = require('${__dirname + '/../out/core/operations.js'}');
  new ReviewFiles(${JSON.stringify(root)}).transaction(s => ops.addComment(s, ${JSON.stringify(thread.id)}, 'claude', 'written while editor held stale state'));
`]);
// the editor now mutates, holding state from BEFORE the external write
files.transaction((s) => ops.addComment(s, thread.id, 'Shiranuit', 'editor reply', false));
const after = new ReviewFiles(root).read();
const bodies = ops.findThread(after, thread.id).thread.comments.map((c) => c.body);
check('external write survives an editor write', bodies.includes('written while editor held stale state'), bodies.join(' | '));
check('editor write also landed', bodies.includes('editor reply'));
check('stale snapshot was not used', stale.sessions.get(session.id).threads[0].comments.length === 2);

// 4. concurrent processes
const before = ops.findThread(files.read(), thread.id) ? files.read().sessions.get(session.id).threads.length : 0;
const procs = ['a', 'b', 'c'].map((tag) =>
  require('child_process').spawn(process.execPath, [path.join(SP, 'core.worker.js'), root, session.id, tag, '60'], { stdio: 'inherit' }));
Promise.all(procs.map((p) => new Promise((r) => p.on('close', r)))).then(() => {
  const final = new ReviewFiles(root).read().sessions.get(session.id);
  check('3 writers x 60 threads, none lost', final.threads.length === before + 180, `expected ${before + 180}, got ${final.threads.length}`);
  check('file is still valid JSON', (() => { try { JSON.parse(fs.readFileSync(files.sessionPath(session.id), 'utf8')); return true; } catch { return false; } })());
  check('no lock left behind', !fs.existsSync(files.lockPath));
  check('no temp files left behind', fs.readdirSync(path.join(root, 'sessions')).every((f) => f.endsWith('.json')));

  // 5. a transaction writes everything or nothing
  {
    const r2 = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-atomic-'));
    fs.mkdirSync(path.join(r2, 'sessions'), { recursive: true });
    const mk = (id, name, extra = {}) => JSON.stringify({ version: 1, id, name, status: 'open',
      createdAt: '2020-01-01T00:00:00.000Z', threads: [], ...extra });
    fs.writeFileSync(path.join(r2, 'sessions', 'aaa.json'), mk('aaa', 'A'));
    fs.writeFileSync(path.join(r2, 'sessions', 'zzz.json'), mk('zzz', 'Z', { status: 'archived' }));
    const store2 = new ReviewFiles(r2);
    let threw = false;
    try { store2.transaction((s) => { for (const x of s.sessions.values()) x.name += '!'; }); }
    catch { threw = true; }
    check('a read-only session aborts the whole transaction', threw);
    check('and the healthy session it would have written is untouched',
      JSON.parse(fs.readFileSync(path.join(r2, 'sessions', 'aaa.json'), 'utf8')).name === 'A');

    // deleting a duplicate id would unlink the copy we loaded and resurrect the other
    fs.writeFileSync(path.join(r2, 'sessions', 'dup.json'), mk('dup', 'original'));
    fs.writeFileSync(path.join(r2, 'sessions', 'dup-copy.json'), mk('dup', 'the copy'));
    let refused = false;
    try { new ReviewFiles(r2).transaction((s) => { s.sessions.delete('dup'); }); }
    catch { refused = true; }
    check('deleting a session two files claim is refused', refused);
    check('and both files are still there',
      fs.existsSync(path.join(r2, 'sessions', 'dup.json')) && fs.existsSync(path.join(r2, 'sessions', 'dup-copy.json')));

    // but a merely unrepresentable session can still be deleted outright
    let deleted = true;
    try { new ReviewFiles(r2).transaction((s) => { s.sessions.delete('zzz'); }); }
    catch { deleted = false; }
    check('deleting an unrepresentable session is allowed', deleted && !fs.existsSync(path.join(r2, 'sessions', 'zzz.json')));
    fs.rmSync(r2, { recursive: true, force: true });
  }

  // 6. malformed file is left alone, not overwritten
  const bad = path.join(root, 'sessions', 'broken.json');
  fs.writeFileSync(bad, '{ this is not json');
  files.transaction((s) => ops.addComment(s, thread.id, 'x', 'y', false));
  check('malformed session left untouched', fs.readFileSync(bad, 'utf8') === '{ this is not json');

  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});
