/* WOD DRAGON engine tests — node --test tests/
   Scenarios come from real gym programming (see Scheme-Catalog.md):
   "Jackie Brown", "Murph", "No Rain", "Beatrix Kiddo", the 2026-05-24 3-station EMOM.
*/
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const E = require('../engine.js');

const T0 = 1_000_000_000; // arbitrary wall-clock epoch ms
const CUES_ALL = { sound: true, vibrate: true, endCountdown: true, startBlast: true, halfway: true };
const CUES_NONE = { sound: false, vibrate: false, endCountdown: false, startBlast: false, halfway: false };

/** Simulate a run with a fixed tick interval; collect transitions, cues, frames. */
function simulate(run, { tickMs = 100, maxSec = 4000, onFrame } = {}) {
  const out = { transitions: [], cues: [], finishedAt: null, frames: 0 };
  let t = T0;
  E.start(run, t);
  for (let i = 0; i < (maxSec * 1000) / tickMs; i++) {
    t += tickMs;
    const f = E.tick(run, t);
    out.frames++;
    if (f.status === 'finished') { out.finishedAt = (t - T0) / 1000; break; }
    if (f.transitioned) out.transitions.push({ at: (t - T0) / 1000, label: f.seg.label, kind: f.seg.kind, station: f.seg.station });
    for (const c of E.evalCues(run, f)) out.cues.push({ at: (t - T0) / 1000, ...c });
    if (onFrame) onFrame(f, t);
  }
  return out;
}

// ---------------------------------------------------------------------------
// ENOM — "Jackie Brown": Every 2:00 x 8 Sets (single station work)
// ---------------------------------------------------------------------------
test('ENOM 2:00 x 8 (Jackie Brown): segment count, rounds, exact finish', () => {
  const run = E.createRun('enmom', { intervalSec: 120, sets: 8, stations: [] }, CUES_NONE, 10);
  assert.equal(run.segments.length, 9); // lead-in + 8
  assert.equal(run.segments[0].kind, 'countdown');
  assert.deepEqual(run.segments.slice(1).map(s => s.label),
    [1,2,3,4,5,6,7,8].map(n => `ROUND ${n}/8`));
  const sim = simulate(run);
  assert.equal(sim.finishedAt, 10 + 8 * 120); // exact: boundary math, no drift
  assert.equal(run.status, 'finished');
});

// ---------------------------------------------------------------------------
// ENOM multi-station — 2026-05-24: 20:00 EMOM Min1 row / Min2 swings / Min3 HS hold
// ---------------------------------------------------------------------------
test('EMOM 1:00 x 20 with 3 rotating stations shows the right station every minute', () => {
  const stations = ['10/8 CAL ROW', '15 RUSSIAN KB SWINGS', 'NOSE-TO-WALL HS HOLD'];
  const run = E.createRun('enmom', { intervalSec: 60, sets: 20, stations }, CUES_NONE, 0);
  assert.equal(run.segments.length, 20);
  for (let i = 0; i < 20; i++) {
    assert.equal(run.segments[i].station, stations[i % 3], `round ${i + 1} station`);
  }
  const sim = simulate(run, { maxSec: 1300 });
  assert.equal(run.status, 'finished');
  // transitions observed for rounds 2..20 (round 1 starts via start(), not a tick)
  assert.equal(sim.transitions.length, 19);
  assert.equal(sim.transitions[0].station, stations[1 % 3]);
});

// ---------------------------------------------------------------------------
// AMRAP — "No Rain": 15:00 AMRAP with round taps
// ---------------------------------------------------------------------------
test('AMRAP 15:00 (No Rain): countdown direction, round taps, finish', () => {
  const run = E.createRun('amrap', { durationSec: 900 }, CUES_NONE, 10);
  let sawDisplayNearStart = null;
  const sim = simulate(run, {
    onFrame: (f, t) => {
      if (f.seg.kind === 'work' && sawDisplayNearStart === null) sawDisplayNearStart = f.display;
      if (f.seg.kind === 'work' && Math.abs(f.totalElapsed - 300) < 0.06) E.tapRound(run, t);
    },
  });
  assert.ok(sawDisplayNearStart > 899 && sawDisplayNearStart <= 900, 'counts DOWN from 15:00');
  assert.equal(run.rounds, 1);
  assert.equal(sim.finishedAt, 10 + 900);
});

// ---------------------------------------------------------------------------
// FOR TIME — "Murph": cap 70:00, athlete taps rounds, cap ends the run
// ---------------------------------------------------------------------------
test('FOR TIME with 70:00 cap (Murph): counts UP and hard-stops at cap', () => {
  const run = E.createRun('fortime', { capSec: 4200 }, CUES_NONE, 0);
  let lastDisplay = 0;
  const sim = simulate(run, { tickMs: 1000, maxSec: 5000, onFrame: f => { lastDisplay = f.display; } });
  assert.ok(lastDisplay <= 4200, 'display never exceeds cap');
  assert.equal(sim.finishedAt, 4200); // exact at cap
  assert.equal(run.status, 'finished');
});

