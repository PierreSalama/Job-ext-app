// FIND EVERY CANADIAN COMPANY WHOSE ATS THE DISCOVERY LANE CAN ACTUALLY READ.
//
// Greenhouse, Ashby and Lever all publish plain JSON job boards: no login, no Cloudflare, no bot
// challenge, no pacing floor. Measured 2026-09-08, that is the ONLY discovery path still working —
// LinkedIn's scraper broke on 3 September and Indeed now serves Cloudflare to both the extension
// and the AI agent.
//
// The shipped seed list is 153 tokens and reads like a US tech index: Databricks, OpenAI, Stripe,
// Palantir, Datadog, Spotify, Waymo. Pierre is a Canadian citizen who needs sponsorship for
// American roles, so most of it is unusable to him. A first pass of ~100 Canadian candidates found
// 22 live boards carrying 103 Canadian software roles. This is that pass, widened.
//
// AN ATS TOKEN IS A GUESS UNTIL IT RESOLVES. A wrong one 404s silently and is indistinguishable
// from a company with no openings, so nothing here is trusted until the live API answers. Common
// token shapes are tried for each name (plain, dashed, suffixed) because companies are inconsistent
// about it — 'lightspeed' is dead, 'lightspeedhq' has 153 jobs.
//
// Read-only. Public endpoints, no auth, no writes to anything.
//
//   node probe-ca-boards.mjs               probe everything, print the seed JSON
//   node probe-ca-boards.mjs --all         also list boards that resolved with zero CA software roles

const SHOW_ALL = process.argv.includes('--all');

