import http from 'k6/http';
import { sleep, check, group } from 'k6';

const BASELINE_URL = __ENV.BASELINE_URL || 'http://localhost:30301';
const STAGING_URL  = __ENV.STAGING_URL  || 'http://localhost:30302';

const WARMUP_S   = parseInt(__ENV.WARMUP_S   || '60',  10);
const RAMPUP_S   = parseInt(__ENV.RAMPUP_S   || '30',  10);
const MEASURE_S  = parseInt(__ENV.MEASURE_S  || '120', 10);
const RAMPDOWN_S = parseInt(__ENV.RAMPDOWN_S || '30',  10);

// Test credentials — seeded in setup()
const ADMIN_USER = 'apia-admin';
const ADMIN_PASS = 'Apia2024!';
const TEST_REPO  = 'test-repo';

const STAGES = [
  { duration: `${WARMUP_S}s`,   target: 5  },
  { duration: `${RAMPUP_S}s`,   target: 20 },
  { duration: `${MEASURE_S}s`,  target: 20 },
  { duration: `${RAMPDOWN_S}s`, target: 0  },
];

export const options = {
  scenarios: {
    baseline: {
      executor: 'ramping-vus',
      exec: 'testBaseline',
      stages: STAGES,
      tags: { env: 'baseline' },
    },
    staging: {
      executor: 'ramping-vus',
      exec: 'testStaging',
      stages: STAGES,
      tags: { env: 'staging' },
    },
  },
  thresholds: {
    'http_req_duration{env:staging}':  ['p(95)<2000'],
    'http_req_duration{env:baseline}': ['p(95)<9999999'],
    'http_req_failed{env:staging}':    ['rate<0.05'],
  },
};

// Seed both environments with a user + repo + issues before the test starts
export function setup() {
  for (const baseURL of [BASELINE_URL, STAGING_URL]) {
    seedEnv(baseURL);
  }
}

function seedEnv(baseURL) {
  const headers = { 'Content-Type': 'application/json' };

  // Create admin user via Gitea API
  http.post(`${baseURL}/api/v1/user/register`, JSON.stringify({
    username: ADMIN_USER,
    password: ADMIN_PASS,
    email: 'apia@test.local',
    must_change_password: false,
  }), { headers });

  // Auth header for subsequent calls
  const auth = { Authorization: `Basic ${b64(ADMIN_USER + ':' + ADMIN_PASS)}` };
  const h = { ...headers, ...auth };

  // Create a repo
  http.post(`${baseURL}/api/v1/user/repos`, JSON.stringify({
    name: TEST_REPO,
    description: 'APIA load test repository',
    private: false,
    auto_init: true,
    default_branch: 'main',
  }), { headers: h });

  // Create 20 issues so issue listing queries have something to return
  for (let i = 1; i <= 20; i++) {
    http.post(`${baseURL}/api/v1/repos/${ADMIN_USER}/${TEST_REPO}/issues`, JSON.stringify({
      title: `Test issue ${i}`,
      body: `This is test issue number ${i} created by APIA load test seeding.`,
    }), { headers: h });
  }
}

function b64(str) {
  // k6 built-in base64 encoding
  const bytes = [];
  for (let i = 0; i < str.length; i++) bytes.push(str.charCodeAt(i));
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let result = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i], b1 = bytes[i+1] || 0, b2 = bytes[i+2] || 0;
    result += chars[b0 >> 2];
    result += chars[((b0 & 3) << 4) | (b1 >> 4)];
    result += i+1 < bytes.length ? chars[((b1 & 15) << 2) | (b2 >> 6)] : '=';
    result += i+2 < bytes.length ? chars[b2 & 63] : '=';
  }
  return result;
}

// ─── User journey mix ────────────────────────────────────────────────────────
// 30% anonymous browsing (no session = no Redis session hit)
// 70% authenticated session (every request hits Redis for session lookup)

function runTest(baseURL) {
  if (Math.random() < 0.30) {
    anonymousJourney(baseURL);
  } else {
    authenticatedJourney(baseURL);
  }
}

