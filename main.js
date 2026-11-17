import { effect, setMusic, unlockAudio, wireAudio } from "./audio.js";
import { inputPayload, Message, openParty } from "./connection.js";
import { openPractice } from "./practice-room.js";
import { CRATE_DEBRIS_MS, makePreview, makeRenderer } from "./renderer.js";
import { playerColors } from "./player-model.js";
import { roomSkinFaces, wirePlayerSkin } from "./player-skin.js";
import arena from "./rules/arena.js";
import { isBorderLane } from "./rules/combat.js";
import { INPUT_STEP_MS, movePlayer, NO_DIRECTION } from "./rules/movement.js";

const $ = (id) => document.getElementById(id);
const controls = $("help-dialog");
const sound = $("sound-dialog");
const skinSettings = $("skin-dialog");
const screens = ["home", "lobby", "game", "results"];
const HURRY_WARNING_MS = 3000;
const LATE_MUSIC_REMAINING_MS = 60_000;
const render = makeRenderer($("arena"));
const width = arena.rows[0].length;
const depth = arena.rows.length;
const arenaPan = (x = (width - 1) / 2) => .7 * (2 * x / (width - 1) - 1);
const codeAt = (x, z) => `${x},${z}`;
const tileMap = (items) => new Map(items.map((item) => [codeAt(item.x, item.z), item]));
const keyDirs = new Map([
  ["ArrowRight", 0], ["KeyD", 0], ["ArrowLeft", 1], ["KeyA", 1],
  ["ArrowDown", 2], ["KeyS", 2], ["ArrowUp", 3], ["KeyW", 3],
]);

let screen = "home";
let room = null;
let request = null;
let practice = false;
let lobby = null;
let epoch = 0;
let crates = new Map();
const breakingCrates = new Map();
let bombs = new Map();
let pickups = new Map();
let blasts = [];
let deaths = [];
let tracks = new Map();
let falling = [];
let landed = new Set();
let fallIndex = 0;
let displayTime = 0;
let hurry = false;
let local = null;
let pending = [];
let unsent = [];
let sequence = 0;
let lastDirections = "";
let place = false;
let pendingTurn;
let tickAt = performance.now();
let accumulator = 0;
let lastTimerSecond = -1;
const pressed = new Map();
const fuseTicks = new Map();

let localSkin;
const remoteSkins = new Map();
const updatePreviewSkin = makePreview($("preview"));
wirePlayerSkin(skinSettings, (skin) => {
  localSkin = skin;
  updatePreviewSkin(skin?.faces);
  shareSkin();
});
wireAudio({ music: $("music"), effects: $("effects"), muted: $("muted") });
setMusic("menu");

function showScreen(next) {
  if (screen === next) return;
  for (const id of screens) $(id).hidden = id !== next;
  if (controls.open) controls.close();
  if (sound.open) sound.close();
  if (skinSettings.open) skinSettings.close();
  $("round-clock").hidden = next !== "game";
  document.body.dataset.screen = next;
  screen = next;
  clearControls();
  if (next === "game") $("arena").focus({ preventScroll: true });
}

function text(id, value) {
  const node = $(id);
  if (node.textContent !== String(value)) node.textContent = value;
}

function status(message = "") {
  text("status", message);
  $("status").hidden = !message;
}

function setBusy(busy) {
  for (const id of ["create", "join", "practice", "nickname", "code", "endpoint"]) $(id).disabled = busy;
  $("cancel").hidden = !busy;
}

function resetRound(roundId) {
  epoch = roundId;
  crates = new Map();
  breakingCrates.clear();
  bombs = new Map();
  pickups = new Map();
  tracks = new Map();
  falling = [];
  landed = new Set();
  fallIndex = 0;
  blasts = [];
  deaths = [];
  local = null;
  pending = [];
  unsent = [];
  sequence = 0;
  lastDirections = "";
  lastTimerSecond = -1;
  accumulator = 0;
  hurry = false;
  fuseTicks.clear();
  clearControls();
}

function leave(reason = "") {
  request?.abort();
  request = null;
  const old = room;
  room = null;
  old?.close();
  lobby = null;
  remoteSkins.clear();
  resetRound(0);
  setBusy(false);
  showScreen("home");
  setMusic("menu");
  status(typeof reason === "string" ? reason : "");
}

