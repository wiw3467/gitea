import http from 'k6/http';
import { sleep, check, group } from 'k6';
import encoding from 'k6/encoding';
import { browser } from 'k6/browser';

const BASELINE_URL = __ENV.BASELINE_URL || 'http://localhost:30301';
const STAGING_URL  = __ENV.STAGING_URL  || 'http://localhost:30302';

const WARMUP_S   = parseInt(__ENV.WARMUP_S   || '60',  10);
const RAMPUP_S   = parseInt(__ENV.RAMPUP_S   || '30',  10);
const MEASURE_S  = parseInt(__ENV.MEASURE_S  || '120', 10);
const RAMPDOWN_S = parseInt(__ENV.RAMPDOWN_S || '30',  10);
const VUS        = parseInt(__ENV.VUS        || '25',  10);

// Test credentials — seeded by the CI "Seed test data" step, not k6 itself
const ADMIN_USER = 'apia-admin';
const ADMIN_PASS = 'Apia2024!';
const SECOND_USER = 'apia-user2';
const SECOND_PASS = 'Apia2024!';
const USERS = [ADMIN_USER, SECOND_USER];

// Multiple repos with different pre-seeded issue counts (owned by apia-admin,
// same as before) — VUs pick among them instead of all hitting one shared
// repo, so reads exercise more than one cache-friendly row set.
const TEST_REPOS = [
  { name: 'test-repo',   issues: 20 },
  { name: 'test-repo-2', issues: 10 },
  { name: 'test-repo-3', issues: 5  },
];
function pickRepo() { return TEST_REPOS[Math.floor(Math.random() * TEST_REPOS.length)]; }
function pickUser() { return USERS[Math.floor(Math.random() * USERS.length)]; }

const STAGES = [
  { duration: `${WARMUP_S}s`,   target: Math.max(1, Math.floor(VUS * 0.2)) },
  { duration: `${RAMPUP_S}s`,   target: VUS },
  { duration: `${MEASURE_S}s`,  target: VUS },
  { duration: `${RAMPDOWN_S}s`, target: 0   },
];

// Browser scenarios start during the measurement window (after warmup + ramp-up)
const BROWSER_START_S = WARMUP_S + RAMPUP_S;

// k6 only breaks a metric out per-tag in its summary JSON if that exact
// tagged combination is referenced in a threshold — otherwise every
// env-tagged web vital collapses into one combined, undifferentiated
// number, and staging/baseline silently end up comparing against the same
// aliased value. These never fail (any p(95) passes); their only purpose is
// forcing k6 to actually populate the per-environment breakdown.
const CWV_VITALS = ['lcp', 'fcp', 'cls', 'ttfb', 'fid', 'inp'];
const cwvThresholds = {};
for (const vital of CWV_VITALS) {
  cwvThresholds[`browser_web_vital_${vital}{env:staging}`]  = ['p(95)<999999999'];
  cwvThresholds[`browser_web_vital_${vital}{env:baseline}`] = ['p(95)<999999999'];
}

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
    browser_baseline: {
      executor: 'per-vu-iterations',
      exec: 'browserBaseline',
      vus: 2,
      iterations: 8,
      startTime: `${BROWSER_START_S}s`,
      tags: { env: 'baseline' },
      options: { browser: { type: 'chromium' } },
    },
    browser_staging: {
      executor: 'per-vu-iterations',
      exec: 'browserStaging',
      vus: 2,
      iterations: 8,
      startTime: `${BROWSER_START_S}s`,
      tags: { env: 'staging' },
      options: { browser: { type: 'chromium' } },
    },
  },
  thresholds: {
    'http_req_duration{env:staging}':  ['p(95)<2000'],
    'http_req_duration{env:baseline}': ['p(95)<9999999'],
    'http_req_failed{env:staging}':    ['rate<0.05'],
    // These two never fail (count is always >=0) — their only purpose is to
    // make k6 break "iterations" out per scenario in the summary export, so
    // the frontend agent can tell how many browser iterations actually
    // completed on each side instead of only seeing one combined total.
    'iterations{scenario:browser_staging}':  ['count>=0'],
    'iterations{scenario:browser_baseline}': ['count>=0'],
    // p95 blended across successful and failed requests can be misleading: a
    // request that fails fast (e.g. a rejected write on a full cache) counts
    // as a "fast" sample right alongside genuinely healthy ones, so a more
    // broken system can post a LOWER blended p95. Breaking out
    // expected_response:true isolates latency for requests that didn't fail,
    // immune to that distortion. Never fails (any p(95) passes) — its only
    // purpose is forcing k6 to populate this tag combination in the summary.
    'http_req_duration{env:staging,expected_response:true}':  ['p(95)<999999999'],
    'http_req_duration{env:baseline,expected_response:true}': ['p(95)<999999999'],
    ...cwvThresholds,
  },
};

