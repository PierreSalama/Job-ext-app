// Resource sampler.
//
// "the app destroys my pc and its cpu and how its laggy and glitchy" has been reported repeatedly
// and has survived several attempts to fix it, because NOTHING in the app records resource usage.
// Every attempt so far has been a hypothesis with no measurement behind it, and two of them were
// tested and turned out to be wrong:
//
//   • "orphaned Python discovery workers are pinning the CPU" — the long-lived python processes on
//     this machine (272 CPU-seconds each, ~19h old) belong to a Claude Desktop MCP extension,
//     not to JAT. JAT was not even running.
//   • "child.kill() leaks the py→python grandchild on Windows" — there IS a grandchild, but a
//     direct kill cleaned it up. Verified, not assumed.
//
// So this file does not fix the CPU problem. It makes the NEXT run produce evidence instead of a
// feeling: which process type is burning CPU (main vs renderer vs GPU vs utility), how many
// discovery workers are alive, and what the app was doing at the time.
//
// Cost discipline: one sample every SAMPLE_MS, a handful of rows, retention bounded by the caller.
// getAppMetrics() is a synchronous Electron call over already-collected counters — cheap — but it
// is still only taken on the interval, never per-event.

const SAMPLE_MS = 20_000;

// percentCPUUsage is "percent of ONE core" in Electron, and can exceed 100 for a busy
// multi-threaded process. Keep it as reported and let the reader divide by core count.
function summarizeMetrics(metrics) {
  const byType = new Map();
  let totalCpu = 0;
  let totalMemMB = 0;
  for (const m of Array.isArray(metrics) ? metrics : []) {
    const type = String(m?.type || 'unknown');
    const cpu = Number(m?.cpu?.percentCPUUsage) || 0;
    // working set is in KB on every platform Electron reports
    const memMB = Math.round((Number(m?.memory?.workingSetSize) || 0) / 1024);
    const cur = byType.get(type) || { type, count: 0, cpu: 0, memMB: 0 };
    cur.count += 1; cur.cpu += cpu; cur.memMB += memMB;
    byType.set(type, cur);
    totalCpu += cpu; totalMemMB += memMB;
  }
  const parts = [...byType.values()].map((p) => ({ ...p, cpu: Math.round(p.cpu * 10) / 10 }))
    .sort((a, b) => b.cpu - a.cpu);
  return {
    totalCpu: Math.round(totalCpu * 10) / 10,
    totalMemMB,
    procCount: (Array.isArray(metrics) ? metrics : []).length,
    // The whole point of the breakdown: it names the culprit instead of blaming "the app".
    topType: parts.length ? parts[0].type : null,
    byType: parts,
  };
}

// `deps` is injected so this is testable with no Electron and no DB.
function createPerfSampler({ getAppMetrics, record, activeChildCount, applyState, log, intervalMs = SAMPLE_MS } = {}) {
  let timer = null;

  function sampleOnce() {
    try {
      const metrics = typeof getAppMetrics === 'function' ? getAppMetrics() : [];
      const s = summarizeMetrics(metrics);
      const row = {
        at: new Date().toISOString(),
        cpuPercent: s.totalCpu,
        memMB: s.totalMemMB,
        procCount: s.procCount,
        topType: s.topType,
        // A discovery worker still alive across many samples is the orphan signature we could not
        // previously see; a count that only rises is the leak.
        workers: typeof activeChildCount === 'function' ? (Number(activeChildCount()) || 0) : 0,
        state: typeof applyState === 'function' ? String(applyState() || '') : '',
        detail: JSON.stringify(s.byType),
      };
      if (typeof record === 'function') record(row);
      return row;
    } catch (e) {
      try { log?.warn?.('perf sample failed:', e?.message || e); } catch {}
      return null;
    }
  }

  return {
    sampleOnce,
    start() {
      if (timer) return;
      timer = setInterval(sampleOnce, intervalMs);
      // Never hold the process open just to take a measurement.
      if (typeof timer.unref === 'function') timer.unref();
      try { log?.info?.(`perf sampler started (every ${Math.round(intervalMs / 1000)}s)`); } catch {}
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
    get running() { return !!timer; },
  };
}

module.exports = { createPerfSampler, summarizeMetrics, SAMPLE_MS };
