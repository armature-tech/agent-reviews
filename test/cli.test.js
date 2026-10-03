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
    requests.push({ path: req.url, method: req.method, userAgent: req.headers['user-agent'], authorization: req.headers.authorization, body });
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
    sleep: async (ms) => { delays.push(ms); },
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

const REVIEW = {
  schema_version: 'agent-review.compact.v1',
  subject: { kind: 'cli', vendor_name: 'Vercel', product_name: 'Vercel', interface_used: 'cli', flow_name: 'Deploying a preview' },
  experience: { task_type: 'deploy_web_app', outcome: 'completed', usefulness_score: 5, ease_score: 4, reliability_score: 4, short_summary: 'Vercel deployed the app and returned a working preview URL.' },
  client: { idempotency_key: 'k-1', sign_in: true },
};
const LINK = { url: 'https://agent.reviews/verify?code=BCDF-GHJK', code: 'BCDF-GHJK', device_code: DEVICE, expires_at: '2026-10-03T12:10:00.000Z', check_url: 'https://app.armature.tech/api/agent-review/sign-in' };
const receipt = (extra = {}) => [200, { review_id: 'r1', accepted: true, held_reason: null, duplicate: false, public_url: 'https://agent.reviews/deploy/vercel#review-r1', verified: false, publishes_at: null, sign_in: null, ...extra }];
const record = (h) => JSON.parse(fs.readFileSync(h.file, 'utf8'));
const seed = (h, value) => { fs.mkdirSync(path.dirname(h.file), { recursive: true, mode: 0o700 }); fs.writeFileSync(h.file, JSON.stringify(value), { mode: 0o600 }); };

test('submit sends a signed-in review with the token, and never prints it', async (t) => {
  const api = await mockApi(t, [receipt({ verified: true })]);
  const h = harness(t, api.base);
  seed(h, { token: TOKEN, automatic_reviews: 'declined' });
  const file = path.join(h.home, 'review.json');
  fs.writeFileSync(file, JSON.stringify(REVIEW));
  assert.equal(await main(['submit', file], h.io), 0);
  assert.equal(api.requests[0].path, '/api/agent-review');
  assert.equal(api.requests[0].authorization, `Bearer ${TOKEN}`);
  // Signed in, the review needs no link: the agent's own sign_in is dropped.
  assert.deepEqual(api.requests[0].body.client, { idempotency_key: 'k-1' });
  assert.equal(JSON.parse(h.out.join('\n')).verified, true);
  assert.doesNotMatch([...h.out, ...h.err].join('\n'), /arv_t/);
});

test('submit without a sign-in asks for a link, keeps it for the next review and for check, and shows no device code', async (t) => {
  const api = await mockApi(t, [receipt({ publishes_at: LINK.expires_at, sign_in: LINK }), receipt({ publishes_at: LINK.expires_at, sign_in: LINK })]);
  const h = harness(t, api.base, { readStdin: async () => JSON.stringify(REVIEW) });
  assert.equal(await main(['submit'], h.io), 0);
  assert.equal(api.requests[0].authorization, undefined);
  assert.equal(api.requests[0].body.client.sign_in, true);
  assert.deepEqual(record(h), { pending_sign_in: { device_code: DEVICE, check_url: `${api.base}/api/agent-review/sign-in` } });
  assert.equal(fs.statSync(h.file).mode & 0o777, 0o600);
  const shown = JSON.parse(h.out.join('\n'));
  assert.deepEqual(shown.sign_in, { url: LINK.url, code: LINK.code, expires_at: LINK.expires_at });
  assert.doesNotMatch(h.out.join('\n'), /arvd_/);
  // The next review joins the link that waits, so one sign-in covers both.
  assert.equal(await main(['submit', '-'], h.io), 0);
  assert.equal(api.requests[1].body.client.sign_in, DEVICE);
});

test('submit sends no link once the person declined, and drops a revoked token', async (t) => {
  const declined = await mockApi(t, [receipt()]);
  const one = harness(t, declined.base, { readStdin: async () => JSON.stringify(REVIEW) });
  seed(one, { sign_in: 'declined' });
  assert.equal(await main(['submit'], one.io), 0);
  assert.deepEqual(declined.requests[0].body.client, { idempotency_key: 'k-1' });

  const revoked = await mockApi(t, [
    [401, { error: { code: 'invalid_review_token', message: 'This review token is not valid. Delete it and submit the review without it.' } }],
    receipt({ publishes_at: LINK.expires_at, sign_in: LINK }),
  ]);
  const two = harness(t, revoked.base, { readStdin: async () => JSON.stringify(REVIEW) });
  seed(two, { token: TOKEN, automatic_reviews: 'declined' });
  assert.equal(await main(['submit'], two.io), 0);
  assert.equal(revoked.requests[1].authorization, undefined);
  assert.equal(revoked.requests[1].body.client.sign_in, true);
  assert.deepEqual(record(two), { automatic_reviews: 'declined', pending_sign_in: { device_code: DEVICE, check_url: `${revoked.base}/api/agent-review/sign-in` } });
});