test('FOR TIME without cap runs open-ended until athlete finishes', () => {
  const run = E.createRun('fortime', { capSec: null }, CUES_NONE, 0);
  let t = T0;
  E.start(run, t);
  t += 23 * 60 * 1000; // 23:00 of grinding
  const f = E.tick(run, t);
  assert.equal(f.status, 'running');
  assert.equal(f.seg.durationSec, null);
  assert.equal(Math.round(f.display), 1380);
  const res = E.completeOpenSegment(run, t); // athlete taps done
  assert.equal(res.done, true);
  assert.equal(run.status, 'finished');
});

// ---------------------------------------------------------------------------
// SETS+REST — "Beatrix Kiddo": 3 sets, rest 2:00 between (open work, fixed rest)
// ---------------------------------------------------------------------------
test('SETS+REST 3x / rest 2:00 (Beatrix Kiddo): work-rest interleave, no rest after last set', () => {
  const run = E.createRun('setsrest', { sets: 3, restSec: 120 }, CUES_NONE, 0);
  assert.deepEqual(run.segments.map(s => s.kind), ['work', 'rest', 'work', 'rest', 'work']);
  assert.equal(run.segments[0].durationSec, null, 'work is open-ended');
  assert.equal(run.segments[1].durationSec, 120, 'rest is fixed');

  let t = T0;
  E.start(run, t);
  t += 180_000; E.tick(run, t); E.completeOpenSegment(run, t);      // set 1: 3:00
  t += 120_000 + 100; let f = E.tick(run, t);                        // rest expires
  assert.equal(f.seg.label, 'SET 2/3');
  t += 150_000; E.tick(run, t); E.completeOpenSegment(run, t);      // set 2
  t += 120_000 + 100; f = E.tick(run, t);
  assert.equal(f.seg.label, 'SET 3/3');
  t += 160_000; E.tick(run, t);
  const res = E.completeOpenSegment(run, t);                         // last set -> finished, no trailing rest
  assert.equal(res.done, true);
  assert.equal(run.status, 'finished');
});

// ---------------------------------------------------------------------------
// Cues
// ---------------------------------------------------------------------------
test('lead-in countdown always fires 3-2-1 even with endCountdown off', () => {
  const run = E.createRun('amrap', { durationSec: 600 }, { ...CUES_NONE }, 10);
  const sim = simulate(run, { maxSec: 12 });
  const cd = sim.cues.filter(c => c.type === 'countdown').map(c => c.n);
  assert.deepEqual(cd, [3, 2, 1]);
});

test('end-anchored 3-2-1 fires into EVERY next segment when enabled (R9 end anchor)', () => {
  const run = E.createRun('enmom', { intervalSec: 60, sets: 3, stations: [] },
    { ...CUES_NONE, endCountdown: true }, 0);
  const sim = simulate(run, { maxSec: 200 });
  const cd = sim.cues.filter(c => c.type === 'countdown');
  assert.equal(cd.length, 9); // 3-2-1 x 3 rounds
  // countdown into round 2 lands at 57/58/59s on the wall clock
  assert.deepEqual(cd.slice(0, 3).map(c => Math.round(c.at)), [57, 58, 59]);
});

test('start-anchored blast fires at each segment start when enabled (R9 start anchor)', () => {
  const run = E.createRun('enmom', { intervalSec: 60, sets: 3, stations: [] },
    { ...CUES_NONE, startBlast: true }, 10);
  const sim = simulate(run, { maxSec: 200 });
  const blasts = sim.cues.filter(c => c.type === 'segment-start');
  assert.equal(blasts.length, 3, 'one blast per work round, none for lead-in');
  assert.deepEqual(blasts.map(b => Math.round(b.at)), [10, 70, 130]);
});

test('final-segment countdown is flagged urgent (final=true)', () => {
  const run = E.createRun('amrap', { durationSec: 60 }, { ...CUES_NONE, endCountdown: true }, 0);
  const sim = simulate(run, { maxSec: 70 });
  const cd = sim.cues.filter(c => c.type === 'countdown');
  assert.ok(cd.length === 3 && cd.every(c => c.final === true));
});

test('halfway fires once for AMRAP, never for EnMOM rounds', () => {
  const a = E.createRun('amrap', { durationSec: 600 }, { ...CUES_NONE, halfway: true }, 0);
  const simA = simulate(a, { maxSec: 700 });
  assert.equal(simA.cues.filter(c => c.type === 'halfway').length, 1);
  assert.equal(Math.round(simA.cues.find(c => c.type === 'halfway').at), 300);

  const e = E.createRun('enmom', { intervalSec: 60, sets: 4, stations: [] }, { ...CUES_NONE, halfway: true }, 0);
  const simE = simulate(e, { maxSec: 300 });
  assert.equal(simE.cues.filter(c => c.type === 'halfway').length, 0);
});

