import test from "node:test";
import assert from "node:assert/strict";
import { scanRedirects, stripHeredocs, writeIndicators } from "./shell-parse.mjs";

const labels = (command, shell = "bash") => writeIndicators(command, shell).map((f) => f.label);

// ---------------------------------------------------------------------------
// `>` inside quotes
// ---------------------------------------------------------------------------

test("a quoted > in a shell command is not a redirect", () => {
  assert.deepEqual(scanRedirects('grep -n "a > b" src/App.js'), []);
  assert.deepEqual(scanRedirects("grep -n 'a > b' src/App.js"), []);
  assert.deepEqual(scanRedirects('Select-String -Pattern "a > b" src\\App.js', "powershell"), []);
});

test("a > inside a node -e or python -c payload is not a redirect", () => {
  for (const command of [
    `node -e 'if (a > b) console.log(1)'`,
    `node -e "if (a>b) 1"`,
    'node -e "console.log(`a > b`)"',
    `node -e "const m = s.match(/<a>/)"`,
    `python -c "print(1 > 0)"`,
    `python -c 'print(1 > 0)'`,
  ]) {
    assert.deepEqual(labels(command), [], command);
  }
  assert.deepEqual(labels(`node -e "if (a > b) 1"`, "powershell"), []);
});

test("a real redirect after a payload still counts", () => {
  assert.deepEqual(labels(`node -e "console.log(1 > 0)" > out.txt`), ["> redirection"]);
});

// ---------------------------------------------------------------------------
// `=>`
// ---------------------------------------------------------------------------

test("=> and >= in inline code are not redirects", () => {
  for (const command of [
    `node -e "[1,2].filter((x) => x > 1)"`,
    `node -e "const ok = n >= 1"`,
    `node -e "[1].map(x=>x)"`,
    `node -p "[1].map((x) => x)"`,
  ]) {
    assert.deepEqual(labels(command), [], command);
  }
});

// ---------------------------------------------------------------------------
// heredocs
// ---------------------------------------------------------------------------

test("stripHeredocs removes bodies and keeps the command line", () => {
  const { text, bodies } = stripHeredocs("cat > /tmp/x <<'EOF'\nsee src/App.js\nEOF\necho done");
  assert.equal(text, "cat > /tmp/x <<'EOF'\necho done");
  assert.deepEqual(bodies.map((b) => b.text), ["see src/App.js"]);
});

test("stripHeredocs handles <<-, unquoted and double-quoted delimiters", () => {
  assert.equal(stripHeredocs('cat <<-"END"\n\tx > y\n\tEND\nls').text, 'cat <<-"END"\nls');
  assert.equal(stripHeredocs("cat <<EOF\nx\nEOF").text, "cat <<EOF");
  assert.equal(stripHeredocs("cat <<< 'a > b'").bodies.length, 0);
});

test("heredoc body text is not a redirect or a write word", () => {
  assert.deepEqual(labels("git log -1 <<'EOF'\nx > scripts/lib/claims-core.mjs\nEOF"), []);
  assert.deepEqual(labels("cat <<'EOF'\nthen rm it and mv it\nEOF"), []);
});

test("a heredoc body fed to an interpreter is judged as code", () => {
  assert.deepEqual(labels("node - <<'EOF'\nconst a = (x) => x > 0;\nEOF"), []);
  assert.deepEqual(labels("node - <<'EOF'\nrequire('fs').writeFileSync('src/App.js','x')\nEOF"), [
    "writeFileSync",
  ]);
  assert.deepEqual(labels("bash <<'EOF'\nrm src/App.js\nEOF"), ["rm/touch/mkdir"]);
});

// ---------------------------------------------------------------------------
// script writes
// ---------------------------------------------------------------------------

test("node and python file writes are detected", () => {
  for (const command of [
    `node -e "require('fs').appendFileSync('a','x')"`,
    `node -e "require('fs').renameSync('/tmp/x','a')"`,
    `node -e "require('fs').copyFileSync('/tmp/x','a')"`,
    `node -e "require('fs').unlinkSync('a')"`,
    `node -e "require('fs').rmSync('a')"`,
    `node -e "require('fs').mkdirSync('a')"`,
    `node -e "require('fs').createWriteStream('a')"`,
    `node -e "require('fs').promises.appendFile('a','x')"`,
    `node -e "require('fs').openSync('a','w')"`,
    `node -e "require('child_process').execSync('echo x > a')"`,
    `python -c "import pathlib; pathlib.Path('a').write_text('x')"`,
    `python -c "import shutil; shutil.copy('/tmp/x','a')"`,
    `python -c "import os; os.remove('a')"`,
    `python -c "import os; os.rename('/tmp/x','a')"`,
    `python -c "import subprocess; subprocess.run('rm a', shell=True)"`,
  ]) {
    assert.ok(labels(command).length, command);
  }
});

test("node and python reads are not writes", () => {
  for (const command of [
    `node -e "console.log(require('fs').readFileSync('a','utf8'))"`,
    `node -e "require('fs').existsSync('a')"`,
    `python -c "print(open('a').read())"`,
    `python -c "print('a b'.replace('a', 'c'))"`,
  ]) {
    assert.deepEqual(labels(command), [], command);
  }
});