test('submit waits out a short limit once, and reports a long one or a refusal', async (t) => {
  const short = await mockApi(t, [[429, { error: { code: 'rate_limited', message: 'Wait.', details: { retryAfterSec: 20 } } }], receipt()]);
  const one = harness(t, short.base, { readStdin: async () => JSON.stringify(REVIEW) });
  assert.equal(await main(['submit'], one.io), 0);
  assert.deepEqual(one.delays, [20000]);
  assert.deepEqual(short.requests[0].body, short.requests[1].body);

  const long = await mockApi(t, [[429, { error: { code: 'rate_limited', message: 'This agent sent 50 reviews today, the limit. Send one again in 3 hours (retryAfterSec 10800).', details: { retryAfterSec: 10800 } } }]]);
  const two = harness(t, long.base, { readStdin: async () => JSON.stringify(REVIEW) });
  assert.equal(await main(['submit'], two.io), 1);
  assert.deepEqual(JSON.parse(two.out.join('\n')), { status: 429, error: { code: 'rate_limited', message: 'This agent sent 50 reviews today, the limit. Send one again in 3 hours (retryAfterSec 10800).', details: { retryAfterSec: 10800 } } });
  assert.equal(long.requests.length, 1);

  const flaky = await mockApi(t, [[503, {}], receipt()]);
  const three = harness(t, flaky.base, { readStdin: async () => JSON.stringify(REVIEW) });
  assert.equal(await main(['submit'], three.io), 0);
  assert.deepEqual(three.delays, [2000]);

  const four = harness(t, 'http://127.0.0.1:9', { readStdin: async () => '{"not": ' });
  assert.equal(await main(['submit'], four.io), 1);
  assert.match(JSON.parse(four.out.join('\n')).error.message, /^Could not read the review JSON .+ The review was not sent\.$/);
});

test('check collects the approved sign-in into the file, and never prints the token', async (t) => {
  const api = await mockApi(t, [[200, { status: 'pending', expires_at: LINK.expires_at }], [200, { status: 'approved', token: TOKEN }]]);
  const h = harness(t, api.base);
  seed(h, { automatic_reviews: 'declined', pending_sign_in: { device_code: DEVICE, check_url: 'https://elsewhere.example/api' } });
  assert.equal(await main(['check'], h.io), 0);
  assert.deepEqual(JSON.parse(h.out.pop()), { status: 'pending', expires_at: LINK.expires_at });
  assert.equal(await main(['check'], h.io), 0);
  assert.deepEqual(JSON.parse(h.out.pop()), { status: 'approved', signed_in: true });
  // It checks the link with agent.reviews, never with an address from the file.
  assert.deepEqual(api.requests.map((r) => [r.path, r.body]), Array.from({ length: 2 }, () => ['/api/agent-review/sign-in', { device_code: DEVICE, action: 'token' }]));
  assert.deepEqual(record(h), { automatic_reviews: 'declined', token: TOKEN });
  assert.doesNotMatch([...h.out, ...h.err].join('\n'), /arv_t/);
  assert.equal(await main(['check'], h.io), 0);
  assert.deepEqual(JSON.parse(h.out.pop()), { status: 'signed_in' });
});

test('check publish and check cancel close the link', async (t) => {
  const api = await mockApi(t, [[200, { status: 'declined' }], [200, { status: 'cancelled' }], [404, { error: { code: 'sign_in_not_found', message: 'Unknown device code' } }]]);
  const h = harness(t, api.base);
  seed(h, { pending_sign_in: { device_code: DEVICE } });
  assert.equal(await main(['check', 'publish'], h.io), 0);
  assert.deepEqual(api.requests[0].body, { device_code: DEVICE, action: 'publish' });
  assert.deepEqual(record(h), { sign_in: 'declined' });
  seed(h, { pending_sign_in: { device_code: DEVICE } });
  assert.equal(await main(['check', 'cancel'], h.io), 0);
  assert.deepEqual(JSON.parse(h.out.pop()), { status: 'cancelled', signed_in: false });
  assert.equal(fs.existsSync(h.file), false);
  seed(h, { pending_sign_in: { device_code: DEVICE }, automatic_reviews: 'declined' });
  assert.equal(await main(['check'], h.io), 1);
  assert.deepEqual(record(h), { automatic_reviews: 'declined' });
  assert.equal(await main(['check'], h.io), 0);
  assert.deepEqual(JSON.parse(h.out.pop()), { status: 'none' });
});

test('publish or cancel after the person approved saves the sign-in, and a late cancel says the reviews are public', async (t) => {
  const api = await mockApi(t, [
    [200, { status: 'approved' }],
    [200, { status: 'approved', token: TOKEN }],
    [409, { error: { code: 'already_published', message: 'The review is already public.' } }],
    [200, { status: 'claimed' }],
  ]);
  const h = harness(t, api.base);
  seed(h, { pending_sign_in: { device_code: DEVICE } });
  assert.equal(await main(['check', 'publish'], h.io), 0);
  assert.deepEqual(api.requests.map((r) => r.body.action), ['publish', 'token']);
  assert.deepEqual(JSON.parse(h.out.pop()), { status: 'approved', signed_in: true });
  assert.deepEqual(record(h), { token: TOKEN });

  seed(h, { token: TOKEN, pending_sign_in: { device_code: DEVICE } });
  assert.equal(await main(['check', 'cancel'], h.io), 1);
  assert.deepEqual(api.requests.slice(2).map((r) => r.body.action), ['cancel', 'token']);
  assert.deepEqual(JSON.parse(h.out.pop()), { status: 409, error: { code: 'already_published', message: 'The review is already public.' }, signed_in: true });
  assert.deepEqual(record(h), { token: TOKEN });
  assert.doesNotMatch(h.out.join('\n'), /arv_/);
});

