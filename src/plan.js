"use strict";
/*
 * Decides which recorded frame goes into each frame of the exported video:
 * speeding up (or stretching) to the target length, the optional
 * "finished drawing" intro, the hold at the end, and the ending slow-down.
 * Pure logic — no Photoshop APIs.
 */

const AUTO_MIN_SEC = 5;    // Auto never makes a video shorter than this...
const AUTO_MAX_SEC = 60;   // ...or longer than this.

// Ending slow-down: the last SLOW_FROM share of the timelapse eases down to
// SLOW_TO of full speed.
const SLOW_FROM = 0.75;
const SLOW_TO = 0.2;

// Auto length: every recorded frame shown once, capped at AUTO_MAX_SEC.
function autoSeconds(frameCount, fps) {
  return Math.min(AUTO_MAX_SEC, Math.max(AUTO_MIN_SEC, frameCount / fps));
}

function smoothstep(t) { return t * t * (3 - 2 * t); }

// Maps playback time u (0..1) to recording progress (0..1).
function makeWarp(slowEnd) {
  if (!slowEnd) return (u) => u;
  const N = 2000;
  const speed = (u) => u < SLOW_FROM ? 1 : 1 - (1 - SLOW_TO) * smoothstep((u - SLOW_FROM) / (1 - SLOW_FROM));
  const table = new Float64Array(N + 1);
  let acc = 0;
  for (let i = 1; i <= N; i++) {
    acc += (speed((i - 1) / N) + speed(i / N)) / (2 * N);
    table[i] = acc;
  }
  for (let i = 0; i <= N; i++) table[i] /= acc;
  return (u) => {
    const x = Math.min(1, Math.max(0, u)) * N;
    const i = Math.min(N - 1, Math.floor(x));
    return table[i] + (table[i + 1] - table[i]) * (x - i);
  };
}

// White-flash strength per frame: a quick rise to white, then a fade back
// down to the final image.
function flashCurve(fps) {
  const up = Math.max(2, Math.round(fps * 0.1));
  const down = Math.max(4, Math.round(fps * 0.5));
  const a = [];
  for (let i = 1; i <= up; i++) a.push(i / up);
  for (let i = 1; i <= down; i++) a.push(1 - i / down);
  return a;
}

/**
 * @param {number} frameCount  recorded frames available (>= 1)
 * @param {{fps:number, lengthSec:(number|"auto"), introSec:number, flash:boolean, holdSec:number, slowEnd:boolean}} o
 *        introSec / holdSec of 0 turn that part off.
 */
function planExport(frameCount, o) {
  const fps = o.fps;
  const mainSec = o.lengthSec === "auto" ? autoSeconds(frameCount, fps) : Number(o.lengthSec);
  const mainCount = Math.max(1, Math.round(mainSec * fps));
  const warp = makeWarp(!!o.slowEnd);
  const last = frameCount - 1;
  const main = new Int32Array(mainCount);
  for (let j = 0; j < mainCount; j++) {
    const u = mainCount === 1 ? 1 : j / (mainCount - 1);
    main[j] = Math.min(last, Math.max(0, Math.round(warp(u) * last)));
  }
  const intro = o.introSec > 0 ? Math.max(1, Math.round(o.introSec * fps)) : 0;
  const flash = o.flash ? flashCurve(fps) : [];
  const hold = o.holdSec > 0 ? Math.max(1, Math.round(o.holdSec * fps)) : 0;
  const total = intro + mainCount + flash.length + hold;
  return {
    fps, intro, hold, main, total, flash: flash.length,
    seconds: total / fps,
    // Which recorded frame (and which part) output frame k shows.
    at(k) {
      if (k < intro) return { src: last, part: "intro", white: 0 };
      k -= intro;
      if (k < mainCount) return { src: main[k], part: "main", white: 0 };
      k -= mainCount;
      if (k < flash.length) return { src: last, part: "flash", white: flash[k] };
      return { src: last, part: "hold", white: 0 };
    }
  };
}

module.exports = { planExport, autoSeconds, AUTO_MIN_SEC, AUTO_MAX_SEC };
