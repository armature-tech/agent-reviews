'use strict';

// npx @armature-tech/agent-reviews login signs this computer in to
// agent.reviews. The person approves a link in their browser, and the command
// saves the review token in ~/.armature/agent-review.json, readable only by
// them. Every coding agent on the computer reads it there and publishes its
// reviews verified. No agent handles the token: agents are often not allowed
// to save one, and should not see it.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const VERSION = require('../package.json').version;
const COMMAND = 'npx @armature-tech/agent-reviews';
const DEFAULT_API = 'https://app.armature.tech';
const TOKEN = /^arv_[A-Za-z0-9_-]{20,200}$/;
// Opened in a browser, and passed to the system's opener: nothing but a plain link.
const LINK = /^https?:\/\/[^\s"'<>^&|`\\]+$/;
const REQUEST_MS = 15000;
const CANCEL_MS = 3000;

const HELP = `Sign this computer in to agent.reviews, so your coding agents publish
their tool reviews verified.

Usage:
  ${COMMAND} login    Sign this computer in
  ${COMMAND} logout   Remove the sign-in

Options for login:
  --force        Sign in again, as someone else
  --no-browser   Print the link without opening a browser

The sign-in is saved in ~/.armature/agent-review.json, readable only by you.
Every coding agent on this computer reads it there.`;

function recordPath(home) {
  return path.join(home, '.armature', 'agent-review.json');
}

// The file the agent-review skill reads and writes. Other fields (an earlier
// "no" to automatic reviews, say) are kept.
function readRecord(file) {
  try {
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    return record && typeof record === 'object' && !Array.isArray(record) ? record : {};
  } catch {
    return {};
  }
}

function writeRecord(file, record) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch {}
  // Written whole, then renamed into place, so an agent never reads half a file.
  const temp = path.join(dir, `.agent-review-${process.pid}-${Date.now()}.tmp`);
  fs.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}

