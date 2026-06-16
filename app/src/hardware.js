// JAT v11 — hardware probe → recommended local (Ollama) models.
//
// Picks a model tier the machine can actually run, so a laptop with no GPU gets
// a small fast model and a desktop with a big GPU gets a stronger one. The user
// can always override in Settings; this is just the smart default.

const os = require('os');
const { spawnSync } = require('child_process');
const { scope } = require('./logger');
const log = scope('hardware');

// Model tiers, smallest first.
//   structured = JSON extraction / form answers — kept on the PROVEN Qwen/Llama
//                family (Pierre's locked decision: do NOT swap Qwen out of the
//                structured-JSON path; it's battle-tested for the `format` schema).
//   prose      = cover letters / free text — a Gemma size for the tier (P4): Gemma
//                writes warmer, more natural prose, so it owns ONLY the prose lane.
// Sizes are the rough combined download footprint for the tier's two models.
const TIERS = [
  { id: 'xl',  minVramGb: 16, minRamGb: 48, structured: 'qwen2.5-coder:14b', prose: 'gemma2:9b',     label: 'Large (14B / Gemma 9B prose)', approxGb: 14 },
  { id: 'lg',  minVramGb: 10, minRamGb: 32, structured: 'qwen2.5-coder:7b',  prose: 'gemma3:4b',     label: 'Standard (7B / Gemma 4B prose)', approxGb: 8 },
  { id: 'md',  minVramGb: 6,  minRamGb: 16, structured: 'qwen2.5:3b',        prose: 'gemma2:2b',     label: 'Compact (3B / Gemma 2B prose)', approxGb: 4 },
  { id: 'sm',  minVramGb: 0,  minRamGb: 0,  structured: 'qwen2.5:1.5b',      prose: 'gemma3:1b',     label: 'Light (1.5B / Gemma 1B prose)', approxGb: 2.5 },
];

function detectNvidiaVramGb() {
  try {
    const r = spawnSync('nvidia-smi', ['--query-gpu=memory.total', '--format=csv,noheader,nounits'],
      { encoding: 'utf8', timeout: 4000, windowsHide: true });
    if (r.status === 0 && r.stdout) {
      const mb = Math.max(...r.stdout.split(/\r?\n/).map((l) => parseInt(l.trim(), 10)).filter((n) => Number.isFinite(n)));
      if (Number.isFinite(mb) && mb > 0) return +(mb / 1024).toFixed(1);
    }
  } catch {}
  return 0;
}

// Best-effort GPU name (Windows) for display only.
function detectGpuName() {
  try {
    const r = spawnSync('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], { encoding: 'utf8', timeout: 4000, windowsHide: true });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.split(/\r?\n/)[0].trim();
  } catch {}
  if (process.platform === 'win32') {
    try {
      const r = spawnSync('wmic', ['path', 'win32_VideoController', 'get', 'name'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
      if (r.status === 0) {
        const line = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && s !== 'Name')[0];
        if (line) return line;
      }
    } catch {}
  }
  return '';
}

// Find the tier this machine can run. No GPU and low RAM → the smallest tier
// (Dad's laptop): smallest Qwen for structured + smallest Gemma for prose.
function tierFor(vramGb, ramGb) {
  return TIERS.find((t) => vramGb >= t.minVramGb || ramGb >= t.minRamGb) || TIERS[TIERS.length - 1];
}

function probe() {
  const ramGb = +(os.totalmem() / 1024 ** 3).toFixed(1);
  const vramGb = detectNvidiaVramGb();
  const gpuName = detectGpuName();
  const cores = os.cpus()?.length || 0;
  const tier = tierFor(vramGb, ramGb);
  return {
    ramGb, vramGb, gpuName, cores,
    hasGpu: vramGb > 0,
    recommend: { tier: tier.id, label: tier.label, structured: tier.structured, prose: tier.prose, approxGb: tier.approxGb },
  };
}

// {structuredModel, proseModel} for the detected (or forced) tier, honoring user
// overrides. `override.tier` pins a tier; override.structuredModel/proseModel pin a
// model outright (Settings can always beat the auto-pick). Pure — safe with no GPU.
function recommendModels(override = {}) {
  let tier;
  if (override.tier) tier = TIERS.find((t) => t.id === override.tier);
  if (!tier) { const h = probe(); tier = TIERS.find((t) => t.id === h.recommend.tier) || TIERS[TIERS.length - 1]; }
  return {
    tier: tier.id,
    structuredModel: override.structuredModel || tier.structured,
    proseModel: override.proseModel || tier.prose,
    approxGb: tier.approxGb,
  };
}

module.exports = { probe, recommendModels, tierFor, TIERS };
