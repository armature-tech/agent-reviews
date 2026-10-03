'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { main, canOpenBrowser } = require('../lib/cli');

const TOKEN = `arv_${'t'.repeat(43)}`;
const DEVICE = `arvd_${'d'.repeat(43)}`;
const COMMAND = 'npx @armature-tech/agent-reviews';

// The sign-in API, answering each request with the next scripted reply.
async function mockApi(t, replies) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}');
    requests.push({ path: req.url, method: req.method, userAgent: req.headers['user-agent'], body });
    const next = replies.shift() || [500, {}];
    const [status, json] = typeof next === 'function' ? next(body) : next;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(json));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { base: `http://127.0.0.1:${server.address().port}`, requests };
}

function link(extra = {}) {
  return [200, {
    url: 'https://agent.reviews/verify?code=BCDF-GHJK',
    code: 'BCDF-GHJK',
    device_code: DEVICE,
    expires_at: new Date(Date.now() + 600000).toISOString(),
    check_url: 'https://app.armature.tech/api/agent-review/sign-in',
    interval: 5,
    ...extra,
  }];
}

// Timers fire at once and record their delays; the browser and Ctrl+C are stand-ins.
function harness(t, base, extra = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-reviews-cli-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const out = [];
  const err = [];
  const delays = [];
  const opened = [];
  let interrupt = null;
  const io = {
    api: base,
    env: { DISPLAY: ':0' },
    platform: 'linux',
    home,
    setTimer: (fn, ms) => { delays.push(ms); return setImmediate(fn); },
    clearTimer: (timer) => clearImmediate(timer),
    openBrowser: (url) => { opened.push(url); return true; },
    onInterrupt: (handler) => { interrupt = handler; return () => { interrupt = null; }; },
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    ...extra,
  };
  const file = path.join(home, '.armature', 'agent-review.json');
  return { io, home, file, out, err, delays, opened, interrupt: () => interrupt && interrupt() };
}

test('login saves the token where every agent reads it, for this user only, and keeps the other fields', async (t) => {
  const api = await mockApi(t, [
    link(),
    [200, { status: 'pending', expires_at: new Date(Date.now() + 600000).toISOString() }],
    [503, {}],
    [429, { error: { code: 'rate_limited', message: 'This address checked sign-in links more than 30 times in a minute.', details: { retryAfterSec: 7 } } }],
    [200, { status: 'approved', token: TOKEN }],
  ]);
  const h = harness(t, api.base);
  fs.mkdirSync(path.dirname(h.file), { mode: 0o755 });
  fs.writeFileSync(h.file, JSON.stringify({ automatic_reviews: 'declined', sign_in: 'declined', pending_sign_in: { device_code: 'arvd_old' } }), { mode: 0o644 });

  assert.equal(await main(['login'], h.io), 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(h.file, 'utf8')), { automatic_reviews: 'declined', token: TOKEN });
  assert.equal(fs.statSync(h.file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(h.file)).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(path.dirname(h.file)), ['agent-review.json']);

  assert.deepEqual(api.requests.map((r) => [r.method, r.path, r.body]), [
    ['POST', '/api/agent-review/sign-in', { action: 'login' }],
    ...Array.from({ length: 4 }, () => ['POST', '/api/agent-review/sign-in', { device_code: DEVICE, action: 'token' }]),
  ]);
  assert.match(api.requests[0].userAgent, /^agent-reviews-cli\/\S+ \(node v\d+/);
  // It checks every 5 seconds, and waits as long as a refusal asks.
  assert.deepEqual(h.delays, [5000, 5000, 5000, 7000, 5000]);
  assert.deepEqual(h.opened, ['https://agent.reviews/verify?code=BCDF-GHJK']);
  const said = h.out.join('\n');
  assert.match(said, /Open {2}https:\/\/agent\.reviews\/verify\?code=BCDF-GHJK/);
  assert.match(said, /Code {2}BCDF-GHJK {3}The page shows the same code\./);
  assert.match(said, /Press Ctrl\+C to skip\./);
  assert.match(said, /Signed in\. Every coding agent on this computer now publishes its reviews verified\./);
  // The token goes to the file only, never to the screen.
  assert.doesNotMatch([...h.out, ...h.err].join('\n'), /arv_t/);
});

test('a link approved in its last seconds still hands over its token', async (t) => {
  const api = await mockApi(t, [link({ expires_at: new Date(Date.now() + 2000).toISOString() }), [200, { status: 'approved', token: TOKEN }]]);
  const h = harness(t, api.base, { now: (() => { let at = Date.now(); return () => (at += 3000); })() });
  assert.equal(await main(['login'], h.io), 0);
  assert.equal(JSON.parse(fs.readFileSync(h.file, 'utf8')).token, TOKEN);
});

test('a signed-in computer stays signed in, unless login is forced', async (t) => {
  const api = await mockApi(t, [link(), [200, { status: 'approved', token: TOKEN }]]);
  const h = harness(t, api.base);
  fs.mkdirSync(path.dirname(h.file), { recursive: true });
  fs.writeFileSync(h.file, JSON.stringify({ token: 'arv_before' }));
  assert.equal(await main(['login'], h.io), 0);
  assert.equal(api.requests.length, 0);
  assert.match(h.out.join('\n'), new RegExp(`already signed in[\\s\\S]*${COMMAND} login --force`));
  assert.equal(await main(['login', '--force', '--no-browser'], h.io), 0);
  assert.equal(JSON.parse(fs.readFileSync(h.file, 'utf8')).token, TOKEN);
  assert.deepEqual(h.opened, []);
});