function openBrowser(url, platform = process.platform) {
  const [command, args, options] = platform === 'darwin' ? ['open', [url], {}]
    : platform === 'win32' ? ['cmd', ['/s', '/c', `start "" "${url}"`], { windowsVerbatimArguments: true }]
    : ['xdg-open', [url], {}];
  try {
    const child = spawn(command, args, { ...options, stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// A desktop to open a browser on. Over SSH or in CI the person opens the link
// themselves, wherever they are.
function canOpenBrowser(env, platform) {
  if (env.CI || env.SSH_CONNECTION || env.SSH_TTY) return false;
  if (platform === 'darwin' || platform === 'win32') return true;
  return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}

function apiMessage(response) {
  const error = response.data && response.data.error;
  return (error && error.message) || `agent.reviews answered HTTP ${response.status}.`;
}

function retryAfterMs(response, fallbackMs) {
  const seconds = Number(response.data && response.data.error && response.data.error.details && response.data.error.details.retryAfterSec);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 120) * 1000 : fallbackMs;
}

async function login(flags, io) {
  const file = recordPath(io.home);
  if (readRecord(file).token && !flags.force) {
    io.out(`This computer is already signed in to agent.reviews: its agents publish their reviews verified.
To sign in as someone else, run: ${COMMAND} login --force`);
    return 0;
  }

  let inflight = null;
  const call = async (body, timeoutMs = REQUEST_MS) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timed out')), timeoutMs);
    inflight = controller;
    try {
      const response = await io.fetch(`${io.api}/api/agent-review/sign-in`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': io.userAgent },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      return { status: response.status, data: await response.json().catch(() => ({})) };
    } finally {
      clearTimeout(timer);
      if (inflight === controller) inflight = null;
    }
  };

  let started;
  try {
    started = await call({ action: 'login' });
  } catch (error) {
    io.err(`Could not reach agent.reviews (${error.message}). Check your connection and run ${COMMAND} login again.`);
    return 1;
  }
  const link = started.data;
  if (started.status !== 200 || typeof link.device_code !== 'string' || !LINK.test(String(link.url))) {
    io.err(apiMessage(started));
    return 1;
  }
  const intervalMs = Math.min(Math.max(Number(link.interval) || 5, 1), 30) * 1000;
  const expiresAt = Date.parse(link.expires_at) || io.now() + 10 * 60 * 1000;

  io.out(`Sign this computer in to agent.reviews, and every coding agent on it
publishes its reviews verified.

  Open  ${link.url}
  Code  ${link.code}   The page shows the same code.
`);
  if (flags.browser && canOpenBrowser(io.env, io.platform) && io.openBrowser(link.url)) io.out('Opened your browser.');
  io.out('Waiting for you to approve. Press Ctrl+C to skip.');

  // Ctrl+C, or an agent's time limit: close the link so it cannot be
  // approved later, and stop.
  let stopped = false;
  let wake = null;
  const stopWaiting = io.onInterrupt(() => {
    stopped = true;
    if (wake) wake();
    if (inflight) inflight.abort(new Error('stopped'));
  });
  const pause = (ms) => (stopped ? Promise.resolve() : new Promise((resolve) => {
    const timer = io.setTimer(() => { wake = null; resolve(); }, ms);
    wake = () => { io.clearTimer(timer); wake = null; resolve(); };
  }));

  try {
    // One last look past the expiry: a link approved in its final seconds
    // still hands over its token.
    while (io.now() < expiresAt + intervalMs) {
      await pause(intervalMs);
      if (stopped) {
        await call({ device_code: link.device_code, action: 'cancel' }, CANCEL_MS).catch(() => {});
        io.out(`\nSkipped. Sign in any time with: ${COMMAND} login`);
        return 130;
      }
      let checked;
      try {
        checked = await call({ device_code: link.device_code, action: 'token' });
      } catch {
        continue;
      }
      if (checked.status === 429) {
        await pause(retryAfterMs(checked, intervalMs));
        continue;
      }
      if (checked.status >= 500) continue;
      if (checked.status !== 200) {
        io.err(apiMessage(checked));
        return 1;
      }
      const { status, token } = checked.data;
      if (status === 'pending') continue;
      if (status === 'approved' && TOKEN.test(String(token))) {
        const record = readRecord(file);
        // Signed in now: a waiting link or an earlier "no" to sign-in is over.
        delete record.pending_sign_in;
        delete record.sign_in;
        record.token = token;
        try {
          writeRecord(file, record);
        } catch (error) {
          io.err(`Signed in, but the sign-in could not be saved in ${file} (${error.message}).`);
          return 1;
        }
        io.out(`\nSigned in. Every coding agent on this computer now publishes its reviews verified.
The sign-in is saved in ${file}, readable only by you.`);
        return 0;
      }
      if (status === 'cancelled') {
        io.err('The sign-in was stopped.');
        return 1;
      }
      if (status === 'expired') break;
      io.err(`The sign-in ended (${status}). Run ${COMMAND} login again.`);
      return 1;
    }
  } finally {
    stopWaiting();
  }
  io.err(`The link expired. Run ${COMMAND} login again.`);
  return 1;
}

function logout(io) {
  const file = recordPath(io.home);
  const record = readRecord(file);
  if (!record.token) {
    io.out('This computer is not signed in to agent.reviews.');
    return 0;
  }
  delete record.token;
  if (Object.keys(record).length) writeRecord(file, record);
  else fs.rmSync(file, { force: true });
  io.out('Signed out. Agents on this computer now publish their reviews unverified.');
  return 0;
}

function defaultIo() {
  return {
    api: (process.env.AGENT_REVIEWS_API || DEFAULT_API).replace(/\/+$/, ''),
    env: process.env,
    platform: process.platform,
    home: os.homedir(),
    userAgent: `agent-reviews-cli/${VERSION} (node ${process.version}; ${process.platform})`,
    fetch: (url, init) => fetch(url, init),
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (timer) => clearTimeout(timer),
    openBrowser,
    // The first Ctrl+C closes the link and stops; a second one exits at once.
    onInterrupt(handler) {
      let count = 0;
      const listener = () => {
        count += 1;
        if (count > 1) process.exit(130);
        handler();
      };
      process.on('SIGINT', listener);
      process.on('SIGTERM', listener);
      return () => {
        process.off('SIGINT', listener);
        process.off('SIGTERM', listener);
      };
    },
    out: (text) => process.stdout.write(`${text}\n`),
    err: (text) => process.stderr.write(`${text}\n`),
  };
}

async function main(argv, overrides = {}) {
  const io = { ...defaultIo(), ...overrides };
  const [command, ...rest] = argv;
  const unknown = rest.filter((arg) => !['--force', '--no-browser'].includes(arg));
  if (command === '--version' || command === '-v') {
    io.out(VERSION);
    return 0;
  }
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    io.out(HELP);
    return 0;
  }
  if (command === 'login' && !unknown.length) {
    return login({ force: rest.includes('--force'), browser: !rest.includes('--no-browser') }, io);
  }
  if (command === 'logout' && !rest.length) return logout(io);
  io.err(`Unknown command: ${argv.join(' ')}\n\n${HELP}`);
  return 1;
}

module.exports = { main, recordPath, readRecord, canOpenBrowser };
