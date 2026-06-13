// JAT v11 — hardware probe → recommended local (Ollama) models.
//
// Picks a model tier the machine can actually run, so a laptop with no GPU gets
// a small fast model and a desktop with a big GPU gets a stronger one. The user
// can always override in Settings; this is just the smart default.

const os = require('os');
const { spawnSync } = require('child_process');
const { scope } = require('./logger');
const log = scope('hardware');

// Model tiers, smallest first. structured = JSON extraction/answers;
// prose = cover letters / free text. Sizes are the rough download footprint.
const TIERS = [
  { id: 'xl',  minVramGb: 16, minRamGb: 48, structured: 'qwen2.5-coder:14b', prose: 'llama3.1:8b',  label: 'Large (14B)', approxGb: 9 },
  { id: 'lg',  minVramGb: 10, minRamGb: 32, structured: 'qwen2.5-coder:7b',  prose: 'llama3.1:8b',  label: 'Standard (7–8B)', approxGb: 5 },
  { id: 'md',  minVramGb: 6,  minRamGb: 16, structured: 'qwen2.5:3b',        prose: 'llama3.2:3b',  label: 'Compact (3B)', approxGb: 2 },
  { id: 'sm',  minVramGb: 0,  minRamGb: 0,  structured: 'qwen2.5:1.5b',      prose: 'llama3.2:3b',  label: 'Light (1.5–3B)', approxGb: 1.5 },
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

function probe() {
  const ramGb = +(os.totalmem() / 1024 ** 3).toFixed(1);
  const vramGb = detectNvidiaVramGb();
  const gpuName = detectGpuName();
  const cores = os.cpus()?.length || 0;
  const tier = TIERS.find((t) => vramGb >= t.minVramGb || ramGb >= t.minRamGb) || TIERS[TIERS.length - 1];
  return {
    ramGb, vramGb, gpuName, cores,
    hasGpu: vramGb > 0,
    recommend: { tier: tier.id, label: tier.label, structured: tier.structured, prose: tier.prose, approxGb: tier.approxGb },
  };
}

module.exports = { probe, TIERS };