async function connect(mode) {
  if (request) return;
  const code = mode === "join" ? $("code").value.trim() : "";
  if (mode === "join" && !code) {
    status("Enter the room code you want to join.");
    $("code").focus();
    return;
  }
  const operation = new AbortController();
  request = operation;
  practice = mode === "practice";
  setBusy(true);
  status(practice ? "Loading arena…" : code ? "Joining room…" : "Creating room…");
  const nickname = $("nickname").value.trim();

  try {
    const receive = (type, data) => {
      if (request === operation) onMessage(type, data);
    };
    const connected = practice
      ? await openPractice(nickname, receive)
      : await openParty($("endpoint").value.trim(), code, nickname, operation.signal, receive, (message) => {
        if (request === operation) leave(message);
      });
    if (request !== operation) {
      connected.close();
      return;
    }
    room = connected;
    setBusy(false);
    status();
    connected.start?.();
  } catch (error) {
    if (request === operation) leave(error.message);
  }
}

function shareSkin() {
  if (!room || practice || !lobby?.playerSkins) return;
  const sheet = localSkin?.sheet;
  const pixels = sheet?.getContext("2d").getImageData(0, 0, sheet.width, sheet.height).data;
  room.send(Message.skin, pixels);
}

function updateLobby(state) {
  const previous = lobby;
  if (state.roundId !== epoch) resetRound(state.roundId);
  lobby = state;
  if (state.playerSkins && !previous?.playerSkins && localSkin) shareSkin();
  for (const id of remoteSkins.keys()) {
    if (!state.players.some((player) => player.id === id)) remoteSkins.delete(id);
  }
  if (state.phase === "lobby") {
    if (practice) {
      if (previous && previous.phase !== "lobby") leave();
      return;
    }
    showScreen("lobby");
    setMusic("menu");
    listPlayers(state);
    return;
  }

  if (state.phase === "playing") {
    const newRound = previous?.phase !== "playing" || previous.roundId !== state.roundId;
    showScreen("game");
    if (newRound) {
      effect("start");
      setMusic("battle");
      displayTime = state.roundEndsAt - 120_000;
      text("round-label", `ROUND ${state.roundNumber}`);
      text("game-mode", practice ? "Solo practice" : "Party match");
      text("fire", 1);
      text("bombs", 1);
      text("speed", 0);
      $("round-notice").hidden = true;
    }
    falling = state.suddenDeath?.blocks ?? [];
    return;
  }

  if (state.phase === "ending") {
    showScreen("game");
    if (previous?.phase !== "ending") {
      setMusic("");
      const winnerId = state.results.winnerId;
      effect(winnerId ? (winnerId === room.sessionId ? "win" : "round_lost") : "draw");
      clearControls();
      const winner = state.results.standings.find(({ id }) => id === state.results.winnerId);
      text("round-notice", winner ? `${winner.name} wins!` : practice ? "Practice complete" : "Round draw");
      $("round-notice").hidden = false;
    }
    return;
  }

  if (state.phase === "results") {
    showScreen("results");
    if (previous?.phase !== "results") {
      if (state.results.championId) effect("champion");
      else if (state.results.winnerId === room.sessionId) effect("trophy");
      setMusic("results");
      showResults(state.results);
    }
  }
}

function listPlayers(state) {
  const self = state.players.find(({ id }) => id === room.sessionId);
  const isHost = state.hostId === room.sessionId;
  const allReady = state.players.length > 0 && state.players.every(({ ready }) => ready);
  $("room-code").value = state.roomId;
  text("player-count", `${state.players.length} / ${arena.spawns.length} players`);
  const slots = arena.spawns.map((_, slot) => {
    const entry = state.players.find((player) => player.slot === slot);
    const item = document.createElement("li");
    const name = document.createElement("strong");
    const tags = document.createElement("small");
    if (entry) item.style.setProperty("--slot", playerColors[slot]);
    name.textContent = entry?.name ?? "Open slot";
    tags.textContent = entry ? [
      entry.id === state.hostId && "HOST",
      entry.id === room.sessionId && "YOU",
      entry.ready ? "READY" : "WAITING",
    ].filter(Boolean).join(" · ") : "\u00a0";
    item.append(name, tags);
    return item;
  });
  $("slots").replaceChildren(...slots);
  $("ready").disabled = !self;
  $("ready").dataset.ready = String(!!self?.ready);
  $("ready").classList.toggle("coral", !!self?.ready);
  $("ready").classList.toggle("green", !self?.ready);
  text("ready", self?.ready ? "Not ready" : "Ready up");
  $("start").hidden = !isHost;
  $("start").disabled = !allReady;
  text("lobby-hint", isHost
    ? allReady ? "Everyone is ready. Start when you like." : "All players need to ready up."
    : "Ready up, then wait for the host to start.");
}