// Canadian tech employers, by region. Names only — token shapes are derived below.
const NAMES = [
  // Toronto / GTA
  'shopify', 'wealthsimple', 'faire', 'ada', 'clio', 'jobber', 'float', '1password', 'wattpad',
  'league', 'pointclickcare', 'tophat', 'knix', 'nuvei', 'flipp', 'ritual', 'docebo', 'method-crm',
  'wave', 'waveapps', 'borrowell', 'koho', 'neofinancial', 'mejuri', 'ecobee', 'influitive',
  'achievers', 'verafin', 'axonify', 'bluecat', 'd2l', 'kira', 'assent', 'rangle', 'q4inc',
  'securekey', 'sensibill', 'drop', 'properly', 'wattpadcorp', 'thescore', 'scoremediaandgaming',
  'intelex', 'vena', 'venasolutions', 'loopio', 'fiix', 'kobo', 'rakutenkobo', 'pagerduty',
  'sortable', 'plum', 'hopper', 'sunlife', 'manulife', 'rbc', 'td', 'cibc', 'scotiabank',
  'shopify-eng', 'uberflip', 'jane', 'janeapp', 'nudge', 'bitesize', 'certn', 'trulioo',
  'financeit', 'flexiti', 'paymentsource', 'clearco', 'clearbanc', 'wagepoint', 'humi', 'collage',
  'rewind', 'buildwithrewind', 'clutch', 'clutchcanada', 'goeasy', 'ada-support', 'adasupport',
  'stackadapt', 'adgear', 'sharethrough', 'unity', 'unity3d', 'behaviour', 'behaviourinteractive',
  'shoplogix', 'geotab', 'trellis', 'coconut', 'coconutsoftware', 'wysdom', 'integrate',
  'symcor', 'moneris', 'interac', 'payfirma', 'zafin', 'dye-durham', 'dyedurham',
  // Waterloo / Kitchener / Guelph / Cambridge
  'kinaxis', 'miovision', 'magnetforensics', 'auvik', 'arcticwolf', 'vidyard', 'axonify-wl',
  'descartes', 'opentext', 'sandvine', 'igloo', 'igloosoftware', 'clearpath', 'clearpathrobotics',
  'alertlabs', 'bridgit', 'faceddrive', 'northstar', 'vertex', 'encircle', 'voltera',
  // Ottawa
  'shopifyottawa', 'kinaxis-ott', 'fullscript', 'assentcompliance', 'klipfolio', 'you-i',
  'martello', 'solace', 'ross', 'rossvideo', 'mitel', 'corel', 'calian', 'nokia-ca',
  // Montreal
  'lightspeedhq', 'lightspeed', 'coveo', 'sonder', 'dialogue', 'workleap', 'gsoft', 'ssense',
  'busbud', 'potloc', 'nectar', 'hopper-mtl', 'element-ai', 'sampler', 'breather', 'poka',
  'sharethrough-mtl', 'lion', 'lionelectric', 'stingray', 'nuvei-mtl', 'genetec', 'matrox',
  'ubisoft', 'eidos', 'gameloft', 'framestore', 'moment-factory', 'momentfactory', 'osedea',
  'novisto', 'flinks', 'hardbacon', 'mnubo', 'lightspeed-commerce', 'aifi', 'imagia',
  // Vancouver / Victoria
  'hootsuite', 'thinkific', 'unbounce', 'visier', 'galvanize', 'copperleaf', 'article', 'dapper',
  'dapperlabs', 'bench', 'benchaccounting', 'later', 'trulioo-van', 'clio-van', 'jane-van',
  'aspect', 'aspectbiosystems', 'semios', 'terramera', 'klue', 'dooly', 'procurify', 'rooof',
  'certn-van', 'chec', 'fullscript-van', 'appnovation', 'slack-van', 'mobify', 'bananatag',
  'redbrick', 'checkfront', 'pretio', 'tutela', 'giftbit', 'freshworks-ca', 'sendwithus',
  // Calgary / Edmonton / Prairies
  'benevity', 'symend', 'attabotics', 'showpass', 'zylo', 'circlecardiovascular', 'circle-cvi',
  'jobber-yyc', 'helcim', 'neo', 'rainforest', 'absorblms', 'absorb', 'solium', 'shareworks',
  'drivewyze', 'jobbercalgary', 'pixieset', 'granify', 'jobber-ab', 'samdesk', 'bioware',
  'intellimedia', 'showbie', 'jobsite', 'vendasta', 'coconut-sk', '7shifts', 'sedin',
  // Atlantic
  'verafin-nl', 'introhive', 'siftmed', 'kognitiv', 'proposify', 'metamaterial', 'spring',
  'dash-hudson', 'dashhudson', 'manifold', 'salesforce-ca', 'redspace',
  // Second sweep, 11 September. The first 259 names yielded 32 live boards and those drained in
  // three days at his seniority cap, so the list has to be wider rather than the filters looser.
  'ada', 'axonify', 'bold', 'boldcommerce', 'cohereinc', 'float', 'fellow', 'fellowapp', 'guusto',
  'jane', 'knak', 'lane', 'maple', 'getmaple', 'mysa', 'nuvei', 'paystone', 'pigment', 'relay',
  'relayfi', 'roadmunk', 'rose', 'routific', 'securiti', 'sonder', 'spare', 'sparelabs', 'swiftly',
  'tealbook', 'tenstorrent', 'thinkon', 'tulip', 'tulipretail', 'twenty', 'validere', 'vidyard',
  'waabi', 'wealthfront', 'wonder', 'xanadu', 'zenhub', 'zoomer', 'alayacare', 'aterica',
  'blockchain', 'builddirect', 'canalyst', 'certn', 'clearbanc', 'clearpath', 'collectivehealth',
  'covalent', 'crowdriff', 'cyclica', 'deeplite', 'dialpad', 'ecclesia', 'eddyfi', 'enkel',
  'flipgive', 'forma', 'gatekeeper', 'giatec', 'goodlawyer', 'hiring', 'hopper', 'hubdoc',
  'humi', 'inovia', 'intellabridge', 'jobber', 'kognitiv', 'ledgy', 'legalzoom', 'lendesk',
  'level', 'lightspeed', 'looksharp', 'mejuri', 'metalab', 'mobsquad', 'nicoya', 'notch',
  'novatek', 'null', 'offerland', 'onepassword', 'opensesame', 'parsable', 'peraso', 'phoenix',
  'plooto', 'prodigygame', 'prodigy', 'quandri', 'questrade', 'ramp', 'rewind', 'ritual',
  'roofr', 'rune', 'sampler', 'securekey', 'shakepay', 'shopify', 'sigma', 'snapcommerce',
  'sproutly', 'stacked', 'stampede', 'stripe', 'symend', 'synthesis', 'tehama', 'tenstorrentinc',
  'thentia', 'tiny', 'top', 'trackunit', 'unbounce', 'unito', 'uplimit', 'vention', 'verto',
  'vise', 'voiceflow', 'vosker', 'wealthsimpletech', 'wellfound', 'wiser', 'xero', 'yourbank',
  'zafin', 'zensurance', 'zerofailed', 'league', 'coconutsoftware', 'buildwithrewind',
  'clio', 'trulioo', 'benevity', 'procurify', 'klue', 'dooly', 'visier', 'thinkific',
  'article', 'bench', 'later', 'appnovation', 'geotab', 'stackadapt', '7shifts', 'osedea',
  // Canada-heavy globals worth keeping
  'cohere', 'sierra', 'elevenlabs', 'wealthsimple-tech', 'faire-ca', 'ada-cx',
];

// The shapes companies actually use. Deduped, so a name that is already dashed is not re-dashed.
function tokensFor(name) {
  const base = name.toLowerCase().replace(/[^a-z0-9-]/g, '');
  return [...new Set([base, base.replace(/-/g, ''), `${base}inc`, `${base}-careers`])];
}

