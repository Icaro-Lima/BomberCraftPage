import { localizedText, localizedAttribute, wireLanguageSettings, refreshDetectedLanguage } from "./i18n.js";
import { effect, setAudioActive, setMusic, unlockAudio, wireAudio } from "./audio.js";
import { inputPayload, Message, openParty } from "./connection.js";
import { openPractice } from "./practice-room.js";
import { CRATE_DEBRIS_MS, makePreview, makeRenderer } from "./renderer.js";
import { playerColors } from "./player-model.js";
import { defaultSkin, roomSkinFaces, wirePlayerSkin } from "./player-skin.js";
import { wireJoystick } from "./touch-joystick.js";
import { wireButtonFeedback } from "./button-feedback.js";
import { wireHomeKeyboard } from "./home-keyboard.js";
import { isNativeApp, wireNativeApp } from "./native.js";
import { defaultServer } from "./server-endpoint.js";
import { createFrameMeter } from "./frame-meter.js";
import arena from "./rules/arena.js";
import { isBorderLane } from "./rules/combat.js";
import { INPUT_STEP_MS, movePlayer, NO_DIRECTION } from "./rules/movement.js";

const $ = (id) => document.getElementById(id);
wireButtonFeedback();
wireHomeKeyboard();
wireLanguageSettings();
const controls = $("help-dialog");
const sound = $("sound-dialog");
const skinSettings = $("skin-dialog");
const connectionSettings = $("connection-dialog");
const connectionStatus = $("connection-status-dialog");
const languageSettings = $("language-dialog");
const screens = ["home", "lobby", "game", "results"];
const HURRY_WARNING_MS = 3000;
const LATE_MUSIC_REMAINING_MS = 60_000;
const render = makeRenderer($("arena"));
const frameMeter = createFrameMeter();
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
let resetJoystick;
let copyCodeTimeout;

let localSkin;
const remoteSkins = new Map();
const updatePreviewSkin = makePreview($("preview"));
wirePlayerSkin(skinSettings, (skin) => {
  localSkin = skin;
  updatePreviewSkin(skin?.faces);
  shareSkin();
  refreshPortraits();
});
wireAudio({ music: $("music"), effects: $("effects"), muted: $("muted") });
setMusic("menu");

function showScreen(next) {
  if (screen === next) return;
  for (const id of screens) $(id).hidden = id !== next;
  if (controls.open) controls.close();
  if (sound.open) sound.close();
  if (skinSettings.open) skinSettings.close();
  if (connectionSettings.open) connectionSettings.close();
  if (languageSettings.open) languageSettings.close();
  $("round-clock").hidden = next !== "game";
  document.body.dataset.screen = next;
  screen = next;
  resetFrameMeter();
  clearControls();
  if (next === "game") $("arena").focus({ preventScroll: true });
}

function text(id, value) {
  const node = $(id);
  node.removeAttribute("data-i18n");
  node.removeAttribute("data-i18n-values");
  if (node.textContent !== String(value)) node.textContent = value;
}

function say(id, message, values = {}) {
  localizedText($(id), message, values);
}

function metric(value, prefix = "") {
  return Number.isFinite(value) ? `${prefix}${Math.round(value)}` : "—";
}

$("fps-toggle").addEventListener("click", () => {
  const maximum = $("fps-max");
  maximum.hidden = !maximum.hidden;
  $("fps-toggle").setAttribute("aria-expanded", String(!maximum.hidden));
  localizedAttribute($("fps-toggle"), "aria-label", maximum.hidden ? "Show maximum FPS" : "Hide maximum FPS");
});

function resetFrameMeter() {
  frameMeter.reset();
  text("fps-current", "—");
  text("fps-capacity", "—");
  text("ping", metric(room?.ping));
}

function status(message = "", pending = false) {
  say("status", message);
  say("connection-status-title", pending ? "Connecting…" : "Unable to connect");
  say("cancel", pending ? "Cancel" : "OK");
  connectionStatus.dataset.pending = String(pending);
  if (message) {
    if (!connectionStatus.open) connectionStatus.showModal();
  } else if (connectionStatus.open) connectionStatus.close();
}