function trophy(filled) {
  const icon = $("trophy-template").content.firstElementChild.cloneNode(true);
  if (!filled) icon.classList.add("empty");
  return icon;
}

function showResults(result) {
  const champion = result.championId !== null;
  const winner = result.standings.find(({ id }) => id === result.winnerId);
  text("results-title", champion ? "Match champion!" : `Round ${result.roundNumber} results`);
  text("winner", winner ? winner.name : practice ? "Practice complete" : "Draw");
  text("result-summary", winner ? champion ? "Three round wins" : "Round winner"
    : practice ? "Solo practice" : "No trophy this round");
  $("hero-trophy").replaceChildren(...(winner ? [trophy(true)] : []));
  $("standings").replaceChildren(...result.standings.map((entry) => {
    const row = document.createElement("li");
    const name = document.createElement("strong");
    const trophies = document.createElement("span");
    name.textContent = entry.name;
    row.style.setProperty("--slot", playerColors[entry.slot]);
    if (entry.id === result.winnerId) row.classList.add("awarded");
    trophies.className = "trophies";
    trophies.setAttribute("aria-label", `${entry.trophies} of 3 trophies`);
    for (let index = 0; index < 3; index++) trophies.append(trophy(index < entry.trophies));
    row.append(name, trophies);
    return row;
  }));
  $("retry").hidden = !practice;
}

function onMessage(type, data) {
  if (!room) return;
  switch (type) {
    case Message.lobby:
      updateLobby(data);
      break;
    case Message.players:
      if (screen === "game") updatePlayers(data);
      break;
    case Message.skin: {
      if (!data || data.id === room.sessionId || !lobby?.players.some(({ id }) => id === data.id)) break;
      if (data.pixels === null) remoteSkins.delete(data.id);
      else {
        const skin = roomSkinFaces(data.pixels);
        if (skin) remoteSkins.set(data.id, skin);
      }
      break;
    }
    case Message.crates: {
      const next = tileMap(data);
      // Keep the break effect after the server removes the blocking tile.
      for (const [key, crate] of next) {
        if (crate.destroyAt !== undefined && crate.destroyAt !== crates.get(key)?.destroyAt && !landed.has(key)) {
          breakingCrates.set(key, { ...crate, started: false });
        }
      }
      crates = next;
      break;
    }
    case Message.bombs: {
      const placed = data.find((bomb) => !bombs.has(codeAt(bomb.x, bomb.z)) && bomb.thrownAt === undefined);
      const thrown = data.find((bomb) => !bombs.has(codeAt(bomb.x, bomb.z)) && bomb.thrownAt !== undefined);
      if (placed) effect("place", 60, arenaPan(placed.x));
      if (thrown) effect("throw", 60, arenaPan(thrown.fromX ?? thrown.x));
      bombs = tileMap(data);
      for (const key of fuseTicks.keys()) if (!bombs.has(key)) fuseTicks.delete(key);
      break;
    }
    case Message.pickups:
      pickups = tileMap(data);
      break;
    case Message.blast:
      effect("explosion", 60, arenaPan(data.tiles[0]?.x));
      blasts.push(...data.tiles.map((tile) => ({ ...tile, expiresAt: data.expiresAt })));
      break;
    case Message.death:
      effect("death", 60, arenaPan(data.x));
      deaths.push(data);
      tracks.delete(data.id);
      if (data.id === room.sessionId && local) {
        local = { ...local, x: data.borderX, z: data.borderZ, direction: NO_DIRECTION, alive: false };
        pending = [];
        place = false;
        pendingTurn = undefined;
      }
      break;
  }
}

