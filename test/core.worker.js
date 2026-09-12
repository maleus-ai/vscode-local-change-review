const { ReviewFiles } = require(__dirname + '/../out/core/files.js');
const ops = require(__dirname + '/../out/core/operations.js');
const [root, sessionId, tag, n] = [process.argv[2], process.argv[3], process.argv[4], Number(process.argv[5])];
const files = new ReviewFiles(root);
for (let i = 0; i < n; i++) {
  files.transaction((state) => {
    const s = state.sessions.get(sessionId);
    ops.addThread(state, sessionId, {
      path: `src/${tag}-${i}.ts`, startLine: i + 1, endLine: i + 1,
      snippet: ['x'], languageId: 'typescript', author: tag, agent: false, body: `note ${i}`,
    });
  });
}
