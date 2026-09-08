// Bounded, closed-loop smoke load. This does not establish production capacity.
import { performance } from 'node:perf_hooks';

const baseUrl = process.env.LOAD_BASE_URL;
if (!baseUrl)
  throw new Error(
    'Set LOAD_BASE_URL to the test API origin, for example http://127.0.0.1:3000.',
  );
const origin = new URL(baseUrl);
const concurrency = Number(process.env.LOAD_CONCURRENCY ?? 10);
const durationSeconds = Number(process.env.LOAD_DURATION_SECONDS ?? 10);
const maxErrorRate = Number(process.env.LOAD_MAX_ERROR_RATE ?? 0.01);
const maxP95 = Number(process.env.LOAD_MAX_P95_MS ?? 1000);
if (
  !Number.isInteger(concurrency) ||
  concurrency < 1 ||
  concurrency > 1000 ||
  !Number.isFinite(durationSeconds) ||
  durationSeconds < 1 ||
  durationSeconds > 3600 ||
  !Number.isFinite(maxErrorRate) ||
  maxErrorRate < 0 ||
  maxErrorRate > 1 ||
  !Number.isFinite(maxP95) ||
  maxP95 <= 0
) {
  throw new Error(
    'Invalid load limits: concurrency 1..1000, duration 1..3600 seconds, error rate 0..1, positive p95 milliseconds.',
  );
}
const paths = (process.env.LOAD_PATHS ?? '/api/health/live').split(',');
const urls = paths.map((path) => {
  const target = new URL(path, origin);
  if (target.origin !== origin.origin)
    throw new Error('Every load path must use LOAD_BASE_URL origin.');
  return target;
});
let requests = 0;
let errors = 0;
let next = 0;
const samples = [];
const statuses = {};
const start = performance.now();
const stop = start + durationSeconds * 1000;
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    while (performance.now() < stop) {
      const target = urls[next++ % urls.length];
      const began = performance.now();
      try {
        const response = await fetch(target, {
          signal: AbortSignal.timeout(5000),
          redirect: 'error',
        });
        await response.arrayBuffer();
        statuses[response.status] = (statuses[response.status] ?? 0) + 1;
        if (!response.ok) errors++;
      } catch {
        errors++;
        statuses.network_error = (statuses.network_error ?? 0) + 1;
      }
      const elapsed = performance.now() - began;
      requests++;
      // Reservoir sampling keeps memory bounded while sampling the whole run.
      if (samples.length < 100000) samples.push(elapsed);
      else {
        const index = Math.floor(Math.random() * requests);
        if (index < samples.length) samples[index] = elapsed;
      }
    }
  }),
);
samples.sort((a, b) => a - b);
const percentile = (p) =>
  samples[Math.max(0, Math.ceil(samples.length * p) - 1)] ?? 0;
const elapsedSeconds = (performance.now() - start) / 1000;
const errorRate = requests ? errors / requests : 1;
const p95 = percentile(0.95);
const passed = requests > 0 && errorRate <= maxErrorRate && p95 <= maxP95;
console.log(
  JSON.stringify(
    {
      kind: 'closed-loop smoke; not capacity proof',
      concurrency,
      elapsedSeconds,
      requests,
      errors,
      errorRate,
      requestsPerSecond: requests / elapsedSeconds,
      latencyMs: { p50: percentile(0.5), p95, p99: percentile(0.99) },
      sampledRequests: samples.length,
      statuses,
      thresholds: { maxErrorRate, maxP95 },
      passed,
    },
    null,
    2,
  ),
);
process.exitCode = passed ? 0 : 1;