function openTile(x, z, alive, now) {
  if (!alive) return isBorderLane(x, z, width, depth);
  const key = codeAt(x, z);
  if (arena.rows[z]?.[x] !== "." || landed.has(key)) return false;
  const crate = crates.get(key);
  if (crate && (crate.destroyAt === undefined || now < crate.destroyAt)) return false;
  const bomb = bombs.get(key);
  return !bomb || (bomb.landAt !== undefined && now < bomb.landAt);
}

function applyInput(player, input, now) {
  if (input.border !== !player.alive) return player;
  const position = movePlayer(player, input.primary, input.secondary,
    INPUT_STEP_MS / arena.stepMs * player.speedMultiplier, (x, z) => openTile(x, z, player.alive, now), input.turnInPlace);
  return { ...player, ...position, moving: Math.abs(position.x - player.x) + Math.abs(position.z - player.z) > .001 };
}

function updatePlayers(players) {
  const self = players.find(({ id }) => id === room.sessionId);
  const active = new Set(players.map(({ id }) => id));
  for (const id of tracks.keys()) if (!active.has(id)) tracks.delete(id);
  const now = room.now();
  for (const player of players) {
    if (player.id === room.sessionId) continue;
    const history = tracks.get(player.id) ?? [];
    const previous = history.at(-1);
    if (previous && previous.alive !== player.alive) history.length = 0;
    const moving = previous ? Math.abs(previous.x - player.x) + Math.abs(previous.z - player.z) > .01 : false;
    history.push({ ...player, moving });
    if (history.length > 12) history.shift();
    tracks.set(player.id, history);
  }

  if (!self) {
    local = null;
    pending = [];
    return;
  }
  if (local?.alive && self.alive) {
    if (self.blastRadius > local.blastRadius) effect("pickup_fire");
    else if (self.bombCapacity > local.bombCapacity) effect("pickup_bomb");
    else if (self.skateLevel > local.skateLevel) effect("pickup_speed");
  }
  pending = pending.filter((input) => input.sequence > self.ack && input.border === !self.alive);
  local = { ...self, moving: local?.moving && lobby?.playing };
  for (const input of pending) local = applyInput(local, input, now);
  text("fire", self.blastRadius);
  text("bombs", self.bombCapacity);
  text("speed", self.skateLevel);
}

function remotePlayers(now) {
  const renderAt = now - 100;
  const players = [];
  for (const history of tracks.values()) {
    while (history.length > 1 && history[1].time <= renderAt) history.shift();
    const [a, b] = history;
    const skin = remoteSkins.get(a.id);
    if (!b || renderAt <= a.time) {
      players.push({ ...a, skin });
      continue;
    }
    const fraction = Math.min(1, (renderAt - a.time) / (b.time - a.time));
    players.push({ ...b, skin, x: a.x + (b.x - a.x) * fraction, z: a.z + (b.z - a.z) * fraction });
  }
  return players;
}

function clearControls() {
  pressed.clear();
  place = false;
  pendingTurn = undefined;
}

function pressDirection(key, direction) {
  if (pressed.has(key)) return;
  pendingTurn = { key, direction };
  pressed.set(key, direction);
}

function releaseDirection(key, cancelled = false) {
  pressed.delete(key);
  if (cancelled && pendingTurn?.key === key) pendingTurn = undefined;
}

function activeGame() {
  return screen === "game" && lobby?.playing && !controls.open && !sound.open && !skinSettings.open;
}

