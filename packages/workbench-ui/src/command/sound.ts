/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Synthesized audio engine for the Command view — Web Audio API only,
 * zero binary assets. RTS muscle memory is auditory; this is the
 * single biggest "feels like a game" lever, and shipping it without
 * shipping ~12 .ogg files keeps the bundle lean.
 *
 * Sound roles:
 *
 *   - `click()`           — UI tick on selection.
 *   - `agentReady()`      — 3-note ascending fanfare when a new Agent
 *                           CR appears for the first time.
 *   - `taskComplete()`    — 2-note ascending chime on Completed phase.
 *   - `taskFailed()`      — descending zap on Failed phase.
 *   - `klaxon()`          — alarm two-tone on AIMD breach / failure cluster.
 *   - `dispatch()`        — soft "task launched" thump.
 *   - `setThrum(g)`       — ambient looping bass; gain ∝ in-flight count.
 *
 * Every browser blocks AudioContext until a user gesture, so callers
 * must invoke `unlock()` from a click handler before any sound plays.
 */

const MASTER_GAIN = 0.32;
const THRUM_BASE_GAIN = 0.0;
const THRUM_MAX_GAIN = 0.18;

export class SoundEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private thrumOsc: OscillatorNode | null = null;
  private thrumGain: GainNode | null = null;
  private muted = false;

  /** Lazy-init the AudioContext on first user gesture. Idempotent. */
  unlock(): void {
    if (this.ctx !== null) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    type WithWebkit = typeof globalThis & {
      webkitAudioContext?: typeof AudioContext;
    };
    const WindowAudio: typeof AudioContext | undefined =
      typeof AudioContext !== 'undefined'
        ? AudioContext
        : (globalThis as WithWebkit).webkitAudioContext;
    if (WindowAudio === undefined) return; // No audio support; degrade silently.
    const ctx = new WindowAudio();
    const master = ctx.createGain();
    master.gain.value = MASTER_GAIN;
    master.connect(ctx.destination);
    this.ctx = ctx;
    this.master = master;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.master !== null) {
      this.master.gain.value = muted ? 0 : MASTER_GAIN;
    }
  }

  isMuted(): boolean {
    return this.muted;
  }

  /**
   * Mute only the ambient bass thrum while keeping UI clicks, chimes,
   * voice lines, and klaxons audible. Useful in shared offices where
   * the continuous low-end is more disruptive than the discrete events.
   */
  private thrumMuted = false;
  setThrumMuted(thrumMuted: boolean): void {
    this.thrumMuted = thrumMuted;
    if (this.thrumGain !== null && this.ctx !== null) {
      const t = this.ctx.currentTime;
      this.thrumGain.gain.cancelScheduledValues(t);
      // setThrum() will reapply the correct gain on the next call;
      // here we just snap to zero so the change is immediate.
      this.thrumGain.gain.linearRampToValueAtTime(
        thrumMuted ? 0 : this.thrumGain.gain.value,
        t + 0.3,
      );
    }
  }

  isThrumMuted(): boolean {
    return this.thrumMuted;
  }

  /** Soft 1.2 kHz tick — UI selection. */
  click(): void {
    this.beep({ freq: 1200, type: 'square', dur: 0.05, peak: 0.12 });
  }

  /**
   * Speak a short command-acknowledgement line via Web Speech API.
   * Lowest-effort "voice line on selection" — the Synth API ships with
   * every browser and needs zero TTS infrastructure. Voice tone is
   * deep + slightly slowed so it reads as "agent reporting in" rather
   * than "browser screen reader." Throttled to one per 2.5s to avoid
   * spamming on rapid Tab cycles.
   */
  private lastSpokeAt = 0;
  speakLine(phrase: string): void {
    if (this.muted) return;
    if (typeof window === 'undefined') return;
    const synth = window.speechSynthesis as SpeechSynthesis | undefined;
    if (synth === undefined) return;
    const now = performance.now();
    if (now - this.lastSpokeAt < 2_500) return;
    this.lastSpokeAt = now;
    // Cancel any pending utterance so "Working" doesn't queue behind
    // an earlier "Standing by."
    synth.cancel();
    const utter = new SpeechSynthesisUtterance(phrase);
    utter.rate = 0.92;
    utter.pitch = 0.55;
    utter.volume = 0.6;
    // Pick the most "command"-feeling voice if available — bias toward
    // English variants with male-leaning timbre. If no preferred voice
    // is found the system default is used (still works fine).
    const voices = synth.getVoices();
    const preferred = voices.find(
      (v) =>
        /Daniel|Alex|Fred|Google UK English Male|Microsoft David/i.test(v.name) &&
        v.lang.startsWith('en'),
    );
    if (preferred !== undefined) utter.voice = preferred;
    synth.speak(utter);
  }

  /** Soft 800 Hz thump — task accepted, command issued. */
  dispatch(): void {
    this.beep({ freq: 220, type: 'sine', dur: 0.18, peak: 0.22 });
    this.beep({ freq: 440, type: 'sine', dur: 0.12, peak: 0.18, delay: 0.05 });
  }

  /** 3-note ascending fanfare — new Agent CR observed. */
  agentReady(): void {
    const notes = [523, 659, 784]; // C5, E5, G5
    notes.forEach((f, i) => {
      this.beep({ freq: f, type: 'triangle', dur: 0.2, peak: 0.18, delay: i * 0.09 });
    });
  }

  /** 2-note ascending chime — task completed. */
  taskComplete(): void {
    this.beep({ freq: 659, type: 'sine', dur: 0.15, peak: 0.2 });
    this.beep({ freq: 988, type: 'sine', dur: 0.25, peak: 0.18, delay: 0.08 });
  }

  /** Descending detune zap — task failed. */
  taskFailed(): void {
    if (this.ctx === null || this.master === null || this.muted) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(440, t);
    osc.frequency.exponentialRampToValueAtTime(110, t + 0.35);
    gain.gain.setValueAtTime(0.22, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
    osc.connect(gain).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.42);
  }

  /** Two-tone alarm: 880↔660 Hz square wave for ~0.6s. AIMD / cluster failure. */
  klaxon(): void {
    if (this.ctx === null || this.master === null || this.muted) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(880, t);
    osc.frequency.setValueAtTime(660, t + 0.15);
    osc.frequency.setValueAtTime(880, t + 0.3);
    osc.frequency.setValueAtTime(660, t + 0.45);
    gain.gain.setValueAtTime(0.18, t);
    gain.gain.setValueAtTime(0.18, t + 0.55);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.6);
    osc.connect(gain).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.62);
  }

  /**
   * Ambient looping low thrum — gain scales with `loadFraction` ∈ [0, 1].
   * Bass sawtooth + lowpass → "the cluster is busy." First call starts
   * the oscillator; subsequent calls just adjust the gain over 0.5s
   * so changes feel smooth.
   */
  setThrum(loadFraction: number): void {
    if (this.ctx === null || this.master === null) return;
    const target = THRUM_BASE_GAIN + (THRUM_MAX_GAIN - THRUM_BASE_GAIN) * Math.min(1, loadFraction);
    if (this.thrumOsc === null || this.thrumGain === null) {
      const osc = this.ctx.createOscillator();
      const filter = this.ctx.createBiquadFilter();
      const gain = this.ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.value = 55;
      filter.type = 'lowpass';
      filter.frequency.value = 180;
      filter.Q.value = 0.7;
      gain.gain.value = 0;
      osc.connect(filter).connect(gain).connect(this.master);
      osc.start();
      this.thrumOsc = osc;
      this.thrumGain = gain;
    }
    const t = this.ctx.currentTime;
    this.thrumGain.gain.cancelScheduledValues(t);
    this.thrumGain.gain.linearRampToValueAtTime(
      this.muted || this.thrumMuted ? 0 : target,
      t + 0.5,
    );
  }

  /** Quick beep helper — single oscillator with attack/decay envelope. */
  private beep(opts: {
    freq: number;
    type: OscillatorType;
    dur: number;
    peak: number;
    delay?: number;
  }): void {
    if (this.ctx === null || this.master === null || this.muted) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + (opts.delay ?? 0);
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = opts.type;
    osc.frequency.value = opts.freq;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(opts.peak, t + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.001, t + opts.dur);
    osc.connect(gain).connect(this.master);
    osc.start(t);
    osc.stop(t + opts.dur + 0.02);
  }
}

/**
 * Module-level singleton — the command view is a single mounted
 * surface; one engine is fine.
 */
export const sound = new SoundEngine();
