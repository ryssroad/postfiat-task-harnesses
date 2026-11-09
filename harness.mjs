import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const commit = '36380287ed3b15d115b55f546617d723072b1296';
const timeout = 5_000;
if (process.argv.length !== 3) throw new Error('Usage: node harness.mjs /path/to/servers');
const repo = await fs.realpath(process.argv[2]);
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
assert.equal(git('rev-parse', 'HEAD'), commit);
assert.equal(git('status', '--porcelain', '--untracked-files=no'), '');
const workspace = path.join(repo, 'src/filesystem');
const server = path.join(workspace, 'dist/index.js');
await fs.access(server);
const requireFromServer = createRequire(path.join(workspace, 'package.json'));
const load = (name) => import(pathToFileURL(requireFromServer.resolve(name)));
const { Client } = await load('@modelcontextprotocol/client');
const { StdioClientTransport } = await load('@modelcontextprotocol/client/stdio');

const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'mcp-recovery-'));
const original = 'known fixture\n';
const payload = 'write control\n';
const request = (name, target, content) => ({
  name,
  arguments: { path: target, ...(content === undefined ? {} : { content }) },
});
const read = (target) => request('read_text_file', target);
const write = (target) => request('write_file', target, payload);
const list = (target) => request('list_directory', target);
const info = (target) => request('get_file_info', target);
const textIs = (expected) => (text) => text === expected;
const isFile = (text) => text?.split('\n').includes('isFile: true')
  && text.split('\n').includes(`size: ${Buffer.byteLength(original)}`);
const isDirectory = (text) => text?.split('\n').includes('isDirectory: true');

const cases = [
  { id: 'read-file', request: read('known.txt'), check: textIs(original) },
  { id: 'write-new-file', request: write('written.txt'),
    check: textIs('Successfully wrote to written.txt'), creates: 'written.txt' },
  { id: 'list-directory', request: list('folder'), check: textIs('[FILE] nested.txt') },
  { id: 'info-file', request: info('known.txt'), check: isFile },
  { id: 'info-directory', request: info('folder'), check: isDirectory },
  { id: 'read-missing', request: read('missing.txt'), error: /ENOENT/ },
  { id: 'read-directory', request: read('folder'), error: /EISDIR|not a (regular )?file/i },
  { id: 'write-missing-parent', request: write('missing/new.txt'), error: /ENOENT/ },
  { id: 'write-directory', request: write('folder'), error: /EISDIR|not a regular file/i },
  { id: 'list-missing', request: list('missing'), error: /ENOENT/ },
  { id: 'list-file', request: list('known.txt'), error: /ENOTDIR/ },
  { id: 'info-missing', request: info('missing.txt'), error: /ENOENT/ },
  { id: 'info-child-of-file', request: info('known.txt/child'), error: /ENOTDIR/ },
];

function log(record) {
  let line = JSON.stringify(record);
  for (const [value, label] of [[root, '<FIXTURE>'], [repo, '<CHECKOUT>'], [os.homedir(), '<HOME>']]) {
    line = line.replaceAll(JSON.stringify(value).slice(1, -1), label);
  }
  console.log(line);
}

// Exclude atime because successful reads (including the snapshot itself) may change it.
async function snapshot(directory = root, prefix = '') {
  const result = {};
  for (const name of (await fs.readdir(directory)).sort()) {
    const filename = path.join(directory, name);
    const relative = prefix + name;
    const stat = await fs.lstat(filename, { bigint: true });
    const type = stat.isDirectory() ? 'dir' : stat.isFile() ? 'file' : 'other';
    result[relative] = {
      type, mode: String(stat.mode), inode: String(stat.ino),
      mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs),
      bytes: type === 'file' ? (await fs.readFile(filename)).toString('hex') : null,
    };
    if (type === 'dir') Object.assign(result, await snapshot(filename, relative + '/'));
  }
  return result;
}

const client = new Client({ name: 'postfiat-error-recovery', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath, args: [server, root], cwd: root, stderr: 'pipe',
});
let stderr = '';
transport.stderr?.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });

async function invoke(input) {
  try {
    const response = await client.callTool(input, { timeout });
    const text = response.content?.find((block) => block.type === 'text')?.text;
    return { request: input, outcome: response.isError === true ? 'tool-error' : 'success', text, response };
  } catch (error) {
    return { request: input, outcome: 'client-error', code: error.code, message: error.message };
  }
}

function processHealthy(pid) {
  if (!pid || transport.pid !== pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

try {
  await fs.mkdir(path.join(root, 'folder'));
  await fs.writeFile(path.join(root, 'known.txt'), original);
  await fs.writeFile(path.join(root, 'folder/nested.txt'), 'nested fixture\n');
  await client.connect(transport, { timeout });
  const pid = transport.pid;
  assert.ok(processHealthy(pid));
  log({ commit, node: process.version, platform: process.platform, arch: process.arch,
    server: client.getServerVersion(), timeoutMs: timeout });
  let passed = 0;
  let recoveries = 0;
  for (const test of cases) {
    const before = await snapshot();
    const actual = await invoke(test.request);
    const after = await snapshot();
    const recovery = test.error ? await invoke(read('known.txt')) : null;
    const final = recovery ? await snapshot() : after;
    const recoveryPassed = recovery ? recovery.outcome === 'success' && recovery.text === original : null;
    if (recoveryPassed) recoveries++;
    const created = test.creates && after[test.creates];
    const expectedCreation = !test.creates || (!before[test.creates] && created?.type === 'file'
      && created.bytes === Buffer.from(payload).toString('hex'));
    const unchanged = Object.keys({ ...before, ...final }).filter((key) => key !== test.creates)
      .every((key) => JSON.stringify(before[key]) === JSON.stringify(final[key]));
    const fixtureIntegrity = expectedCreation && unchanged
      && JSON.stringify(after) === JSON.stringify(final);
    const expectedResult = test.error
      ? actual.outcome === 'tool-error' && test.error.test(actual.text ?? '')
      : actual.outcome === 'success' && test.check(actual.text);
    const sameProcess = processHealthy(pid);
    const pass = Boolean(expectedResult && fixtureIntegrity && recoveryPassed !== false && sameProcess);
    if (pass) passed++;
    log({ id: test.id, expected: test.error ? String(test.error) : 'success', actual,
      recovery, recoveryPassed, fixtureIntegrity: Boolean(fixtureIntegrity), sameProcess, pass });
  }
  const serverHealthy = processHealthy(pid);
  log({ passed, failed: cases.length - passed, total: cases.length, recoveries,
    expectedRecoveries: cases.filter((test) => test.error).length, serverHealthy });
  if (passed !== cases.length || !serverHealthy) process.exitCode = 1;
} finally {
  try {
    await client.close();
  } finally {
    if (stderr) log({ stderr });
    await fs.rm(root, { recursive: true, force: true });
  }
}