test('Ctrl+C closes the link and saves nothing', async (t) => {
  let h;
  const api = await mockApi(t, [
    link(),
    () => { h.interrupt(); return [200, { status: 'pending' }]; },
    [200, { status: 'cancelled' }],
  ]);
  h = harness(t, api.base);
  assert.equal(await main(['login'], h.io), 130);
  assert.deepEqual(api.requests.at(-1).body, { device_code: DEVICE, action: 'cancel' });
  assert.equal(api.requests.length, 3);
  assert.equal(fs.existsSync(h.file), false);
  assert.match(h.out.join('\n'), new RegExp(`Skipped\\. Sign in any time with: ${COMMAND} login`));
});

test('an expired or closed link ends with what to do next', async (t) => {
  const expired = await mockApi(t, [link(), [200, { status: 'expired' }]]);
  const one = harness(t, expired.base);
  assert.equal(await main(['login'], one.io), 1);
  assert.deepEqual(one.err, [`The link expired. Run ${COMMAND} login again.`]);

  // No check once the link's time is up, past one last look.
  const late = await mockApi(t, [link({ expires_at: new Date(Date.now() - 6000).toISOString() })]);
  const two = harness(t, late.base);
  assert.equal(await main(['login'], two.io), 1);
  assert.equal(late.requests.length, 1);

  const stopped = await mockApi(t, [link(), [200, { status: 'cancelled' }]]);
  const three = harness(t, stopped.base);
  assert.equal(await main(['login'], three.io), 1);
  assert.deepEqual(three.err, ['The sign-in was stopped.']);
  for (const h of [one, two, three]) assert.equal(fs.existsSync(h.file), false);
});

test('a refused start shows the reason, and an unsafe link is never opened', async (t) => {
  const limited = await mockApi(t, [[429, { error: { code: 'rate_limited', message: 'This address started 20 computer sign-ins within an hour, the limit. Start one again in 60 minutes (retryAfterSec 3600).' } }]]);
  const one = harness(t, limited.base);
  assert.equal(await main(['login'], one.io), 1);
  assert.match(one.err[0], /^This address started 20 computer sign-ins within an hour/);

  const unsafe = await mockApi(t, [link({ url: 'https://agent.reviews/verify?code=X" & calc' })]);
  const two = harness(t, unsafe.base);
  assert.equal(await main(['login'], two.io), 1);
  assert.deepEqual(two.opened, []);

  const closed = harness(t, 'http://127.0.0.1:9');
  assert.equal(await main(['login'], closed.io), 1);
  assert.match(closed.err[0], new RegExp(`^Could not reach agent\\.reviews \\(.+\\)\\. Check your connection and run ${COMMAND} login again\\.$`));
});

test('logout removes only the token', async (t) => {
  const h = harness(t, 'http://127.0.0.1:9');
  fs.mkdirSync(path.dirname(h.file), { recursive: true });
  fs.writeFileSync(h.file, JSON.stringify({ token: TOKEN, automatic_reviews: 'declined' }));
  assert.equal(await main(['logout'], h.io), 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(h.file, 'utf8')), { automatic_reviews: 'declined' });
  assert.equal(await main(['logout'], h.io), 0);
  assert.equal(h.out.at(-1), 'This computer is not signed in to agent.reviews.');
  fs.writeFileSync(h.file, JSON.stringify({ token: TOKEN }));
  assert.equal(await main(['logout'], h.io), 0);
  assert.equal(fs.existsSync(h.file), false);
});

test('the browser opens only on a desktop', () => {
  assert.equal(canOpenBrowser({}, 'darwin'), true);
  assert.equal(canOpenBrowser({}, 'win32'), true);
  assert.equal(canOpenBrowser({ DISPLAY: ':0' }, 'linux'), true);
  assert.equal(canOpenBrowser({ WAYLAND_DISPLAY: 'wayland-0' }, 'linux'), true);
  assert.equal(canOpenBrowser({}, 'linux'), false);
  assert.equal(canOpenBrowser({ SSH_CONNECTION: '10.0.0.1 22 10.0.0.2 22' }, 'darwin'), false);
  assert.equal(canOpenBrowser({ CI: 'true', DISPLAY: ':0' }, 'linux'), false);
});

test('help, version and unknown commands', async () => {
  const out = [];
  const err = [];
  const io = { out: (text) => out.push(text), err: (text) => err.push(text) };
  assert.equal(await main([], io), 0);
  assert.match(out[0], new RegExp(`${COMMAND} login {4}Sign this computer in`));
  assert.equal(await main(['--version'], io), 0);
  assert.equal(out[1], require('../package.json').version);
  assert.equal(await main(['login', '--frce'], io), 1);
  assert.match(err[0], /^Unknown command: login --frce/);
});

test('the package ships the command and nothing else', () => {
  const dir = path.join(__dirname, '..');
  const pkg = require('../package.json');
  assert.equal(pkg.name, '@armature-tech/agent-reviews');
  assert.deepEqual(pkg.bin, { 'agent-reviews': 'bin/agent-reviews.js' });
  assert.equal(pkg.dependencies, undefined);
  const bin = path.join(dir, pkg.bin['agent-reviews']);
  assert.match(fs.readFileSync(bin, 'utf8'), /^#!\/usr\/bin\/env node\n/);
  assert.ok(fs.statSync(bin).mode & 0o111, 'bin is executable');
  const packed = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: dir, encoding: 'utf8' }));
  assert.deepEqual(packed[0].files.map((f) => f.path).sort(), ['LICENSE', 'README.md', 'bin/agent-reviews.js', 'lib/cli.js', 'package.json']);
});
