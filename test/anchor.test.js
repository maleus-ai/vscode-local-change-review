const { locate, reanchorAll } = require(__dirname + '/../out/core/anchor.js');
let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? '  ok  ' : ' FAIL '} ${n}${e ? ' — ' + e : ''}`); };

const thread = (start, end, snippet) => ({
  id: 't', path: 'f.ts', startLine: start, endLine: end, snippet,
  status: 'open', createdAt: '', updatedAt: '', comments: [],
});
const L = (s) => s.split('\n');

const body = L(`import a from 'a';

export class Service {
  constructor(private readonly repo: Repo) {}

  run() {
    return this.repo.all();
  }
}`);

// unchanged file
let t = thread(3, 4, ['export class Service {', '  constructor(private readonly repo: Repo) {}']);
let a = locate(t, body);
check('unchanged stays put', a.startLine === 3 && a.endLine === 4 && !a.outdated, JSON.stringify(a));

// 5 lines inserted above
const shifted = L(`// header\n// header\n// header\n// header\n// header`).concat(body);
a = locate(t, shifted);
check('follows an insertion above', a.startLine === 8 && a.endLine === 9 && !a.outdated, JSON.stringify(a));

// lines removed above
a = locate(t, body.slice(2));
check('follows a deletion above', a.startLine === 1 && a.endLine === 2 && !a.outdated, JSON.stringify(a));

// reindented (whitespace-only change)
const reindented = body.map((l) => (l.startsWith('  ') ? '    ' + l.trim() : l));
a = locate(t, reindented);
check('survives reindentation', a.startLine === 3 && !a.outdated, JSON.stringify(a));

// code deleted entirely
a = locate(t, L(`something\nentirely\ndifferent`));
check('flags outdated when the code is gone', a.outdated === true, JSON.stringify(a));

// an outdated anchor must never point past the end of a now-shorter file
t = thread(4, 6, ['gone a', 'gone b', 'gone c']);
a = locate(t, ['only one line']);
check('outdated anchor clamped to a 1-line file', a.outdated && a.startLine === 1 && a.endLine === 1, JSON.stringify(a));
a = locate(t, ['a', 'b']);
check('outdated anchor clamped to a 2-line file', a.outdated && a.endLine === 2, JSON.stringify(a));

// duplicate matches: nearest to the old position wins
const dup = body.concat(body);
t = thread(12, 13, ['export class Service {', '  constructor(private readonly repo: Repo) {}']);
a = locate(t, dup);
check('picks the occurrence nearest the old position', a.startLine === 12, JSON.stringify(a));

// empty snippet (legacy data) is not falsely flagged
t = thread(2, 2, []);
a = locate(t, body);
check('empty snippet left alone', a.startLine === 2 && !a.outdated, JSON.stringify(a));
t = thread(99, 99, []);
check('empty snippet past EOF flagged', locate(t, body).outdated === true);

// reanchorAll over a state, incl. a missing file
const state = { index: {}, sessions: new Map([['s', { id: 's', threads: [
  thread(3, 4, ['export class Service {', '  constructor(private readonly repo: Repo) {}']),
  { ...thread(1, 1, ['gone']), id: 't2', path: 'missing.ts' },
] }]]) };
state.sessions.get('s').threads[0].startLine = 1;
const changed = reanchorAll(state, (p) => (p === 'f.ts' ? body : undefined));
const [t1, t2] = state.sessions.get('s').threads;
check('reanchorAll reports a change', changed === true);
check('reanchorAll fixes the line numbers', t1.startLine === 3 && t1.endLine === 4, `${t1.startLine}-${t1.endLine}`);
check('reanchorAll refreshes the snippet', t1.snippet[0] === 'export class Service {');
check('missing file marks the thread outdated', t2.outdated === true);
check('second pass is a no-op', reanchorAll(state, (p) => (p === 'f.ts' ? body : undefined)) === false);