test('cues fire exactly once per segment (no repeats across ticks)', () => {
  const run = E.createRun('enmom', { intervalSec: 10, sets: 2, stations: [] }, CUES_ALL, 5);
  const sim = simulate(run, { tickMs: 50, maxSec: 30 });
  const keys = sim.cues.map(c => `${Math.floor(c.at / 5)}:${c.type}${c.n || ''}`);
  assert.equal(new Set(keys).size, keys.length, `duplicate cue fired: ${keys.join(',')}`);
});

// ---------------------------------------------------------------------------
// Timekeeping robustness (browser throttling / watch ambient mode)
// ---------------------------------------------------------------------------
test('drift-free: a 5-minute tick blackout catches up through multiple segments exactly', () => {
  const run = E.createRun('enmom', { intervalSec: 60, sets: 5, stations: [] }, CUES_NONE, 0);
  let t = T0;
  E.start(run, t);
  E.tick(run, (t += 100));
  const f = E.tick(run, (t += 300_000)); // 5:00 gap: tab was throttled
  assert.equal(f.status, 'finished', 'run completed during blackout is finished on next tick');
  // segment boundaries recorded at exact multiples of 60s, no accumulated drift
  const segEvents = run.events.filter(e => e.e === 'segment');
  for (let i = 1; i < segEvents.length; i++) {
    assert.equal((segEvents[i].t - T0) % 60_000, 0, `segment ${i} boundary drifted`);
  }
});

test('a blackout mid-run lands in the CORRECT segment, not the next tick segment', () => {
  const run = E.createRun('enmom', { intervalSec: 60, sets: 10, stations: [] }, CUES_NONE, 0);
  let t = T0;
  E.start(run, t);
  const f = E.tick(run, (t += 4 * 60_000 + 30_000)); // wake at 4:30
  assert.equal(f.seg.label, 'ROUND 5/10');
  assert.ok(Math.abs(f.remaining - 30) < 0.001, `remaining ${f.remaining} != 30`);
});

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------
test('no pause exists on the engine API (R5)', () => {
  assert.equal(typeof E.pause, 'undefined');
  assert.equal(typeof E.resume, 'undefined');
});

test('abort logs status and stops ticking', () => {
  const run = E.createRun('amrap', { durationSec: 600 }, CUES_NONE, 0);
  let t = T0;
  E.start(run, t);
  E.tick(run, (t += 5000));
  E.abort(run, t);
  assert.equal(run.status, 'aborted');
  assert.equal(E.tick(run, t + 1000).status, 'aborted', 'tick is a no-op after abort');
  assert.equal(run.events.at(-1).e, 'aborted');
});

test('round taps only count via explicit taps; EnMOM rounds derive from segments', () => {
  const run = E.createRun('enmom', { intervalSec: 60, sets: 3, stations: [] }, CUES_NONE, 0);
  simulate(run, { maxSec: 200 });
  assert.equal(run.rounds, 0, 'no phantom taps');
  assert.equal(run.segments.at(-1).round, 3);
});

test('formatting: fmt and fmtTenths', () => {
  assert.equal(E.fmt(0), '0:00');
  assert.equal(E.fmt(90), '1:30');
  assert.equal(E.fmt(4200), '70:00');
  assert.equal(E.fmtTenths(89.94), '1:29.9');
  assert.equal(E.fmt(-5), '0:00', 'negative clamps to zero');
});

test('summary strings for the mission log', () => {
  assert.equal(E.summary(E.createRun('enmom', { intervalSec: 120, sets: 8 }, CUES_NONE, 0)), 'ENOM 2:00 x 8');
  assert.equal(E.summary(E.createRun('amrap', { durationSec: 900 }, CUES_NONE, 0)), 'AMRAP 15:00');
  assert.equal(E.summary(E.createRun('fortime', { capSec: 4200 }, CUES_NONE, 0)), 'FOR TIME CAP 70:00');
  assert.equal(E.summary(E.createRun('fortime', { capSec: null }, CUES_NONE, 0)), 'FOR TIME');
  assert.equal(E.summary(E.createRun('setsrest', { sets: 3, restSec: 120 }, CUES_NONE, 0)), '3 SETS / REST 2:00');
});

// Edge cases
test('single-set EnMOM and 1-second interval do not break', () => {
  const run = E.createRun('enmom', { intervalSec: 1, sets: 1, stations: ['X'] }, CUES_ALL, 0);
  const sim = simulate(run, { tickMs: 50, maxSec: 5 });
  assert.equal(run.status, 'finished');
  assert.ok(sim.finishedAt <= 1.1);
});

test('zero lead-in starts directly in work', () => {
  const run = E.createRun('amrap', { durationSec: 60 }, CUES_NONE, 0);
  E.start(run, T0);
  assert.equal(E.cur(run).kind, 'work');
});