function dismissConnectionStatus() {
  if (connectionStatus.dataset.pending === "true") leave();
  else status();
}

function setBusy(busy) {
  for (const id of ["create", "join", "practice", "nickname", "code", "endpoint"]) $(id).disabled = busy;
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
    $("code").focus();
    status("Enter the room code you want to join.");
    return;
  }
  const operation = new AbortController();
  request = operation;
  practice = mode === "practice";
  setBusy(true);
  status(practice ? "Loading arena…" : code ? "Joining room…" : "Creating room…", true);
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
      if (winner) {
        const message = document.createElement("span");
        localizedText(message, "{name} wins!", { name: winner.name });
        text("round-notice", "");
        $("round-notice").replaceChildren(playerPortrait(winner), message);
      } else {
        say("round-notice", practice ? "Practice complete" : "Round draw");
      }
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

function drawPortrait(canvas) {
  const { playerId, slot } = canvas.dataset;
  const faces = playerId === room?.sessionId ? localSkin?.faces : remoteSkins.get(playerId);
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage((faces ?? defaultSkin(Number(slot)).faces).head.front, 0, 0);
}

function playerPortrait(player, large = false) {
  const canvas = document.createElement("canvas");
  canvas.className = `avatar-face${large ? " avatar-face-large" : ""}`;
  const face = defaultSkin(player.slot).faces.head.front;
  canvas.width = face.width;
  canvas.height = face.height;
  canvas.dataset.playerId = player.id;
  canvas.dataset.slot = player.slot;
  canvas.style.setProperty("--slot", playerColors[player.slot]);
  canvas.setAttribute("aria-hidden", "true");
  drawPortrait(canvas);
  return canvas;
}

function refreshPortraits() {
  for (const canvas of document.querySelectorAll(".avatar-face")) drawPortrait(canvas);
}

function listPlayers(state) {
  const self = state.players.find(({ id }) => id === room.sessionId);
  const isHost = state.hostId === room.sessionId;
  const readyCount = state.players.filter(({ ready }) => ready).length;
  const allReady = state.players.length > 0 && state.players.every(({ ready }) => ready);
  text("room-code", state.roomId);
  localizedAttribute($("copy-code"), "aria-label", "Copy party code {code}", { code: state.roomId });
  text("player-count", `${state.players.length} / ${arena.spawns.length}`);
  say("ready-count", "{ready} of {total} ready", { ready: readyCount, total: state.players.length });
  $("ready-progress").max = Math.max(1, state.players.length);
  $("ready-progress").value = readyCount;
  localizedAttribute($("ready-progress"), "aria-valuetext", "{ready} of {total} players ready", { ready: readyCount, total: state.players.length });
  $("lobby").dataset.allReady = String(allReady);
  const slots = arena.spawns.map((_, slot) => {
    const entry = state.players.find((player) => player.slot === slot);
    const item = document.createElement("li");
    const name = document.createElement("strong");
    const tags = document.createElement("div");
    tags.className = "player-tags";
    item.className = "slot-card";
    item.classList.toggle("is-empty", !entry);
    item.classList.toggle("is-ready", !!entry?.ready);
    item.classList.toggle("is-self", entry?.id === room.sessionId);
    if (entry) item.style.setProperty("--slot", playerColors[slot]);
    if (entry) name.textContent = entry.name;
    else localizedText(name, "Open slot");
    if (entry) name.title = entry.name;
    else localizedAttribute(name, "title", "Open slot");
    if (entry) {
      for (const [show, label, role] of [
        [entry.id === state.hostId, "Host", "host"],
        [entry.id === room.sessionId, "You", "self"],
      ]) {
        if (!show) continue;
        const badge = document.createElement("span");
        badge.className = `player-badge ${role}`;
        localizedText(badge, label);
        tags.append(badge);
      }
    } else {
      localizedText(tags, "Invite a friend");
    }
    const details = document.createElement("div");
    details.className = "player-details";
    details.append(name, tags);
    if (entry) item.append(playerPortrait(entry));
    else {
      const placeholder = document.createElement("span");
      placeholder.className = "empty-avatar";
      placeholder.setAttribute("aria-hidden", "true");
      item.append(placeholder);
    }
    item.append(details);
    if (entry) {
      const readiness = document.createElement("span");
      readiness.className = "player-ready";
      localizedText(readiness, entry.ready ? "✓ Ready" : "Not ready");
      item.append(readiness);
    }
    return item;
  });
  const roster = $("slots");
  const rosterScroll = roster.scrollTop;
  roster.replaceChildren(...slots);
  roster.scrollTop = rosterScroll;
  $("ready").disabled = !self;
  $("ready").dataset.ready = String(!!self?.ready);
  $("ready").setAttribute("aria-pressed", String(!!self?.ready));
  $("ready").classList.toggle("green", !!self?.ready);
  $("ready").classList.toggle("violet", !self?.ready);
  localizedAttribute($("ready"), "title", self?.ready ? "Change to not ready" : "Mark yourself ready to play");
  say("ready", self?.ready ? "✓ Ready" : "Ready up");
  $("start").hidden = !isHost;
  $("start").disabled = !allReady;
  say("lobby-hint", isHost
    ? allReady ? "Everyone is ready. Start the game!" : "Everyone needs to be ready before you can start."
    : !self?.ready ? "Ready up when you're set to play."
      : allReady ? "Everyone is ready. Waiting for the host." : "You're ready. Waiting for the other players.");
}