test('submit says when it could not keep the link, and sends the review once', async (t) => {
  const api = await mockApi(t, [receipt({ publishes_at: LINK.expires_at, sign_in: LINK })]);
  const h = harness(t, api.base, { readStdin: async () => JSON.stringify(REVIEW) });
  fs.writeFileSync(path.join(h.home, '.armature'), 'not a folder');
  assert.equal(await main(['submit'], h.io), 0);
  assert.equal(api.requests.length, 1);
  const printed = JSON.parse(h.out.pop());
  assert.equal(printed.accepted, true);
  assert.deepEqual(printed.sign_in, { url: LINK.url, code: LINK.code, expires_at: LINK.expires_at });
  assert.equal(printed.warning.code, 'not_saved');
  assert.match(printed.warning.message, /Opening it still verifies this review, but check cannot follow it\. Run npx @armature-tech\/agent-reviews login in a terminal/);
  assert.doesNotMatch(JSON.stringify(printed), /arvd_/);
});

test('a revoked token is not sent again, even when the file cannot drop it', { skip: process.getuid && process.getuid() === 0 && 'root ignores file permissions' }, async (t) => {
  const api = await mockApi(t, [
    [401, { error: { code: 'invalid_review_token', message: 'This review token is not valid.' } }],
    receipt({ publishes_at: LINK.expires_at, sign_in: LINK }),
  ]);
  const h = harness(t, api.base, { readStdin: async () => JSON.stringify(REVIEW) });
  seed(h, { token: TOKEN });
  fs.chmodSync(path.dirname(h.file), 0o500);
  const code = await main(['submit'], h.io);
  fs.chmodSync(path.dirname(h.file), 0o700);
  assert.equal(code, 0);
  assert.equal(api.requests[0].authorization, `Bearer ${TOKEN}`);
  assert.equal(api.requests[1].authorization, undefined);
  assert.equal(api.requests[1].body.client.sign_in, true);
  assert.equal(JSON.parse(h.out.pop()).warning.code, 'not_saved');
});

test('agents take turns on the file: a stale lock goes, a held one is waited on', async (t) => {
  const { io, file, out } = harness(t, 'http://127.0.0.1:9');
  seed({ file }, { token: TOKEN });
  const lock = `${file}.lock`;
  fs.writeFileSync(lock, '');
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(lock, old, old);
  assert.equal(await main(['automatic', 'declined'], io), 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { token: TOKEN, automatic_reviews: 'declined' });
  assert.equal(fs.existsSync(lock), false);

  // Another agent holds the lock past the wait: nothing is written over its change.
  fs.writeFileSync(lock, '');
  fs.rmSync(file);
  const started = Date.now();
  assert.equal(await main(['automatic', 'declined'], io), 1);
  assert.ok(Date.now() - started >= 4900);
  assert.match(JSON.parse(out.pop()).error.message, /another agent is still updating it/);
  assert.equal(fs.existsSync(file), false);
  fs.rmSync(lock);
});

test('automatic says whether the person turned down automatic reviews, and records it beside the sign-in', async (t) => {
  const { io, file, out } = harness(t, 'http://127.0.0.1:9');
  assert.equal(await main(['automatic'], io), 0);
  assert.deepEqual(JSON.parse(out.pop()), { automatic_reviews_declined: false });
  assert.equal(fs.existsSync(file), false);

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ token: TOKEN, pending_sign_in: { device_code: DEVICE } }));
  assert.equal(await main(['automatic', 'declined'], io), 0);
  assert.deepEqual(JSON.parse(out.pop()), { automatic_reviews_declined: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { token: TOKEN, pending_sign_in: { device_code: DEVICE }, automatic_reviews: 'declined' });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  assert.equal(await main(['automatic'], io), 0);
  assert.deepEqual(JSON.parse(out.pop()), { automatic_reviews_declined: true });
  assert.doesNotMatch(out.join('\n'), /arv_|arvd_/);
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
  assert.match(out[0], new RegExp(`${COMMAND} submit \\[file\\]\n {6}Send a review, JSON from the file or stdin\\.`));
  assert.match(out[0], new RegExp(`${COMMAND} check \\[publish\\|cancel\\]\n {6}Collect the sign-in once its link is approved\\.`));
  assert.match(out[0], new RegExp(`${COMMAND} automatic \\[declined\\]\n {6}Say whether the person turned down automatic reviews`));
  assert.equal(await main(['check', 'later'], io), 1);
  assert.equal(await main(['automatic', 'yes'], io), 1);
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