// Test data (repo + issues) is seeded by a dedicated CI step before k6 runs
// (see .github/workflows/apia-validation.yml "Seed test data on both
// environments") — not in a k6 setup() here, so a slow/failed seed fails its
// own step with a clear error instead of corrupting the measurement window.

function runTest(baseURL) {
  const r = Math.random();
  if (r < 0.20) {
    anonymousJourney(baseURL);
  } else if (r < 0.80) {
    authenticatedJourney(baseURL);
  } else {
    writeJourney(baseURL);
  }
}

// Shared login helper — both the read and write journeys authenticate the
// same way, just as different users, so this used to be duplicated inline.
function login(baseURL, username, password) {
  const loginPage = http.get(`${baseURL}/user/login`, { timeout: '10s' });
  const csrf = extractCSRF(loginPage.body);

  const loginRes = http.post(`${baseURL}/user/login`, {
    _csrf:     csrf,
    user_name: username,
    password:  password,
  }, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    redirects: 5,
    timeout: '10s',
  });

  check(loginRes, {
    'login succeeded': (r) => r.status === 200 && !r.url.includes('user/login'),
  });

  const jar = loginRes.cookies;
  const cookies = Object.entries(jar)
    .map(([k, v]) => `${k}=${v[0].value}`)
    .join('; ');
  return { Cookie: cookies };
}

function anonymousJourney(baseURL) {
  group('anonymous', () => {
    // Homepage
    check(http.get(`${baseURL}/`, { timeout: '10s' }), {
      'homepage 200': (r) => r.status === 200,
    });
    sleep(0.5);

    // Explore repos listing
    check(http.get(`${baseURL}/explore/repos`, { timeout: '10s' }), {
      'explore repos 200': (r) => r.status === 200,
    });
    sleep(0.5);

    // API repo search
    check(http.get(`${baseURL}/api/v1/repos/search?limit=10&q=test`, { timeout: '10s' }), {
      'api search 200': (r) => r.status === 200,
    });
    sleep(1);
  });
}

function authenticatedJourney(baseURL) {
  group('authenticated', () => {
    const username = pickUser();
    const sessionHeaders = login(baseURL, username, ADMIN_PASS);
    const repo = pickRepo();

    sleep(0.5);

    group('dashboard', () => {
      check(http.get(`${baseURL}/`, { headers: sessionHeaders, timeout: '10s' }), {
        'dashboard 200': (r) => r.status === 200,
      });
    });
    sleep(0.5);

    group('repo view', () => {
      check(http.get(`${baseURL}/${ADMIN_USER}/${repo.name}`, {
        headers: sessionHeaders, timeout: '10s',
      }), {
        'repo page 200': (r) => r.status === 200,
      });
    });
    sleep(0.5);

    group('issue list', () => {
      check(http.get(`${baseURL}/${ADMIN_USER}/${repo.name}/issues`, {
        headers: sessionHeaders, timeout: '10s',
      }), {
        'issues 200': (r) => r.status === 200,
      });
    });
    sleep(0.5);

    group('api user repos', () => {
      check(http.get(`${baseURL}/api/v1/user/repos?limit=10`, {
        headers: {
          ...sessionHeaders,
          Authorization: `Basic ${encoding.b64encode(username + ':' + ADMIN_PASS)}`,
        },
        timeout: '10s',
      }), {
        'api repos 200': (r) => r.status === 200,
      });
    });
    sleep(0.5);

    group('api issues', () => {
      check(http.get(`${baseURL}/api/v1/repos/${ADMIN_USER}/${repo.name}/issues?limit=10&type=issues&state=open`, {
        headers: {
          ...sessionHeaders,
          Authorization: `Basic ${encoding.b64encode(username + ':' + ADMIN_PASS)}`,
        },
        timeout: '10s',
      }), {
        'api issues 200': (r) => r.status === 200,
      });
    });
    sleep(0.5);

    group('user settings', () => {
      check(http.get(`${baseURL}/user/settings`, {
        headers: sessionHeaders, timeout: '10s',
      }), {
        'settings 200': (r) => r.status === 200,
      });
    });
    sleep(1);
  });
}

