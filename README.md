# MCP Filesystem error recovery test harness

Post Fiat task `task_be64c5234e28971beb1f7e6c17b81e6d`.

Both clean runs passed **13/13 cases**. All eight expected tool errors were followed by a successful read on the same server process and MCP connection. Every fixture check passed. The only expected mutation was creation of the write-control file.

## Reproduce locally

Requires Git, Node.js 24 LTS or later, npm and a POSIX filesystem. Build the reference server from [pinned upstream commit](https://github.com/modelcontextprotocol/servers/tree/36380287ed3b15d115b55f546617d723072b1296/src/filesystem) `36380287ed3b15d115b55f546617d723072b1296`. From this directory, use a fresh sibling checkout:

```sh
git init ../mcp-servers-pinned
git -C ../mcp-servers-pinned fetch --depth=1 https://github.com/modelcontextprotocol/servers.git 36380287ed3b15d115b55f546617d723072b1296
git -C ../mcp-servers-pinned checkout --detach FETCH_HEAD
(cd ../mcp-servers-pinned && npm ci --ignore-scripts --workspace src/filesystem --no-audit --no-fund)
(cd ../mcp-servers-pinned && npm run build --workspace src/filesystem)
```

Run one complete verification with:

```sh
node harness.mjs ../mcp-servers-pinned
```

Each invocation starts a fresh local server over stdio, creates its own disposable fixtures, and removes them on exit. The harness uses the MCP client already installed by upstream's lockfile. Startup and each MCP request have a five-second deadline. A timeout, transport exception, incorrect tool error, unsuccessful recovery, process failure or unexpected fixture mutation makes the run fail.

## Case matrix

All requests are relative to a single allowed fixture directory. `write_file` may create a missing file, so its missing-path error uses an absent parent directory. `get_file_info` accepts directories, so the type mismatch is a request for a child under a regular file.

| Case | Tool | Path | Expected | Run 1 | Run 2 |
| --- | --- | --- | --- | --- | --- |
| read-file | read_text_file | known.txt | Exact fixture text | Pass | Pass |
| write-new-file | write_file | written.txt | Success and exact bytes on disk | Pass | Pass |
| list-directory | list_directory | folder | Lists nested.txt as a file | Pass | Pass |
| info-file | get_file_info | known.txt | File type and correct byte size | Pass | Pass |
| info-directory | get_file_info | folder | Directory type | Pass | Pass |
| read-missing | read_text_file | missing.txt | ENOENT and recovery | Pass | Pass |
| read-directory | read_text_file | folder | EISDIR or explicit file-type error, then recovery | Pass | Pass |
| write-missing-parent | write_file | missing/new.txt | ENOENT and recovery | Pass | Pass |
| write-directory | write_file | folder | EISDIR or explicit file-type error, then recovery | Pass | Pass |
| list-missing | list_directory | missing | ENOENT and recovery | Pass | Pass |
| list-file | list_directory | known.txt | ENOTDIR and recovery | Pass | Pass |
| info-missing | get_file_info | missing.txt | ENOENT and recovery | Pass | Pass |
| info-child-of-file | get_file_info | known.txt/child | ENOTDIR and recovery | Pass | Pass |

A recovery probe reads `known.txt` and checks its exact bytes without restarting or reconnecting. The harness checks the original server PID after each case and at the end. It compares fixture entries, types, file bytes, inode, mode, mtime and ctime before and after each operation and recovery. It ignores atime because reads may update it. The positive write is checked as a specific new file with the expected content, with all other entries preserved.

The [first run](logs/run-1.jsonl) and [second run](logs/run-2.jsonl) were captured on macOS arm64 with Node.js 25.2.1, npm 11.6.2 and server 2.2.0. JSONL includes the request, response, recovery, process health and fixture verdict for every case. Local fixture, checkout and home paths are replaced with placeholders. Fixture timestamps may differ between runs. No server defect was observed in this matrix. The results cover sequential calls to these four tools on the pinned server and this platform.