function anonymousJourney(baseURL) {
  group('anonymous', () => {
    // Homepage
    check(http.get(`${baseURL}/`, { timeout: '10s' }), {
      'homepage 200': (r) => r.status === 200,
    });
    sleep(0.5);

    // Explore repos — Postgres: full repo table scan with pagination
    check(http.get(`${baseURL}/explore/repos`, { timeout: '10s' }), {
      'explore repos 200': (r) => r.status === 200,
    });
    sleep(0.5);

    // API repo search — Postgres: FTS or LIKE query
    check(http.get(`${baseURL}/api/v1/repos/search?limit=10&q=test`, { timeout: '10s' }), {
      'api search 200': (r) => r.status === 200,
    });
    sleep(1);
  });
}

function authenticatedJourney(baseURL) {
  group('authenticated', () => {
    // ── Login — creates a Redis session ──────────────────────────────────────
    const loginPage = http.get(`${baseURL}/user/login`, { timeout: '10s' });
    const csrf = extractCSRF(loginPage.body);

    const loginRes = http.post(`${baseURL}/user/login`, {
      _csrf:     csrf,
      user_name: ADMIN_USER,
      password:  ADMIN_PASS,
    }, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      redirects: 5,
      timeout: '10s',
    });

    check(loginRes, {
      'login succeeded': (r) => r.status === 200 && !r.url.includes('user/login'),
    });

    // Capture session cookie — every subsequent request hits Redis to validate it
    const jar = loginRes.cookies;
    const cookies = Object.entries(jar)
      .map(([k, v]) => `${k}=${v[0].value}`)
      .join('; ');
    const sessionHeaders = { Cookie: cookies };

    sleep(0.5);

    // ── Dashboard — authenticated, hits Redis session + Postgres activity feed
    group('dashboard', () => {
      check(http.get(`${baseURL}/`, { headers: sessionHeaders, timeout: '10s' }), {
        'dashboard 200': (r) => r.status === 200,
      });
    });
    sleep(0.5);

    // ── Repository view — Postgres: repo metadata + git data
    group('repo view', () => {
      check(http.get(`${baseURL}/${ADMIN_USER}/${TEST_REPO}`, {
        headers: sessionHeaders, timeout: '10s',
      }), {
        'repo page 200': (r) => r.status === 200,
      });
    });
    sleep(0.5);

    // ── Issue list — Postgres: paginated query on issues table
    group('issue list', () => {
      check(http.get(`${baseURL}/${ADMIN_USER}/${TEST_REPO}/issues`, {
        headers: sessionHeaders, timeout: '10s',
      }), {
        'issues 200': (r) => r.status === 200,
      });
    });
    sleep(0.5);

    // ── API: user repos — authenticated API, Redis session + Postgres
    group('api user repos', () => {
      check(http.get(`${baseURL}/api/v1/user/repos?limit=10`, {
        headers: {
          ...sessionHeaders,
          Authorization: `Basic ${b64(ADMIN_USER + ':' + ADMIN_PASS)}`,
        },
        timeout: '10s',
      }), {
        'api repos 200': (r) => r.status === 200,
      });
    });
    sleep(0.5);

    // ── API: issue listing — Postgres: joins issues + users + labels
    group('api issues', () => {
      check(http.get(`${baseURL}/api/v1/repos/${ADMIN_USER}/${TEST_REPO}/issues?limit=10&type=issues&state=open`, {
        headers: {
          ...sessionHeaders,
          Authorization: `Basic ${b64(ADMIN_USER + ':' + ADMIN_PASS)}`,
        },
        timeout: '10s',
      }), {
        'api issues 200': (r) => r.status === 200,
      });
    });
    sleep(0.5);

    // ── User settings — Redis session validation + Postgres user record
    group('user settings', () => {
      check(http.get(`${baseURL}/user/settings`, {
        headers: sessionHeaders, timeout: '10s',
      }), {
        'settings 200': (r) => r.status === 200,
      });
    });
    sleep(1);

    // ── Logout — destroys Redis session
    group('logout', () => {
      const settingsPage = http.get(`${baseURL}/user/settings`, {
        headers: sessionHeaders, timeout: '10s',
      });
      const logoutCSRF = extractCSRF(settingsPage.body);
      http.post(`${baseURL}/user/logout`, { _csrf: logoutCSRF }, {
        headers: {
          ...sessionHeaders,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        redirects: 3,
        timeout: '10s',
      });
    });
  });
}

function extractCSRF(body) {
  if (!body) return '';
  const match = body.toString().match(/_csrf[^>]+value="([^"]+)"/);
  return match ? match[1] : '';
}

export function testBaseline() { runTest(BASELINE_URL); }
export function testStaging()  { runTest(STAGING_URL);  }
