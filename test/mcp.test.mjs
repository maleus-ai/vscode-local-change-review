import fs from 'fs'; import os from 'os'; import path from 'path';
import { fileURLToPath } from 'url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? '  ok  ' : ' FAIL '} ${n}${e ? ' — ' + e : ''}`); };
const J = (r) => { try { return JSON.parse(r.content[0].text); } catch { return r.content[0].text; } };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-mcp-'));
fs.mkdirSync(path.join(root, 'src'));
const SRC = path.join(root, 'src', 'billing.ts');
fs.writeFileSync(SRC, `import { Repo } from './repo';

export class BillingService {
  constructor(private readonly repo: Repo) {}

  price(run: Run) {
    return this.repo.write(run);
  }
}
`);

const client = new Client({ name: 'test', version: '1' });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [path.join(HERE, '..', 'out', 'mcp', 'server.js'), '--root', root],
}));

const tools = (await client.listTools()).tools.map((t) => t.name).sort();
check('tools advertised', tools.length === 9, tools.join(', '));

check('no sessions yet', J(await client.callTool({ name: 'list_sessions', arguments: {} })).sessions.length === 0);
const session = J(await client.callTool({ name: 'create_session', arguments: { name: 'Round 1' } }));
check('session created + active', session.name === 'Round 1');
check('the first session becomes active',
  J(await client.callTool({ name: 'list_sessions', arguments: {} })).activeSessionId === session.id);

// An agent starting a second session must not redirect where the reviewer's own
// next comment lands.
const second = J(await client.callTool({ name: 'create_session', arguments: { name: 'Agent findings' } }));
check('a second session does not steal the active one',
  J(await client.callTool({ name: 'list_sessions', arguments: {} })).activeSessionId === session.id);
check('but can still be targeted by id',
  J(await client.callTool({ name: 'list_threads', arguments: { sessionId: second.id, status: 'all' } })).session.name === 'Agent findings');

const created = J(await client.callTool({ name: 'create_thread', arguments: {
  file: 'src/billing.ts', startLine: 3, endLine: 4, body: 'This writes through the repo, not the service.' } }));
check('thread created', created.file === 'src/billing.ts' && created.startLine === 3, JSON.stringify(created.threadId));

await client.callTool({ name: 'add_comment', arguments: { threadId: created.threadId, body: 'Second thought.' } });
const listed = J(await client.callTool({ name: 'list_threads', arguments: {} }));
check('thread listed with both comments', listed.threads[0].comments.length === 2);
check('filter by file works', J(await client.callTool({ name: 'list_threads', arguments: { file: 'src/nope.ts' } })).threads.length === 0);

// --- re-anchoring: insert 4 lines above the commented code
fs.writeFileSync(SRC, `// a\n// b\n// c\n// d\n` + fs.readFileSync(SRC, 'utf8'));
const moved = J(await client.callTool({ name: 'list_threads', arguments: {} }));
check('line numbers follow the code', moved.threads[0].startLine === 7, `now ${moved.threads[0].startLine}`);
check('not marked outdated', moved.threads[0].outdated === false);

// --- ownership: a human-authored thread cannot be resolved through MCP
const { ReviewFiles } = await import('../out/core/files.js');
const ops = await import('../out/core/operations.js');
const files = new ReviewFiles(path.join(root, '.local-review'));
const human = files.transaction((s) => ops.addThread(s, session.id, {
  path: 'src/billing.ts', startLine: 1, endLine: 1, snippet: ["import { Repo } from './repo';"],
  languageId: 'ts', author: 'Shiranuit', agent: false, body: 'Human review comment' })).result;

files.transaction((s) => ops.setThreadStatus(s, human.id, 'resolved'));
const refused = await client.callTool({ name: 'resolve_thread', arguments: { threadId: human.id } });
check("refuses to resolve someone else's thread", refused.isError === true);
check('refusal explains why', /opened by "Shiranuit"/.test(refused.content[0].text), refused.content[0].text.slice(0, 80));
const allowed = J(await client.callTool({ name: 'resolve_thread', arguments: { threadId: created.threadId } }));
check('resolves its own thread', allowed.status === 'resolved');

// --- outdated when the code is gone
fs.writeFileSync(SRC, `export class Something Else {}\n`);
const gone = J(await client.callTool({ name: 'list_threads', arguments: { status: 'all' } }));
check('marks open threads outdated when the code vanishes',
  gone.threads.filter((t) => t.status === 'open').every((t) => t.outdated === true));
check('resolved threads are never marked outdated',
  gone.threads.filter((t) => t.status === 'resolved').every((t) => t.outdated === false));

// --- agent provenance
const provenance = J(await client.callTool({ name: 'list_threads', arguments: { status: 'all' } }));
const mcpThread = provenance.threads.find((t) => t.threadId === created.threadId);
const humanThread = provenance.threads.find((t) => t.threadId === human.id);
check('MCP-written comments are flagged agent', mcpThread.comments.every((c) => c.agent === true));
check('editor-written threads are not', humanThread.comments[0].agent === false);
const agentOnly = J(await client.callTool({ name: 'list_threads', arguments: { status: 'all', agent: true } }));
check('agent:true filter', agentOnly.threads.length === 1 && agentOnly.threads[0].threadId === created.threadId);
const humanOnly = J(await client.callTool({ name: 'list_threads', arguments: { status: 'all', agent: false } }));
check('agent:false filter', humanOnly.threads.length === 1 && humanOnly.threads[0].threadId === human.id);