const CA = /\b(canada|canadian|toronto|ontario|montr|quebec|québec|vancouver|calgary|ottawa|waterloo|kitchener|cambridge|mississauga|edmonton|halifax|winnipeg|victoria|alberta|saskat|remote[- ]?ca)\b/i;
// Deliberately the same shape as role-fit.mjs, kept local so this file stays standalone.
const SOFTWARE = /\b(software|developer|développeu|full[- ]?stack|fullstack|front[- ]?end|back[- ]?end|web|platform|product engineer|react|node|typescript|javascript|python|rust|application (developer|engineer))\b/i;
const DENY = /\b(structural|civil|mechanical|electrical|cnc|machinist|manufacturing|intern|co-?op|principal|staff engineer|director|head of|architect|account executive|sales)\b/i;
// Pierre keeps seniorityMax at 'mid', so a Senior-titled role will be rejected by his own ingest.
// Count them separately rather than pretending they are reachable.
const SENIOR = /\b(senior|sr\.?|staff|lead|principal|manager)\b/i;

const BOARDS = {
  greenhouse: {
    url: (t) => `https://boards-api.greenhouse.io/v1/boards/${t}/jobs`,
    jobs: (j) => (j && Array.isArray(j.jobs)) ? j.jobs.map((x) => ({ title: x.title, loc: (x.location && x.location.name) || '' })) : null,
  },
  ashby: {
    url: (t) => `https://api.ashbyhq.com/posting-api/job-board/${t}`,
    jobs: (j) => (j && Array.isArray(j.jobs)) ? j.jobs.map((x) => ({ title: x.title, loc: x.location || '' })) : null,
  },
  lever: {
    url: (t) => `https://api.lever.co/v0/postings/${t}?mode=json`,
    jobs: (j) => Array.isArray(j) ? j.map((x) => ({ title: x.text, loc: (x.categories && x.categories.location) || '' })) : null,
  },
};

async function getJson(url) {
  const c = new AbortController();
  const timer = setTimeout(() => c.abort(), 10000);
  try {
    const r = await fetch(url, { signal: c.signal, headers: { 'user-agent': 'jat-seed-probe' } });
    return r.ok ? await r.json() : null;
  } catch { return null; } finally { clearTimeout(timer); }
}

// One work item per (token, board). Run them with bounded concurrency: 900-odd sequential requests
// at ~400ms each is six minutes of waiting for no reason.
const WORK = [];
const seen = new Set();
for (const name of NAMES) {
  for (const token of tokensFor(name)) {
    for (const board of Object.keys(BOARDS)) {
      const key = `${board}:${token}`;
      if (seen.has(key)) continue;
      seen.add(key);
      WORK.push({ board, token });
    }
  }
}

const hits = [];
let done = 0;
const CONCURRENCY = 12;

async function worker() {
  for (;;) {
    const item = WORK.shift();
    if (!item) return;
    const spec = BOARDS[item.board];
    const data = await getJson(spec.url(item.token));
    done++;
    const jobs = data ? spec.jobs(data) : null;
    if (!jobs || !jobs.length) continue;
    const ca = jobs.filter((j) => j.title && CA.test(j.loc));
    const soft = ca.filter((j) => SOFTWARE.test(j.title) && !DENY.test(j.title));
    const atLevel = soft.filter((j) => !SENIOR.test(j.title));
    hits.push({ ...item, total: jobs.length, ca: ca.length, soft: soft.length, atLevel: atLevel.length,
      sample: atLevel.slice(0, 2).map((j) => j.title) });
  }
}

console.log(`probing ${WORK.length} endpoints across ${NAMES.length} companies...\n`);
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

// A company can answer on more than one shape ('lightspeed' and 'lightspeedhq'); keep the richer.
const best = new Map();
for (const h of hits) {
  const k = h.token.replace(/-|inc$|careers$/g, '');
  const cur = best.get(k);
  if (!cur || h.soft > cur.soft || (h.soft === cur.soft && h.total > cur.total)) best.set(k, h);
}

const all = [...best.values()].sort((a, b) => b.atLevel - a.atLevel || b.soft - a.soft);
const useful = all.filter((h) => h.soft > 0);

console.log(`${done} endpoints probed, ${hits.length} boards answered, ${best.size} distinct companies\n`);
console.log('=== BOARDS WITH CANADIAN SOFTWARE ROLES ===');
console.log('at-level = would survive seniorityMax:"mid"\n');
console.log('  soft  at-level  board       token');
for (const h of (SHOW_ALL ? all : useful)) {
  console.log(`  ${String(h.soft).padStart(4)}  ${String(h.atLevel).padStart(8)}  ${h.board.padEnd(11)} ${h.token.padEnd(22)} ${h.sample.join(' | ').slice(0, 52)}`);
}

const soft = useful.reduce((n, h) => n + h.soft, 0);
const lvl = useful.reduce((n, h) => n + h.atLevel, 0);
console.log(`\n${useful.length} companies · ${soft} Canadian software roles · ${lvl} of them at Pierre's level cap`);
console.log('\nseed JSON:');
console.log(JSON.stringify(useful.map((h) => ({ ats: h.board, token: h.token }))));
