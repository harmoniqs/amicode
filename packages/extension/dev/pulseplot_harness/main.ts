// Pulseplot dev harness (#66) — standalone browser page for iterating on the
// component's visuals and measuring the AC8 render budget. NOT shipped in the
// VSIX (dev/ is excluded; see .vscodeignore). Run: `pnpm run dev:pulseplot`.
//
// Feeds the component synthetic solve-like data by default; drop a recorded
// `pulse-events.json` (array of pulsemeta/pulse message objects, produced from
// a real run.log) next to index.html to replay a real solve.

import { pulseplot } from "../../media/ui/components/pulseplot";

const HARNESS_META = {
  drives: 2,
  knots: 50,
  labels: ["a_1", "a_2"],
  bounds: [
    [-0.2, 0.2],
    [-0.2, 0.2],
  ] as [number, number][],
};

const root = document.getElementById("plot-host")!;
const plot = pulseplot("Harness idle — press play.");
root.append(plot.el);

// --- synthetic data: smooth random-walk pulses converging toward a waveform
function syntheticRecord(iter: number): { iter: number; dt: number; values: number[][] } {
  const { knots, drives, bounds } = HARNESS_META;
  const dt = 10.0 / knots;
  const values = Array.from({ length: drives }, (_, d) => {
    const [lo, hi] = bounds[d];
    const amp = (hi - lo) / 2;
    return Array.from({ length: knots }, (_, k) => {
      const t = k / knots;
      const target = amp * 0.85 * Math.sin((d + 1) * Math.PI * t * 2) * Math.sin(Math.PI * t);
      const noise = amp * Math.max(0, 1 - iter / 40) * (Math.random() - 0.5);
      return target + noise;
    });
  });
  return { iter, dt, values };
}

// --- controls
const themeBtn = document.getElementById("theme")!;
themeBtn.addEventListener("click", () => document.body.classList.toggle("dark"));

let timer: ReturnType<typeof setInterval> | undefined;
let iter = 0;
const playBtn = document.getElementById("play")!;
playBtn.addEventListener("click", () => {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
    playBtn.textContent = "▶ play";
    return;
  }
  plot.meta(HARNESS_META);
  playBtn.textContent = "⏸ pause";
  timer = setInterval(() => {
    plot.update(syntheticRecord(iter++));
    if (iter > 60) iter = 0;
  }, 200); // the host's 5 Hz cadence
});

document.getElementById("clear")!.addEventListener("click", () => {
  plot.clear();
  iter = 0;
});

// --- AC8 budget: median + p95 of component update at fixture scale
document.getElementById("bench")!.addEventListener("click", () => {
  plot.meta(HARNESS_META);
  const times: number[] = [];
  for (let i = 0; i < 300; i++) {
    const rec = syntheticRecord(i % 60);
    const t0 = performance.now();
    plot.update(rec);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const med = times[150].toFixed(3),
    p95 = times[285].toFixed(3),
    max = times[299].toFixed(3);
  const verdict = times[285] <= 16 ? "PASS (≤16ms)" : "FAIL (>16ms)";
  document.getElementById("bench-out")!.textContent =
    `update() over 300 frames @ 2×50: median ${med}ms · p95 ${p95}ms · max ${max}ms → ${verdict}`;
  console.log("[bench]", { med, p95, max, verdict });
});

// --- optional recorded replay
fetch("./pulse-events.json")
  .then((r) => (r.ok ? r.json() : undefined))
  .then((events?: Array<Record<string, unknown>>) => {
    if (!events) return;
    const btn = document.createElement("button");
    btn.textContent = "▶ replay recording";
    btn.addEventListener("click", () => {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      let i = 0;
      timer = setInterval(() => {
        const e = events[i++];
        if (!e) {
          clearInterval(timer!);
          timer = undefined;
          return;
        }
        if (e.type === "pulsemeta") plot.meta(e as never);
        else if (e.type === "pulse") plot.update(e as never);
      }, 200);
    });
    document.getElementById("controls")!.append(btn);
  });

// --- URL-hash automation for headless-ish eyeballing: #autoplay #bench #dark
if (location.hash.includes("dark")) document.body.classList.add("dark");
if (location.hash.includes("autoplay")) (document.getElementById("play") as HTMLButtonElement).click();
if (location.hash.includes("bench"))
  setTimeout(() => (document.getElementById("bench") as HTMLButtonElement).click(), 800);