function step(now) {
  if (!local || (!local.alive && hurry)) return;
  if (pending.length >= 600) {
    leave("The room stopped responding. Rejoin to continue.");
    return;
  }
  const active = activeGame();
  const directions = active ? [...new Set([...pressed.values()].reverse())] : [];
  const requestedTurn = active ? pendingTurn?.direction : undefined;
  // Sample a short tap once even when both events arrive between simulation ticks.
  if (requestedTurn !== undefined && (lobby.turnWithHeldDirections || directions.length === 0) && requestedTurn !== directions[0]) {
    directions.unshift(requestedTurn);
  }
  const primary = directions[0] ?? NO_DIRECTION;
  const secondary = directions[1] ?? NO_DIRECTION;
  const input = { sequence: ++sequence, primary, secondary, place: place && active, border: !local.alive,
    turnInPlace: requestedTurn === primary && (secondary === NO_DIRECTION || lobby.turnWithHeldDirections) };
  place = false;
  pendingTurn = undefined;
  pending.push(input);
  unsent.push(input);
  local = applyInput(local, input, now);
  const signature = `${primary},${secondary}`;
  if (unsent.length >= 3 || signature !== lastDirections || input.place || input.turnInPlace) {
    const batch = unsent;
    unsent = [];
    room.send(Message.input, inputPayload(epoch, batch));
  }
  lastDirections = signature;
}

function updateFalling(now) {
  while (fallIndex < falling.length && falling[fallIndex].landAt <= now) {
    const tile = falling[fallIndex++];
    const key = codeAt(tile.x, tile.z);
    landed.add(key);
    const crate = breakingCrates.get(key);
    if (crate && tile.landAt <= crate.destroyAt) breakingCrates.delete(key);
    effect("impact", 230, arenaPan(tile.x));
  }
}

function updateArena(now, elapsed) {
  const playing = lobby.phase === "playing";
  const endTime = lobby.roundEndsAt;
  const stoppedAt = lobby.results?.endedAt ?? now;
  displayTime = Math.max(displayTime, Math.min(stoppedAt, now));
  const suddenDeathStartsAt = lobby.suddenDeath?.startsAt ?? Infinity;
  if (playing && !hurry && now >= suddenDeathStartsAt) {
    hurry = true;
    setMusic("hurry");
  } else if (playing && !hurry && endTime - now <= LATE_MUSIC_REMAINING_MS) {
    setMusic("battle_late");
  }
  $("round-clock").classList.toggle("hurry", playing && hurry);
  const seconds = Math.min(120, Math.max(0, Math.ceil((endTime - displayTime) / 1000)));
  if (seconds !== lastTimerSecond) {
    lastTimerSecond = seconds;
    text("timer", `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`);
  }
  if (playing) {
    const notice = $("round-notice");
    const showWarning = displayTime >= suddenDeathStartsAt - HURRY_WARNING_MS && !hurry;
    if (showWarning && notice.hidden) {
      text("round-notice", "HURRY UP!");
      effect("hurry_alert");
    }
    notice.hidden = !showWarning;
  }
  text("game-hint", local?.alive === false && !hurry ? "Steer your boat · Space to throw TNT"
    : !local && hurry ? "Spectating · Sudden death" : "WASD / Arrows to move · Space for TNT");

  updateFalling(Math.min(stoppedAt, now));
  if (playing) {
    accumulator += elapsed;
    while (accumulator >= INPUT_STEP_MS && room) {
      step(now);
      accumulator -= INPUT_STEP_MS;
    }
  }
  if (!room) return;

  for (const [key, bomb] of bombs) {
    const remaining = bomb.detonateAt - now;
    const tick = Math.ceil(remaining / 250);
    if (remaining > 0 && remaining <= 1000 && fuseTicks.get(key) !== tick) {
      fuseTicks.set(key, tick);
      effect(tick <= 2 ? "fuse_urgent" : "fuse", 120, arenaPan(bomb.x));
    }
  }
  blasts = blasts.filter((blast) => blast.expiresAt > now);
  deaths = deaths.filter((death) => death.at + 1000 > now);
  const crateDebris = [];
  for (const [key, crate] of breakingCrates) {
    if (now < crate.destroyAt) continue;
    if (now >= crate.destroyAt + CRATE_DEBRIS_MS) {
      breakingCrates.delete(key);
      continue;
    }
    if (!crate.started) {
      effect("crumble", 60, arenaPan(crate.x));
      crate.started = true;
    }
    crateDebris.push(crate);
  }
  const players = remotePlayers(now);
  if (local) players.push({ ...local, skin: localSkin?.faces });
  render({
    self: room.sessionId,
    players: players.filter((player) => player.alive || (playing && !hurry)),
    crates: crates.values(),
    crateDebris,
    pickups: pickups.values(),
    bombs: bombs.values(),
    blasts,
    deaths,
    falling: falling.slice(0, fallIndex + (playing && hurry ? 3 : 0)),
  }, now);
}

