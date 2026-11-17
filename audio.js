const url = (track, extension) => new URL(`./assets/audio/${track}.${extension}`, import.meta.url);
const tracks = ["menu", "battle", "battle_late", "hurry", "results"];
const effects = [
  "ui_click", "ui_hover", "place", "throw", "fuse", "fuse_urgent", "explosion", "crumble", "impact",
  "pickup_fire", "pickup_bomb", "pickup_speed", "death", "start", "hurry_alert",
  "win", "round_lost", "draw", "trophy", "champion",
];
const musicFade = .32;
const maxEffectVoices = 12;
const duckLevels = { start: .5, hurry_alert: .44, trophy: .62, champion: .46 };
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const keys = { music: .35, effects: .65, muted: false };
try {
  const saved = JSON.parse(localStorage.getItem("bombercraft.sound") ?? "{}");
  for (const key of ["music", "effects"]) {
    if (Number.isFinite(saved?.[key])) keys[key] = clamp(saved[key], 0, 1);
  }
  if (typeof saved?.muted === "boolean") keys.muted = saved.muted;
} catch {
  // Storage can be unavailable in private or restricted browser contexts.
}

let context;
let master;
let musicBus;
let effectsBus;
let duck;
let ready = false;
let resuming = false;
let desiredTrack = "";
let musicRequest = 0;
let musicVoice;
let musicLoadFailed = false;
const samples = new Map();
const voices = new Set();
const lastEffect = new Map();

function volume(immediately = false) {
  if (!context) return;
  const now = context.currentTime;
  const levels = [[master, keys.muted ? 0 : 1], [musicBus, keys.music], [effectsBus, keys.effects]];
  for (const [bus, level] of levels) {
    if (immediately) bus.gain.setValueAtTime(level, now);
    else bus.gain.setTargetAtTime(level, now, .012);
  }
}

export function wireAudio(fields) {
  for (const [key, input] of Object.entries(fields)) {
    if (key === "muted") input.checked = keys.muted;
    else input.value = Math.round(keys[key] * 100);
    input.addEventListener("input", () => {
      keys[key] = key === "muted" ? input.checked : Number(input.value) / 100;
      volume();
      try {
        localStorage.setItem("bombercraft.sound", JSON.stringify(keys));
      } catch {}
    });
  }
  volume();
}

function loadSample(name, extension) {
  if (!samples.has(name)) {
    const load = fetch(url(name, extension)).then((response) => {
      if (!response.ok) throw new Error(`Audio unavailable: ${name}`);
      return response.arrayBuffer();
    }).then((bytes) => context.decodeAudioData(bytes)).catch(() => {
      samples.delete(name);
      return null;
    });
    samples.set(name, load);
  }
  return samples.get(name);
}

function fadeMusic(now) {
  if (!musicVoice) return;
  const { source, gain, startedAt } = musicVoice;
  gain.gain.cancelScheduledValues(now);
  gain.gain.setValueAtTime(clamp((now - startedAt) / musicFade, 0, 1), now);
  gain.gain.linearRampToValueAtTime(0, now + musicFade);
  source.stop(now + musicFade);
  musicVoice = undefined;
}

function syncMusic() {
  const request = ++musicRequest;
  const track = desiredTrack;
  musicLoadFailed = false;
  if (!track) {
    fadeMusic(context.currentTime);
    return;
  }
  void loadSample(track, "ogg").then((buffer) => {
    if (request !== musicRequest || track === musicVoice?.track) return;
    if (!buffer) {
      musicLoadFailed = true;
      return;
    }
    const now = context.currentTime;
    // The two battle arrangements share a bar grid, so the new layers join mid-phrase.
    const offset = track === "battle_late" && musicVoice?.track === "battle"
      ? (now - musicVoice.startedAt) % buffer.duration : 0;
    fadeMusic(now);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    const gain = context.createGain();
    source.connect(gain).connect(musicBus);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(1, now + musicFade);
    source.onended = () => { source.disconnect(); gain.disconnect(); };
    source.start(now, offset);
    musicVoice = { source, gain, track, startedAt: now };
  });
}

export function setMusic(track) {
  if (track === desiredTrack) return;
  desiredTrack = track;
  if (ready) syncMusic();
}

function startAudio() {
  if (ready) {
    if (musicLoadFailed) syncMusic();
    return;
  }
  ready = true;
  syncMusic();
  for (const track of tracks) void loadSample(track, "ogg");
  for (const name of effects) void loadSample(name, "wav");
}

export function unlockAudio() {
  if (!context) {
    const AudioContext = window.AudioContext ?? window.webkitAudioContext;
    if (!AudioContext) return;
    context = new AudioContext();
    master = context.createGain();
    musicBus = context.createGain();
    effectsBus = context.createGain();
    duck = context.createGain();
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -8;
    compressor.ratio.value = 5;
    musicBus.connect(duck).connect(master);
    effectsBus.connect(master);
    master.connect(compressor).connect(context.destination);
    volume(true);
  }
  if (context.state === "running") startAudio();
  else if (!resuming) {
    resuming = true;
    void context.resume().then(startAudio).catch(() => {}).finally(() => { resuming = false; });
  }
}

export function effect(name, cooldown = 60, pan = 0) {
  const now = performance.now();
  if (!context || keys.muted || !keys.effects || now - (lastEffect.get(name) ?? -Infinity) < cooldown) return;
  lastEffect.set(name, now);
  void loadSample(name, "wav").then((buffer) => {
    if (!buffer || context.state !== "running" || keys.muted || !keys.effects || performance.now() - now > 350) return;
    const source = context.createBufferSource();
    source.buffer = buffer;
    const panner = pan && context.createStereoPanner?.();
    if (panner) {
      panner.pan.value = clamp(pan, -1, 1);
      source.connect(panner).connect(effectsBus);
    } else {
      source.connect(effectsBus);
    }
    if (voices.size >= maxEffectVoices) {
      const oldest = voices.values().next().value;
      oldest.stop();
      voices.delete(oldest);
    }
    voices.add(source);
    source.onended = () => {
      voices.delete(source);
      source.disconnect();
      if (panner) panner.disconnect();
    };
    const level = duckLevels[name];
    if (level !== undefined) {
      const start = context.currentTime;
      duck.gain.cancelScheduledValues(start);
      duck.gain.setTargetAtTime(level, start, .025);
      duck.gain.setTargetAtTime(1, start + buffer.duration, .16);
    }
    source.start();
  });
}
