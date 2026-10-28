/* Cornfield Carver - optional upbeat procedural audio (Web Audio, no assets).
   Facade: window.CornfieldAudio
     supported            boolean, false when Web Audio is unavailable
     music(), sfx()       current on/off state
     setMusic(on), setSfx(on)   call from a user gesture; starts/stops audio
     carve(), step(), bump(), victory()   soft one-shot effects (no-ops when off)
     onChange(fn)         fn() called when a setting changes
     patternAt(step[, trackId])   pure loop description (events per eighth-note step) for tests;
                          without trackId it is always the original arrangement (cornfield-bounce)
     bpm, tracks[{id,title,bpm}], rotationSteps (256 steps = 8 loops = 32 bars)
     track(), setTrack(id), autoRotate(), setAutoRotate(on), trackAt(step), nowPlaying()
   Both channels are off by default; settings persist in localStorage. */
(function (root) {
  'use strict';
  var KEY = 'cornfield-carver:audio:v1', MKEY = 'cornfield-carver:music:v1';
  var AC = root.AudioContext || root.webkitAudioContext;
  var listeners = [];
  var TRACK_IDS = ['cornfield-bounce', 'sunflower-swing', 'hayride-harmony', 'cattle-call', 'field-day-frolic'];
  var TITLES = ['Cornfield Bounce', 'Sunflower Swing', 'Hayride Harmony', 'Cattle Call', 'Field Day Frolic'];
  var prefs = { music: false, sfx: false, track: TRACK_IDS[0], auto: true };
  var ctx = null, master = null, musicBus = null, sfxBus = null, timer = 0;
  var nextBeat = 0, beat = 0, lastSfx = 0;
  var wantRestore = false;

  try {
    var raw = root.localStorage.getItem(KEY);
    if (raw) { var p = JSON.parse(raw); prefs.music = p.music === true; prefs.sfx = p.sfx === true; }
  } catch (e) { /* ignore */ }
  try {   // the song choice and Auto rotate live under their own key
    var rawM = root.localStorage.getItem(MKEY);
    if (rawM) { var pm = JSON.parse(rawM); if (TRACK_IDS.indexOf(pm.track) >= 0) prefs.track = pm.track; prefs.auto = pm.auto !== false; }
  } catch (e) { /* ignore */ }
  function save() { try { root.localStorage.setItem(KEY, JSON.stringify({ music: prefs.music, sfx: prefs.sfx })); } catch (e) { /* ignore */ } }
  function saveTrackPrefs() { try { root.localStorage.setItem(MKEY, JSON.stringify({ track: prefs.track, auto: prefs.auto })); } catch (e) { /* ignore */ } }
  function notify() { for (var i = 0; i < listeners.length; i++) { try { listeners[i](); } catch (e) { /* ignore */ } } }

  var BPM = 118, SPS = 60 / BPM / 2;          // SPS: one eighth-note step in seconds
  var STEPS_PER_BAR = 8, BARS = 4, LOOP_STEPS = STEPS_PER_BAR * BARS;
  var LOOKAHEAD = 0.15, TICK_MS = 30;
  function mtof(m) { return 440 * Math.pow(2, (m - 69) / 12); }
  // Original loop in C major: I - V - vi - IV, each chord coloured with an added 9th.
  var BASS = [36, 43, 33, 41];                                   // C2 G2 A1 F2 (MIDI)
  var BASS_RHYTHM = [1, 0, 2, 1, 0, 1, 2, 1.5];                  // 0 = rest, else frequency multiplier
  var STAB = [[64, 67, 74], [62, 69, 71], [64, 71, 72], [65, 69, 72]];
  var LEAD = [
    [76, 0, 79, 81, 79, 0, 76, 74],
    [74, 0, 79, 83, 81, 0, 79, 74],
    [76, 0, 81, 0, 84, 81, 79, 76],
    [77, 0, 81, 79, 77, 0, 74, 72]
  ];

  // Pure and deterministic: the events that start on eighth-note `step` of the original loop.
  function originalAt(step) {
    var s = ((step % LOOP_STEPS) + LOOP_STEPS) % LOOP_STEPS;
    var bar = Math.floor(s / STEPS_PER_BAR), pos = s % STEPS_PER_BAR, ev = [], i;
    if (pos === 0 || pos === 4 || (pos === 3 && bar % 2 === 1)) ev.push({ voice: 'kick', freq: 150, dur: 0.16, gain: 0.34 });
    if (pos === 2 || pos === 6) ev.push({ voice: 'snare', freq: 190, dur: 0.12, gain: 0.16 });
    ev.push({ voice: 'hat', freq: 7000, dur: 0.04, gain: pos % 2 ? 0.05 : 0.03 });
    var bm = BASS_RHYTHM[pos];
    if (bm) ev.push({ voice: 'bass', freq: mtof(BASS[bar]) * bm, dur: 0.17, gain: 0.2 });
    var lm = LEAD[bar][pos];
    if (lm) ev.push({ voice: 'lead', freq: mtof(lm), dur: 0.2, gain: 0.1 });
    if (pos === 3 || pos === 6) {
      for (i = 0; i < STAB[bar].length; i++) ev.push({ voice: 'stab', freq: mtof(STAB[bar][i]), dur: 0.12, gain: 0.03 });
    }
    return ev;
  }

  /* Four more original 32-step arrangements, each with its own key, chords, drums, bass line and
     melody. Rows are one entry per bar. Drum strings: x = hit, . = rest; hats use 0/1/2 (rest/soft/
     accent). Bass rows are semitone offsets from the bar's root (null = rest); lead rows are MIDI
     notes (0 = rest). All stay at 118 BPM so a switch never changes the pulse. */
  var HAT_GAIN = { '1': 0.03, '2': 0.05 };
  var SPECS = [null, {
    // G major swing: I - vi - ii - V, half-time kick, offbeat-accent hats, octave-bounce bass
    kick: ['x.....x.', 'x.....x.', 'x.....x.', 'x...x.x.'], snare: ['....x...', '....x...', '....x...', '....x.x.'],
    hat: ['12121212', '12121212', '12121212', '12121212'], roots: [43, 40, 45, 38],
    bass: [[0, null, null, 7, null, 12, null, 7], [0, null, null, 7, null, 12, null, 7], [0, null, null, 7, null, 12, null, 7], [0, null, 7, null, 12, null, 7, 5]],
    lead: [[79, 0, 83, 0, 81, 79, 0, 0], [76, 0, 79, 0, 83, 0, 81, 79], [81, 0, 0, 84, 81, 0, 79, 76], [78, 0, 81, 79, 78, 0, 74, 0]],
    chords: [[67, 71, 74], [64, 67, 71], [64, 69, 72], [66, 69, 74]], stab: '.x..x...'
  }, {
    // A minor folk in a 3+3+2 pulse: i - VI - III - VII, melody in thirds, plucked arpeggios
    kick: ['x..x..x.', 'x..x..x.', 'x..x..x.', 'x..x..xx'], snare: ['...x..x.', '...x..x.', '...x..x.', '...x..xx'],
    hat: ['21121121', '21121121', '21121121', '21121121'], roots: [45, 41, 48, 43],
    bass: [[0, null, null, 7, null, null, 0, null], [0, null, null, 7, null, null, 12, 7], [0, null, null, 7, null, null, 0, null], [0, null, null, 7, null, null, 12, 7]],
    lead: [[76, 0, 0, 79, 0, 0, 76, 0], [77, 0, 0, 81, 0, 0, 79, 77], [79, 0, 0, 84, 0, 0, 83, 79], [81, 0, 0, 79, 0, 0, 74, 0]],
    lead2: [[72, 0, 0, 76, 0, 0, 72, 0], [72, 0, 0, 77, 0, 0, 76, 74], [76, 0, 0, 79, 0, 0, 79, 76], [76, 0, 0, 76, 0, 0, 71, 0]],
    arp: [[57, 0, 60, 0, 64, 0, 60, 0], [53, 0, 57, 0, 60, 0, 57, 0], [55, 0, 60, 0, 64, 0, 60, 0], [55, 0, 59, 0, 62, 0, 59, 0]]
  }, {
    // D mixolydian boom-chick: D - C - G - D, call-and-response melody, down-strum stabs
    kick: ['x...x...', 'x...x...', 'x...x...', 'x...x.xx'], snare: ['..x....x', '..x....x', '..x....x', '..x....x'],
    hat: ['21112111', '21112111', '21112111', '21112112'], roots: [38, 36, 43, 38],
    bass: [[0, null, null, null, 7, null, null, null], [0, null, null, null, 7, null, 0, null], [0, null, null, null, 7, null, null, 5], [0, null, 7, null, 0, null, 7, 12]],
    lead: [[74, 0, 76, 78, 0, 0, 0, 0], [0, 0, 0, 0, 79, 0, 76, 72], [79, 0, 81, 83, 0, 0, 0, 0], [0, 0, 0, 0, 81, 78, 74, 69]],
    chords: [[62, 66, 69], [60, 64, 67], [59, 62, 67], [62, 66, 69]], stab: '..x...x.'
  }, {
    // F major march: I - IV - V - I, four-on-the-floor kick, running scale melody, syncopated tuba bass
    kick: ['x.x.x.x.', 'x.x.x.x.', 'x.x.x.x.', 'x.x.x.xx'], snare: ['..x..x.x', '..x..x.x', '..x..x.x', '..x.xxxx'],
    hat: ['21212121', '21212121', '21212121', '21212121'], roots: [41, 46, 48, 41],
    bass: [[0, null, 0, 12, null, 0, 7, null], [0, null, 0, 12, null, 0, 7, null], [0, null, 0, 12, null, 0, 7, null], [0, null, 0, 12, null, 7, 12, 7]],
    lead: [[72, 74, 76, 77, 79, 77, 76, 74], [74, 0, 77, 79, 81, 79, 77, 74], [76, 77, 79, 81, 84, 81, 79, 77], [77, 0, 81, 0, 84, 0, 81, 0]],
    chords: [[65, 69, 72], [65, 70, 74], [64, 67, 72], [65, 69, 72]], stab: '..x..x.x'
  }];

  function specAt(spec, step) {
    var s = ((step % LOOP_STEPS) + LOOP_STEPS) % LOOP_STEPS;
    var bar = Math.floor(s / STEPS_PER_BAR), pos = s % STEPS_PER_BAR, ev = [], i, c;
    if (spec.kick[bar].charAt(pos) === 'x') ev.push({ voice: 'kick', freq: 150, dur: 0.16, gain: 0.34 });
    if (spec.snare[bar].charAt(pos) === 'x') ev.push({ voice: 'snare', freq: 190, dur: 0.12, gain: 0.16 });
    c = spec.hat[bar].charAt(pos);
    if (HAT_GAIN[c]) ev.push({ voice: 'hat', freq: 7000, dur: 0.04, gain: HAT_GAIN[c] });
    if (spec.bass[bar][pos] !== null) ev.push({ voice: 'bass', freq: mtof(spec.roots[bar] + spec.bass[bar][pos]), dur: 0.17, gain: 0.2 });
    if (spec.lead[bar][pos]) ev.push({ voice: 'lead', freq: mtof(spec.lead[bar][pos]), dur: 0.2, gain: 0.1 });
    if (spec.lead2 && spec.lead2[bar][pos]) ev.push({ voice: 'lead', freq: mtof(spec.lead2[bar][pos]), dur: 0.2, gain: 0.06 });
    if (spec.arp && spec.arp[bar][pos]) ev.push({ voice: 'stab', freq: mtof(spec.arp[bar][pos]), dur: 0.14, gain: 0.04 });
    if (spec.chords && spec.stab.charAt(pos) === 'x') {
      for (i = 0; i < spec.chords[bar].length; i++) ev.push({ voice: 'stab', freq: mtof(spec.chords[bar][i]), dur: 0.12, gain: 0.03 });
    }
    return ev;
  }

  var ROTATE_STEPS = 8 * LOOP_STEPS;   // 32 bars, about 65 s per song at 118 BPM
  // patternAt(step) is always the original arrangement; pass a track id for the others.
  function patternAt(step, trackId) {
    var i = trackId === undefined ? 0 : TRACK_IDS.indexOf(trackId);
    return i > 0 ? specAt(SPECS[i], step) : originalAt(step);
  }

  /* Which song a step belongs to is a pure function of the step and the rotation origin, so a rewind
     (hushMusic) restores the right song and a canceled transition cannot drift. */
  var baseTrack = TRACK_IDS.indexOf(prefs.track), holdTrack = baseTrack, baseBeat = 0, rotBeat = 0;
  function mod5(n) { return ((n % 5) + 5) % 5; }
  function trackIndexAt(step) {
    if (!prefs.auto) return holdTrack;
    return mod5(baseTrack + Math.max(0, Math.floor((step - rotBeat) / ROTATE_STEPS)));
  }
  var onsets = [], announced = -1, announceToken = 0;   // song changes as scheduled: {t, i}, newest last

  function ensure() {
    if (!AC) return false;
    if (ctx) return true;
    try {
      ctx = new AC();
      master = ctx.createGain(); master.gain.value = 0.5;
      var lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 7000; lp.Q.value = 0.3;
      musicBus = ctx.createGain(); musicBus.gain.value = 0;
      sfxBus = ctx.createGain(); sfxBus.gain.value = 0;
      musicBus.connect(lp); sfxBus.connect(lp); lp.connect(master); master.connect(ctx.destination);
    } catch (e) { ctx = null; return false; }
    return true;
  }

  // One enveloped voice; always stops itself so no oscillator leaks.
  function voice(bus, type, freq, t, attack, hold, release, peak, glideTo) {
    var o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, t + attack + hold + release);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.setValueAtTime(peak, t + attack + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + hold + release);
    o.connect(g); g.connect(bus);
    var end = t + attack + hold + release + 0.05;
    o.onended = function () { try { o.disconnect(); g.disconnect(); } catch (e) { /* ignore */ } };
    o.start(t); o.stop(end);
    return { src: o, start: t, end: end };
  }

  // Music voices are tracked so turning music off can cancel queued and ringing notes.
  var noiseBuf = null, live = [];
  function trackVoice(rec, extra) {
    live.push(rec);
    var prev = rec.src.onended;
    rec.src.onended = function () {
      var i = live.indexOf(rec); if (i >= 0) live.splice(i, 1);
      if (prev) prev();
      try { for (var k = 0; k < extra.length; k++) extra[k].disconnect(); rec.src.disconnect(); } catch (e) { /* ignore */ }
    };
  }
  function tone(type, freq, t, hold, release, peak, glideTo) {
    trackVoice(voice(musicBus, type, freq, t, 0.006, hold, release, peak, glideTo), []);
  }
  function noise(ftype, fq, t, dur, peak) {
    if (!noiseBuf) {   // one shared buffer for every snare and hat
      var len = Math.floor(ctx.sampleRate * 0.5), d;
      noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
      d = noiseBuf.getChannelData(0);
      for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    var s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    s.buffer = noiseBuf;
    f.type = ftype; f.frequency.value = fq; f.Q.value = 0.7;
    g.gain.setValueAtTime(peak, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(g); g.connect(musicBus);
    var end = t + dur + 0.03;
    trackVoice({ src: s, start: t, end: end }, [f, g]);
    s.start(t); s.stop(end);
  }
  function hushMusic() {
    if (!ctx) return;
    var now = ctx.currentTime, cut = now + 0.45, rewind = Infinity;
    for (var i = 0; i < live.length; i++) {
      var r = live[i];
      try {
        if (r.start > now && r.end > r.start) { rewind = Math.min(rewind, r.start); r.src.stop(r.start); r.end = r.start; }
        else if (r.end > cut) { r.src.stop(cut); r.end = cut; }
      } catch (e) { /* ignore */ }
    }
    if (rewind < Infinity) {
      beat -= Math.round((nextBeat - rewind) / SPS); nextBeat = rewind;
      while (onsets.length && onsets[onsets.length - 1].t >= rewind) onsets.pop();   // canceled song changes never happened
      announced = onsets.length ? onsets[onsets.length - 1].i : -1;
    }
  }

  function scheduleStep(step, t) {
    var idx = trackIndexAt(step), ev = patternAt(step - baseBeat, idx ? TRACK_IDS[idx] : undefined);
    if (idx !== announced) {   // the song heard from time t on; the display follows the audible onset, not the queue
      announced = idx; onsets.push({ t: t, i: idx }); if (onsets.length > 8) onsets.shift();
      var tok = ++announceToken;
      setTimeout(function () { if (tok === announceToken && prefs.music) notify(); }, Math.max(0, (t - ctx.currentTime) * 1000));
    }
    for (var i = 0; i < ev.length; i++) {
      var e = ev[i];
      if (e.voice === 'kick') tone('sine', e.freq, t, 0.01, e.dur, e.gain, 45);
      else if (e.voice === 'snare') { noise('highpass', 1800, t, e.dur, e.gain); tone('triangle', e.freq, t, 0.01, 0.07, e.gain * 0.6, 140); }
      else if (e.voice === 'hat') noise('highpass', e.freq, t, e.dur, e.gain);
      else if (e.voice === 'bass') tone('triangle', e.freq, t, 0.06, e.dur, e.gain);
      else if (e.voice === 'lead') { tone('square', e.freq, t, 0.04, e.dur, e.gain); tone('triangle', e.freq * 2, t, 0.02, 0.1, e.gain * 0.35); }
      else tone('triangle', e.freq, t, 0.03, e.dur, e.gain);
    }
  }

  function tick() {
    if (!ctx || ctx.state !== 'running') return;
    var now = ctx.currentTime;
    if (nextBeat < now) nextBeat = now + 0.05;
    while (nextBeat < now + LOOKAHEAD) { scheduleStep(beat, nextBeat); beat++; nextBeat += SPS; }
  }
  function startLoop() {
    if (timer) return;
    // keep a still-queued grid so quick off/on toggles don't double notes; otherwise restart at the bar line
    if (nextBeat < ctx.currentTime) {
      nextBeat = ctx.currentTime + 0.06; beat = 0;
      baseTrack = holdTrack = TRACK_IDS.indexOf(prefs.track); baseBeat = rotBeat = 0; onsets = []; announced = -1;
    }
    timer = setInterval(tick, TICK_MS); tick();
  }
  function stopLoop() { if (timer) { clearInterval(timer); timer = 0; } }

  function ramp(g, v) {
    var t = ctx.currentTime;
    g.gain.cancelScheduledValues(t);
    g.gain.setValueAtTime(g.gain.value, t);
    g.gain.linearRampToValueAtTime(v, t + 0.4);
  }

  function apply() {
    if (!ctx) return;
    ramp(musicBus, prefs.music ? 1 : 0);
    ramp(sfxBus, prefs.sfx ? 1 : 0);
    if (prefs.music && !document.hidden) startLoop();
    else { stopLoop(); if (!prefs.music) hushMusic(); }
    if ((prefs.music || prefs.sfx) && !document.hidden) { if (ctx.state === 'suspended') ctx.resume(); }
    else if (ctx.state === 'running') {
      // let the fade-out finish before suspending
      setTimeout(function () { if (ctx && !prefs.music && !prefs.sfx && ctx.state === 'running') ctx.suspend(); }, 500);
      if (document.hidden) ctx.suspend();
    }
  }

  function set(which, on) {
    on = !!on;
    if (on && !ensure()) { notify(); return false; }
    prefs[which] = on; save(); apply(); notify();
    return on;
  }

  // Settings restored from storage only start sound after a real gesture.
  function restoreOnGesture() {
    if (wantRestore || !AC || !(prefs.music || prefs.sfx)) return;
    wantRestore = true;
    var go = function () {
      root.removeEventListener('pointerdown', go, true); root.removeEventListener('keydown', go, true);
      if ((prefs.music || prefs.sfx) && ensure()) apply();
    };
    root.addEventListener('pointerdown', go, true); root.addEventListener('keydown', go, true);
  }

  document.addEventListener('visibilitychange', function () {
    if (!ctx) return;
    if (document.hidden) { stopLoop(); if (ctx.state === 'running') ctx.suspend(); }
    else apply();
  });

  function sfxOk(gap) {
    if (!ctx || !prefs.sfx || ctx.state !== 'running') return false;
    var n = ctx.currentTime;
    if (n - lastSfx < gap) return false;
    lastSfx = n; return true;
  }

  root.CornfieldAudio = {
    supported: !!AC,
    bpm: BPM,
    patternAt: patternAt,
    tracks: TRACK_IDS.map(function (id, i) { return { id: id, title: TITLES[i], bpm: BPM }; }),
    rotationSteps: ROTATE_STEPS,
    track: function () { return prefs.track; },
    autoRotate: function () { return prefs.auto; },
    trackAt: function (step) { return TRACK_IDS[trackIndexAt(step)]; },
    // The song heard now (or, with music off, the selected one): {id, title, playing}
    nowPlaying: function () {
      var i = TRACK_IDS.indexOf(prefs.track), live = !!(ctx && prefs.music && timer);
      if (live) {
        var n = ctx.currentTime, k = -1;
        for (var j = 0; j < onsets.length; j++) if (onsets[j].t <= n) k = j;
        i = k >= 0 ? onsets[k].i : (onsets.length ? onsets[0].i : i);
      }
      return { id: TRACK_IDS[i], title: TITLES[i], playing: live };
    },
    setTrack: function (id) {
      var i = TRACK_IDS.indexOf(id);
      if (i < 0) return false;
      prefs.track = id; saveTrackPrefs();
      if (ctx && prefs.music && timer) hushMusic();   // cancel the old song's queued notes; ringing ones fade out
      baseTrack = holdTrack = i; baseBeat = rotBeat = beat;
      notify(); return true;
    },
    setAutoRotate: function (on) {
      on = !!on;
      if (on === prefs.auto) return on;
      var live = !!(ctx && prefs.music && timer), cur = trackIndexAt(beat);
      if (live && !on) {   // beat runs ahead of the speakers: keep the song that is audible, not one queued after it
        var n = ctx.currentTime, k = -1;
        for (var j = 0; j < onsets.length; j++) if (onsets[j].t <= n) k = j;
        if (k >= 0) cur = onsets[k].i;
        hushMusic();   // cancel queued notes (and any queued song change); they restart as the held song
        prefs.track = TRACK_IDS[cur]; baseTrack = holdTrack = cur; baseBeat = rotBeat = beat;
      }
      prefs.auto = on; saveTrackPrefs();
      if (!live) { baseTrack = holdTrack = TRACK_IDS.indexOf(prefs.track); baseBeat = rotBeat = beat; }
      else if (on) { baseTrack = holdTrack = cur; rotBeat = baseBeat + Math.ceil((beat - baseBeat) / LOOP_STEPS) * LOOP_STEPS; }
      notify(); return on;
    },
    music: function () { return prefs.music; },
    sfx: function () { return prefs.sfx; },
    setMusic: function (on) { return set('music', on); },
    setSfx: function (on) { return set('sfx', on); },
    onChange: function (fn) { listeners.push(fn); },
    carve: function () {
      if (!sfxOk(0.09)) return;
      var t = ctx.currentTime + 0.01;
      voice(sfxBus, 'sine', 196, t, 0.01, 0.02, 0.14, 0.09, 150);
      voice(sfxBus, 'triangle', 392, t, 0.01, 0.01, 0.08, 0.025);
    },
    step: function () {
      if (!sfxOk(0.07)) return;
      voice(sfxBus, 'sine', 523.25, ctx.currentTime + 0.01, 0.008, 0.01, 0.07, 0.035);
    },
    bump: function () {
      if (!sfxOk(0.15)) return;
      voice(sfxBus, 'sine', 130, ctx.currentTime + 0.01, 0.01, 0.01, 0.12, 0.06, 100);
    },
    victory: function () {
      if (!ctx || !prefs.sfx || ctx.state !== 'running') return;
      var t = ctx.currentTime + 0.05, f = [523.25, 659.25, 783.99, 1046.5], i;
      for (i = 0; i < f.length; i++) {
        voice(sfxBus, 'sine', f[i], t + i * 0.16, 0.02, 0.06, 0.9, 0.07);
        voice(sfxBus, 'triangle', f[i] / 2, t + i * 0.16, 0.02, 0.06, 0.9, 0.03);
      }
    }
  };
  restoreOnGesture();
})(typeof window !== 'undefined' ? window : this);