function frame(now) {
  const elapsed = Math.min(85, now - tickAt);
  tickAt = now;
  if (room && lobby && screen === "game") updateArena(room.now(), elapsed);
  if (room && lobby?.results && screen === "results") {
    const result = lobby.results;
    const next = result.championId || lobby.players.length < 2 ? "Returning to lobby" : "Next round";
    const remaining = Math.max(0, Math.ceil((result.countdownEndsAt - room.now()) / 1000));
    text("results-countdown", `${practice ? "Returning to menu" : next} in ${remaining}`);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

const initialParams = new URLSearchParams(location.search);
$("endpoint").value = initialParams.get("server") ??
  (["localhost", "127.0.0.1"].includes(location.hostname)
    ? "http://127.0.0.1:2567"
    : "https://vps73608.publiccloud.com.br");
$("code").value = initialParams.get("room") ?? "";

$("room-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void connect(event.submitter?.value ?? "create");
});
$("code").addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  $("room-form").requestSubmit($("join"));
});
$("practice").addEventListener("click", () => void connect("practice"));
$("retry").addEventListener("click", () => {
  leave();
  void connect("practice");
});
$("cancel").addEventListener("click", () => leave());
$("ready").addEventListener("click", () =>
  room?.send(Message.ready, Uint8Array.of($("ready").dataset.ready === "true" ? 0 : 1)));
$("start").addEventListener("click", () => room?.send(Message.start));
$("copy-code").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("room-code").value);
  } catch {
    $("room-code").select();
    if (!document.execCommand("copy")) {
      text("lobby-hint", "Select and copy the room code.");
      return;
    }
  }
  text("copy-code", "Copied");
  setTimeout(() => text("copy-code", "Copy"), 1350);
});

for (const button of document.querySelectorAll("[data-leave]")) button.addEventListener("click", () => leave());
for (const [selector, dialog] of [
  ["[data-help]", controls], ["[data-sound]", sound], ["[data-skin]", skinSettings],
]) {
  dialog.addEventListener("close", () => {
    if (screen === "game") $("arena").focus({ preventScroll: true });
  });
  for (const button of document.querySelectorAll(selector)) button.addEventListener("click", () => {
    clearControls();
    dialog.showModal();
  });
}

window.addEventListener("keydown", (event) => {
  unlockAudio();
  if (!activeGame() || (event.code === "Space" && event.target.matches?.("input, summary, textarea, button"))) return;
  const direction = keyDirs.get(event.code);
  if (direction !== undefined) {
    event.preventDefault();
    if (!event.repeat) pressDirection(event.code, direction);
  } else if (event.code === "Space") {
    event.preventDefault();
    if (!event.repeat) place = true;
  }
});
window.addEventListener("keyup", (event) => releaseDirection(event.code));
window.addEventListener("blur", clearControls);
document.addEventListener("visibilitychange", () => {
  clearControls();
  accumulator = 0;
});
document.addEventListener("pointerdown", unlockAudio);
document.addEventListener("click", (event) => {
  if (!event.target.closest("button")) return;
  unlockAudio();
  effect("ui_click", 30);
}, true);
document.addEventListener("pointerover", (event) => {
  const button = event.target.closest("button");
  if (button && !button.disabled && !button.contains(event.relatedTarget)) effect("ui_hover", 35);
});

for (const button of document.querySelectorAll("[data-dir]")) {
  button.addEventListener("pointerdown", (event) => {
    if (!activeGame()) return;
    button.setPointerCapture(event.pointerId);
    pressDirection(event.pointerId, Number(button.dataset.dir));
  });
  for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) {
    button.addEventListener(name, (event) => releaseDirection(event.pointerId, name !== "pointerup"));
  }
}
$("touch-tnt").addEventListener("pointerdown", () => { if (activeGame()) place = true; });
$("touch-tnt").addEventListener("click", (event) => { if (event.detail === 0 && activeGame()) place = true; });