function trophy(filled) {
  const icon = $("trophy-template").content.firstElementChild.cloneNode(true);
  if (!filled) icon.classList.add("empty");
  return icon;
}

function showResults(result) {
  $("results").dataset.playerCount = String(result.standings.length);
  const champion = result.championId !== null;
  const winner = result.standings.find(({ id }) => id === (result.championId ?? result.winnerId));
  say("results-title", champion ? "Match champion!" : "Round {round} results", { round: result.roundNumber });
  if (winner) text("winner", winner.name);
  else say("winner", practice ? "Practice complete" : "Draw");
  say("result-summary", winner ? champion ? "Three round wins" : "Round winner"
    : practice ? "Solo practice" : "No trophy this round");
  $("hero-trophy").replaceChildren(...(winner ? [playerPortrait(winner, true), trophy(true)] : []));
  $("standings").replaceChildren(...result.standings.map((entry) => {
    const row = document.createElement("li");
    const name = document.createElement("strong");
    const trophies = document.createElement("span");
    name.textContent = entry.name;
    name.title = entry.name;
    row.style.setProperty("--slot", playerColors[entry.slot]);
    if (entry.id === result.winnerId) row.classList.add("awarded");
    trophies.className = "trophies";
    localizedAttribute(trophies, "aria-label", "{count} of 3 trophies", { count: entry.trophies });
    for (let index = 0; index < 3; index++) trophies.append(trophy(index < entry.trophies));
    row.append(playerPortrait(entry), name, trophies);
    return row;
  }));
  $("standings").scrollTop = 0;
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
      refreshPortraits();
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
  resetJoystick?.();
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
  return screen === "game" && lobby?.playing && !controls.open && !sound.open && !skinSettings.open && !languageSettings.open;
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
      say("round-notice", "HURRY UP!");
      effect("hurry_alert");
    }
    notice.hidden = !showWarning;
  }
  say("game-hint", local?.alive === false && !hurry ? "Steer your boat · Space to throw TNT"
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
  const drawStartedAt = performance.now();
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
  return performance.now() - drawStartedAt;
}