// --- new filters
const byAuthor = J(await client.callTool({ name: 'list_threads', arguments: { status: 'all', author: 'Shiranuit' } }));
check('author filter', byAuthor.threads.length === 1 && byAuthor.threads[0].author === 'Shiranuit', `${byAuthor.threads.length} thread(s)`);
const waiting = J(await client.callTool({ name: 'list_threads', arguments: { status: 'all', needsReply: true } }));
check('needsReply finds threads awaiting me', waiting.threads.every((t) => t.comments.at(-1).author !== 'claude') && waiting.threads.length === 1, `${waiting.threads.length} thread(s)`);
const small = J(await client.callTool({ name: 'list_threads', arguments: { status: 'all', compact: true } }));
check('compact returns a summary, not bodies', typeof small.threads[0].comments === 'number' && typeof small.threads[0].summary === 'string', JSON.stringify(small.threads[0]));
// Realistic review prose, which is what the saving is actually for.
await client.callTool({ name: 'add_comment', arguments: { threadId: created.threadId,
  body: 'This writes through the repository rather than the service, so the consumption_type column mapping ends up in the hands of this caller instead of the schema.\n\n'.repeat(6) } });
const fullAfter = JSON.stringify(J(await client.callTool({ name: 'list_threads', arguments: { status: 'all' } })));
const compactAfter = JSON.stringify(J(await client.callTool({ name: 'list_threads', arguments: { status: 'all', compact: true } })));
check('compact is smaller, and much smaller with real prose',
  compactAfter.length < fullAfter.length,
  `${compactAfter.length} vs ${fullAfter.length} bytes (${(fullAfter.length / compactAfter.length).toFixed(1)}x)`);

const md = (await client.callTool({ name: 'export_markdown', arguments: { includeResolved: true } })).content[0].text;
check('markdown export renders', md.startsWith('# Local review — Round 1') && md.includes('Human review comment'));

// --- the extension reads the very same files
const onDisk = new ReviewFiles(path.join(root, '.local-review')).read();
check('extension store reads the same data', onDisk.sessions.get(session.id).threads.length === 2);

// --- reopening: allowed on anyone's thread, but never without saying why
await client.callTool({ name: 'resolve_thread', arguments: { threadId: created.threadId } });
const noReason = await client.callTool({ name: 'unresolve_thread', arguments: { threadId: human.id } });
check('reopening without a comment is refused', noReason.isError === true);
const reopened = J(await client.callTool({ name: 'unresolve_thread',
  arguments: { threadId: human.id, comment: 'Still reachable through the repo on line 42.' } }));
check('reopening someone else\'s thread is allowed with a comment', reopened.status === 'open');
check('and the reason is posted to the thread',
  reopened.comments.at(-1).body.startsWith('Still reachable') && reopened.comments.at(-1).agent === true);
const again = await client.callTool({ name: 'unresolve_thread', arguments: { threadId: human.id, comment: 'x' } });
check('reopening an already-open thread is refused', again.isError === true);
check('resolving someone else\'s thread is still refused',
  (await client.callTool({ name: 'resolve_thread', arguments: { threadId: human.id } })).isError === true);

// --- containment: a path outside the workspace is refused, never answered
//     with an empty result, which reads as a fact about the review instead
check('list_threads on an outside file is refused',
  (await client.callTool({ name: 'list_threads', arguments: { file: '/etc/passwd' } })).isError === true);
check('export_markdown on an outside file is refused',
  (await client.callTool({ name: 'export_markdown', arguments: { file: '/etc/passwd' } })).isError === true);
fs.writeFileSync(path.join(root, '..eslintrc.js'), 'module.exports = {};\n');
check('a dotfile whose name starts with two dots is inside the workspace',
  J(await client.callTool({ name: 'create_thread', arguments: {
    file: '..eslintrc.js', startLine: 1, endLine: 1, body: 'config lives here' } })).file === '..eslintrc.js');

// --- a thread anchored outside the workspace: unreachable is not "gone"
const outside = path.join(os.tmpdir(), `lr-shared-${process.pid}.ts`);
fs.writeFileSync(outside, 'export const shared = 1;\n');
{
  const store = new ReviewFiles(path.join(root, '.local-review'));
  store.transaction((state) => {
    const s = state.sessions.get(session.id);
    s.threads.push({ id: 't-outside', path: outside, startLine: 1, endLine: 1,
      snippet: ['export const shared = 1;'], status: 'open',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      comments: [{ id: 'c-outside', author: 'Shiranuit', body: 'shared with the other repo',
        createdAt: '2026-01-01T00:00:00.000Z' }] });
  });
}
const withOutside = J(await client.callTool({ name: 'list_threads', arguments: { status: 'all' } }))
  .threads.find((t) => t.threadId === 't-outside');
check('a thread the server may not read is not declared outdated', withOutside.outdated === false);
check('and unknown provenance is reported as null, not false',
  withOutside.comments[0].agent === null, JSON.stringify(withOutside.comments[0].agent));
check('nor is outdated written to disk',
  !JSON.stringify(new ReviewFiles(path.join(root, '.local-review')).read()
    .sessions.get(session.id).threads.find((t) => t.id === 't-outside')).includes('"outdated"'));

// --- one quarantined session must not lock the agent out of the whole review
fs.writeFileSync(path.join(root, '.local-review', 'sessions', 'broken.json'), JSON.stringify({
  version: 1, id: 's-broken', name: 'Broken', status: 'archived',
  createdAt: '2026-01-01T00:00:00.000Z', threads: [],
}));
const stillReads = await client.callTool({ name: 'list_threads', arguments: { sessionId: session.id, status: 'all' } });
check('a quarantined session does not break reads of a healthy one', stillReads.isError !== true,
  stillReads.isError ? stillReads.content[0].text.slice(0, 70) : '');

await client.close();
fs.rmSync(outside, { force: true });
fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
