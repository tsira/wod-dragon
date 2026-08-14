/* WOD DRAGON — timer engine.
   Pure logic, no DOM. This file is the portable spec for the Wear OS port.

   Segment: {
     kind: 'countdown' | 'work' | 'rest' | 'done',
     label: string,            // "ROUND 3/8", "REST", "GET READY"
     station: string|null,     // "Min 2: 15 Russian KB Swings"
     durationSec: number|null, // null = open-ended (tap to advance)
     direction: 'down'|'up',
     round: number|null,
     totalRounds: number|null
   }
*/
'use strict';

const Engine = (() => {
  // ---- segment generators (modes) ----
  function enmom({ intervalSec, sets, stations }) {
    const segs = [];
    for (let i = 0; i < sets; i++) {
      const st = stations && stations.length ? stations[i % stations.length] : null;
      segs.push({
        kind: 'work', label: `ROUND ${i + 1}/${sets}`, station: st,
        durationSec: intervalSec, direction: 'down', round: i + 1, totalRounds: sets,
      });
    }
    return segs;
  }

  function amrap({ durationSec }) {
    return [{
      kind: 'work', label: 'AMRAP', station: null,
      durationSec, direction: 'down', round: null, totalRounds: null,
    }];
  }

  function forTime({ capSec }) {
    return [{
      kind: 'work', label: 'FOR TIME', station: null,
      durationSec: capSec || null, direction: 'up', round: null, totalRounds: null,
    }];
  }

  function setsRest({ sets, restSec }) {
    const segs = [];
    for (let i = 0; i < sets; i++) {
      segs.push({
        kind: 'work', label: `SET ${i + 1}/${sets}`, station: null,
        durationSec: null, direction: 'up', round: i + 1, totalRounds: sets,
      });
      if (i < sets - 1) {
        segs.push({
          kind: 'rest', label: 'REST', station: null,
          durationSec: restSec, direction: 'down', round: i + 1, totalRounds: sets,
        });
      }
    }
    return segs;
  }

  const GENERATORS = { enmom, amrap, fortime: forTime, setsrest: setsRest };

  function build(mode, cfg, leadInSec) {
    const body = GENERATORS[mode](cfg);
    const segs = leadInSec > 0
      ? [{ kind: 'countdown', label: 'GET READY', station: body[0].station,
           durationSec: leadInSec, direction: 'down', round: null, totalRounds: null }, ...body]
      : body;
    return segs;
  }

  // ---- runtime ----
  // Wall-clock anchored: all math derives from Date.now() vs segment start,
  // so ticks survive throttling (and map to Wear OS ambient updates).
  function createRun(mode, cfg, cues, leadInSec) {
    return {
      mode, cfg, cues,
      segments: build(mode, cfg, leadInSec),
      idx: -1,
      segStartMs: 0,
      startedMs: 0,
      rounds: 0,               // manual round taps (AMRAP / For Time)
      status: 'idle',          // idle|running|finished|aborted
      firedCues: new Set(),    // "idx:cueKey"
      events: [],              // run log detail
    };
  }

  function start(run, now) {
    run.startedMs = now;
    run.status = 'running';
    advance(run, now);
  }

  function cur(run) { return run.segments[run.idx] || null; }

  function advance(run, now) {
    run.idx += 1;
    run.segStartMs = now;
    const seg = cur(run);
    if (!seg) {
      run.status = 'finished';
      run.events.push({ t: now, e: 'finished' });
      return { done: true };
    }
    run.events.push({ t: now, e: 'segment', label: seg.label, kind: seg.kind });
    return { seg };
  }

  // Returns a frame: everything the UI + cue system needs this tick.
  function tick(run, now) {
    if (run.status !== 'running') return { status: run.status };
    const seg = cur(run);
    const elapsed = (now - run.segStartMs) / 1000;
    let remaining = null, display, progress;

    if (seg.durationSec != null) {
      remaining = Math.max(0, seg.durationSec - elapsed);
      display = seg.direction === 'down' ? remaining : Math.min(elapsed, seg.durationSec);
      progress = Math.min(1, elapsed / seg.durationSec);
      if (remaining <= 0) {
        const res = advance(run, run.segStartMs + seg.durationSec * 1000);
        return tickResultAfterAdvance(run, res, now);
      }
    } else {
      display = elapsed; progress = null; // open-ended
    }

    return {
      status: 'running', seg, idx: run.idx,
      display, remaining, progress,
      totalElapsed: (now - run.startedMs) / 1000,
      transitioned: false,
    };
  }

  function tickResultAfterAdvance(run, res, now) {
    if (res.done) return { status: 'finished', transitioned: true, seg: null };
    const f = tick(run, now);
    f.transitioned = true;
    return f;
  }

  // Open-ended segment: athlete taps "SET DONE".
  function completeOpenSegment(run, now) {
    const seg = cur(run);
    if (!seg || seg.durationSec != null) return null;
    run.events.push({ t: now, e: 'set-done', label: seg.label });
    return advance(run, now);
  }

  function tapRound(run, now) {
    run.rounds += 1;
    run.events.push({ t: now, e: 'round', n: run.rounds });
    return run.rounds;
  }

  function abort(run, now) {
    run.status = 'aborted';
    run.events.push({ t: now, e: 'aborted' });
  }

  // ---- cue evaluation ----
  // cues: { sound, vibrate, endCountdown, startBlast, halfway }
  // Returns list of cue events to fire this tick (each fired once per segment).
  function evalCues(run, frame) {
    if (frame.status !== 'running' || !frame.seg) return [];
    const out = [];
    const key = (k) => `${run.idx}:${k}`;
    const fire = (k, cue) => { if (!run.firedCues.has(key(k))) { run.firedCues.add(key(k)); out.push(cue); } };
    const c = run.cues;
    const seg = frame.seg;

    if (frame.transitioned && c.startBlast && seg.kind !== 'countdown') {
      fire('start', { type: 'segment-start' });
    }
    if (seg.durationSec != null && frame.remaining != null) {
      const isLastSeg = run.idx === run.segments.length - 1;
      if (c.endCountdown || seg.kind === 'countdown') {
        for (const s of [3, 2, 1]) {
          if (frame.remaining <= s) fire(`cd${s}`, { type: 'countdown', n: s, final: isLastSeg });
        }
      }
      if (c.halfway && seg.kind === 'work' && seg.totalRounds == null
          && frame.remaining <= seg.durationSec / 2) {
        fire('half', { type: 'halfway' });
      }
    }
    return out;
  }

  function summary(run) {
    const c = run.cfg;
    const M = {
      enmom: () => `ENOM ${fmt(c.intervalSec)} x ${c.sets}`,
      amrap: () => `AMRAP ${fmt(c.durationSec)}`,
      fortime: () => `FOR TIME${c.capSec ? ' CAP ' + fmt(c.capSec) : ''}`,
      setsrest: () => `${c.sets} SETS / REST ${fmt(c.restSec)}`,
    };
    return M[run.mode]();
  }

  function fmt(sec) {
    sec = Math.max(0, sec);
    const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }
  function fmtTenths(sec) {
    const t = Math.floor((sec % 1) * 10);
    return `${fmt(sec)}.${t}`;
  }

  return { build, createRun, start, tick, completeOpenSegment, tapRound, abort, evalCues, summary, fmt, fmtTenths, cur };
})();

if (typeof module !== 'undefined') module.exports = Engine;