function frame(now) {
  const elapsed = Math.min(85, now - tickAt);
  tickAt = now;
  if (room && lobby && screen === "game") {
    const drawingMs = updateArena(room.now(), elapsed);
    if (room && screen === "game") {
      const sample = frameMeter.sample(now, drawingMs);
      if (sample) {
        text("fps-current", metric(sample.fps));
        text("fps-capacity", metric(sample.estimatedFps, "~"));
        text("ping", metric(room.ping));
      }
    }
  }
  if (room && lobby?.results && screen === "results") {
    const result = lobby.results;
    const next = result.championId || lobby.players.length < 2 ? "Returning to lobby in {seconds}" : "Next round in {seconds}";
    const remaining = Math.max(0, Math.ceil((result.countdownEndsAt - room.now()) / 1000));
    say("results-countdown", practice ? "Returning to menu in {seconds}" : next, { seconds: remaining });
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

const initialParams = new URLSearchParams(location.search);
$("endpoint").value = defaultServer(location, isNativeApp);
$("code").value = initialParams.get("room") ?? "";

void wireNativeApp({
  onStateChange(isActive) {
    clearControls();
    accumulator = 0;
    tickAt = performance.now();
    resetFrameMeter();
    setAudioActive(isActive);
    if (isActive) refreshDetectedLanguage();
  },
  onBack() {
    for (const dialog of [connectionStatus, controls, sound, skinSettings, connectionSettings, languageSettings]) {
      if (dialog.open) {
        if (dialog === connectionStatus) dismissConnectionStatus();
        else dialog.close();
        return true;
      }
    }
    if (screen !== "home" || request) {
      leave();
      return true;
    }
    return false;
  },
}).catch((error) => console.warn("Could not initialize native app events", error));

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
$("cancel").addEventListener("click", dismissConnectionStatus);
connectionStatus.addEventListener("cancel", (event) => {
  event.preventDefault();
  dismissConnectionStatus();
});
$("ready").addEventListener("click", () =>
  room?.send(Message.ready, Uint8Array.of($("ready").dataset.ready === "true" ? 0 : 1)));
$("start").addEventListener("click", () => room?.send(Message.start));
$("copy-code").addEventListener("click", async () => {
  const code = $("room-code").textContent;
  try {
    await navigator.clipboard.writeText(code);
  } catch {
    const field = document.createElement("textarea");
    field.value = code;
    field.readOnly = true;
    field.style.cssText = "position:fixed;opacity:0;pointer-events:none";
    document.body.append(field);
    let copied = false;
    try {
      field.focus({ preventScroll: true });
      field.select();
      copied = document.execCommand("copy");
    } catch {
      // Some browsers disable both clipboard APIs.
    } finally {
      field.remove();
      $("copy-code").focus({ preventScroll: true });
    }
    if (!copied) {
      say("code-copy-status", "Could not copy the party code.");
      say("lobby-hint", "Could not copy. Try selecting the party code to copy it.");
      return;
    }
  }
  clearTimeout(copyCodeTimeout);
  say("party-code-label", "Copied!");
  say("code-copy-status", "Party code copied.");
  copyCodeTimeout = setTimeout(() => {
    say("party-code-label", "Party code:");
    say("code-copy-status", "");
  }, 1350);
});

for (const button of document.querySelectorAll("[data-leave]")) button.addEventListener("click", () => leave());
for (const [selector, dialog] of [
  ["[data-help]", controls], ["[data-sound]", sound], ["[data-skin]", skinSettings],
  ["[data-connection]", connectionSettings], ["[data-language]", languageSettings],
]) {
  dialog.addEventListener("close", () => {
    if (screen === "game") $("arena").focus({ preventScroll: true });
  });
  for (const button of document.querySelectorAll(selector)) button.addEventListener("click", () => {
    clearControls();
    dialog.showModal();
  });
}

$("game").addEventListener("click", (event) => {
  // Non-modal HUD actions hand keyboard control back to the arena.
  if (event.target.closest("button") && activeGame()) $("arena").focus({ preventScroll: true });
});

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
  resetFrameMeter();
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

resetJoystick = wireJoystick($("joystick"), activeGame, (directions) => {
  for (let direction = 0; direction < 4; direction++) {
    if (!directions.includes(direction)) releaseDirection(`joystick-${direction}`, true);
  }
  // Insert the preferred direction last, as with the keyboard's key ordering.
  for (const direction of [...directions].reverse()) pressDirection(`joystick-${direction}`, direction);
}, $("joystick-area"));
for (const name of ["contextmenu", "selectstart"]) {
  document.querySelector(".touch-controls").addEventListener(name, (event) => event.preventDefault());
  $("joystick-area").addEventListener(name, (event) => event.preventDefault());
}
$("touch-tnt").addEventListener("pointerdown", (event) => {
  if (!activeGame() || event.button !== 0) return;
  event.preventDefault();
  place = true;
});
$("touch-tnt").addEventListener("click", (event) => { if (event.detail === 0 && activeGame()) place = true; });
