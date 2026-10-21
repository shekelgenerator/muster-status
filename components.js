// What the status page checks. Each component has a plain-language name (what
// people see) and one check. Checks run from GitHub Actions, outside Render and
// the call server, so the page still works when either is down.
//
// kinds:
//   http  — GET the URL; up when the status is in `expect` (redirects are not
//           followed, so a 301 counts as an answer); `json` (optional) is a
//           function the parsed body must pass.
//   ws    — open a WebSocket; up when the first message passes `message`.
//
// slowMs: answered, but slower than this, counts as "slow" (degraded).

module.exports = [
  {
    id: 'website',
    name: 'Website and app',
    description: 'musterchat.com and the app in your browser',
    check: { kind: 'http', url: 'https://www.musterchat.com/', expect: [200], slowMs: 3000 },
  },
  {
    id: 'api',
    name: 'Sign-in and accounts',
    description: 'Signing in, your account, servers and settings',
    check: {
      kind: 'http',
      url: 'https://www.musterchat.com/api/health',
      expect: [200],
      slowMs: 3000,
      json: (b) => !!b && b.ok === true,
    },
  },
  {
    id: 'messages',
    name: 'Messages',
    description: 'Sending and receiving messages in real time',
    check: {
      kind: 'ws',
      url: 'wss://www.musterchat.com/?v=10&encoding=json',
      slowMs: 5000,
      // The gateway says hello (op 10) as soon as it accepts a connection.
      message: (m) => !!m && m.op === 10 && !!m.d && typeof m.d.heartbeat_interval === 'number',
    },
  },
  {
    id: 'calls',
    name: 'Voice and video calls',
    description: 'Calls, screen sharing and Listen together',
    check: { kind: 'http', url: 'https://rtc.musterchat.com/', expect: [200], slowMs: 3000 },
  },
  {
    id: 'desktop',
    name: 'Desktop app updates',
    description: 'Downloads and automatic updates for the desktop app',
    // GitHub answers the "latest release" link with a redirect to the release.
    check: { kind: 'http', url: 'https://github.com/shekelgenerator/muster-releases/releases/latest', expect: [302], slowMs: 5000 },
  },
];