// A resolved thread records that its code is gone — `resolved` supersedes
// `outdated` in what the labels SHOW, but the fact is what lets the widget
// explain why it is sitting on code it was never about.
const resolvedState = { index: {}, sessions: new Map([['s', { id: 's', threads: [
  { ...thread(1, 1, ['vanished code']), id: 'r1', status: 'resolved' },
  { ...thread(1, 1, ['vanished code']), id: 'r2', status: 'open' },
] }]]) };
reanchorAll(resolvedState, () => L('completely different content'));
const [res, open] = resolvedState.sessions.get('s').threads;
check('resolved thread records that its code is gone', res.outdated === true, JSON.stringify(res.outdated));
check('open thread still marked outdated', open.outdated === true);
reanchorAll(resolvedState, () => undefined);
check('resolved thread is flagged when the file is gone too',
  resolvedState.sessions.get('s').threads[0].outdated === true);

// the fast path must derive the end from the snippet, not trust a stale endLine
a = locate(thread(2, 2, ['export class Service {', '  constructor(private readonly repo: Repo) {}']), body);
check('exact match at the hint derives endLine from the snippet', a.startLine === 3 && a.endLine === 4, JSON.stringify(a));

// a snippet that is gone must never be re-captured from wherever the clamp landed
let st = { index: {}, sessions: new Map([['s', { id: 's', threads: [
  { ...thread(5, 7, ['old1', 'old2', 'old3']), id: 'r', status: 'resolved' },
  { ...thread(5, 7, ['old1', 'old2', 'old3']), id: 'o', status: 'open' },
] }]]) };
reanchorAll(st, () => L(['p', 'q', 'r'].join('\n')));
const [res2, open2] = st.sessions.get('s').threads;
check('a resolved thread keeps its position and its snippet, and says the code is gone',
  res2.startLine === 5 && res2.endLine === 7 && res2.snippet[0] === 'old1' && res2.outdated === true,
  JSON.stringify({ s: res2.startLine, e: res2.endLine, snip: res2.snippet, outdated: res2.outdated }));
check('open thread with vanished code keeps its snippet as the record',
  open2.outdated === true && open2.snippet[0] === 'old1', JSON.stringify(open2.snippet));

// a whitespace-only edit must refresh the stored snippet
st = { index: {}, sessions: new Map([['s', { id: 's', threads: [thread(1, 2, ['  a();', '  b();'])] }]]) };
check('whitespace-only change refreshes the snippet',
  reanchorAll(st, () => L('    a();\n    b();')) === true &&
  st.sessions.get('s').threads[0].snippet[0] === '    a();');


// Distance must dominate exactness. A reindented block used to lose to any
// surviving exact copy of its old text, however far away — defeating the loose
// pass in exactly the case it exists for.
{
  const block = ['function f() {', '  return 1;', '}'];
  const lines = Array.from({ length: 49 }, (_, i) => `filler ${i}`);
  block.forEach((l, i) => { lines[3 + i] = '  ' + l; });   // reindented, where the thread is
  block.forEach((l, i) => { lines[46 + i] = l; });          // an untouched exact copy, far away
  const got = locate({ startLine: 4, endLine: 6, snippet: block.slice() }, lines);
  check('a reindented block beats a distant exact duplicate',
    got.startLine === 4 && got.endLine === 6 && got.outdated === false, JSON.stringify(got));
}

// An empty snippet is never filled in from whatever now sits at its stale line
// numbers: locate did not search for anything, so those numbers prove nothing.
{
  const state = { sessions: new Map([['s', { threads: [
    { path: 'a', startLine: 2, endLine: 3, snippet: [], status: 'open', comments: [] },
  ] }]]) };
  const changed = reanchorAll(state, () => ['aaa', 'bbb', 'ccc', 'ddd']);
  const t = state.sessions.get('s').threads[0];
  check('an empty snippet is not invented from the current file',
    t.snippet.length === 0 && changed === false, JSON.stringify(t.snippet));
}

// A reader that may not look at a file says nothing about whether it exists.
{
  const state = { sessions: new Map([['s', { threads: [
    { path: '/elsewhere/shared.ts', startLine: 1, endLine: 1, snippet: ['x'], status: 'open', comments: [] },
  ] }]]) };
  const changed = reanchorAll(state, () => null);
  const t = state.sessions.get('s').threads[0];
  check('an unreachable file is not reported as gone', t.outdated === undefined && changed === false,
    JSON.stringify(t.outdated));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
