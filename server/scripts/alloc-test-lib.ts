/** Tiny assertion helpers shared by the allocation test scripts. */
let failures = 0;
let passes = 0;

export function check(cond: unknown, msg: string, detail?: unknown) {
  if (cond) {
    passes++;
    if (process.env.VERBOSE) console.log(`PASS  ${msg}`);
  } else {
    failures++;
    console.log(`FAIL  ${msg}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  }
}

export function section(name: string) {
  console.log(`\n── ${name}`);
}

export function summary(name: string): never {
  console.log(`\n${name}: ${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

/** Deterministic PRNG (mulberry32) so tests and benchmarks are repeatable. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