// Write-heavy journey — the previous test was 100% reads (bar the login
// POST), which meant a real connection-pool/lock-contention regression on
// the write path had nothing to actually exercise it. This creates an
// issue and comments on an existing one, under a randomly picked user
// against a randomly picked repo, so writes land on varied rows too.
function writeJourney(baseURL) {
  group('write', () => {
    const username = pickUser();
    const sessionHeaders = login(baseURL, username, ADMIN_PASS);
    const repo = pickRepo();
    const authHeaders = {
      ...sessionHeaders,
      Authorization: `Basic ${encoding.b64encode(username + ':' + ADMIN_PASS)}`,
      'Content-Type': 'application/json',
    };

    sleep(0.3);

    group('create issue', () => {
      const n = Math.floor(Math.random() * 10000);
      check(http.post(`${baseURL}/api/v1/repos/${ADMIN_USER}/${repo.name}/issues`,
        JSON.stringify({ title: `Load-test issue ${n}`, body: `Created by ${username} during load test.` }),
        { headers: authHeaders, timeout: '10s' }), {
        'create issue 201': (r) => r.status === 201,
      });
    });
    sleep(0.3);

    group('comment on issue', () => {
      const issueIndex = 1 + Math.floor(Math.random() * repo.issues);
      check(http.post(`${baseURL}/api/v1/repos/${ADMIN_USER}/${repo.name}/issues/${issueIndex}/comments`,
        JSON.stringify({ body: `Comment from ${username} during load test.` }),
        { headers: authHeaders, timeout: '10s' }), {
        'comment 201': (r) => r.status === 201,
      });
    });
    sleep(0.5);
  });
}

function extractCSRF(body) {
  if (!body) return '';
  const s = body.toString();
  // Gitea >= 1.20 puts CSRF in a <meta> tag
  let m = s.match(/<meta\s+name="_csrf"\s+content="([^"]+)"/);
  if (m) return m[1];
  // Fallback: hidden input, value before or after name
  m = s.match(/name="_csrf"[^>]*value="([^"]+)"/);
  if (m) return m[1];
  m = s.match(/value="([^"]+)"[^>]*name="_csrf"/);
  if (m) return m[1];
  return '';
}

export function testBaseline() { runTest(BASELINE_URL); }
export function testStaging()  { runTest(STAGING_URL);  }

// ── Browser scenarios — Core Web Vitals collection ────────────────────────────

const BROWSER_PAGES = ['/', '/user/login', '/explore/repos'];

async function runBrowser(baseURL) {
  const context = await browser.newContext();
  try {
    for (const path of BROWSER_PAGES) {
      const page = await context.newPage();
      try {
        await page.goto(baseURL + path, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(1000); // let CWV settle
      } catch (_) {
        // page errors don't fail the scenario — CWV collected up to the error
      } finally {
        await page.close();
      }
      sleep(1);
    }
  } finally {
    await context.close();
  }
}

export async function browserBaseline() { await runBrowser(BASELINE_URL); }
export async function browserStaging()  { await runBrowser(STAGING_URL);  }
