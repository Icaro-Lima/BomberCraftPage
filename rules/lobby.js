import { Room, ServerError, Buffer } from "../practice-room.js";
import { INPUT_STEP_MS, NO_DIRECTION, movePlayer } from "./movement.js";
import { resolveExplosion,                     } from "./explosion.js";
import { applyPowerUp, rollPowerUp, speedMultiplier, startingUpgrades,                                 } from "./powerups.js";
import { addBlast, borderSpawn, borderThrowTarget, inBlast, isBorderLane } from "./combat.js";
import { suddenDeathPlan } from "./sudden_death.js";
import { hasSkinSignature, SKIN_V1_RGBA_BYTES } from "../player-model.js";
import arena from "./arena.js";

const FUSE_MS = 2400;
const ROUND_DURATION_MS = 120_000;
const ROUND_END_PAUSE_MS = 3000;
const RESULTS_ZERO_HOLD_MS = 800;
const BLAST_SETTLE_MS = 750;
const BORDER_THROW_FLIGHT_MS = 450;
const BORDER_THROW_COOLDOWN_MS = 1000;
const ARENA_WIDTH = arena.rows[0].length;
const ARENA_DEPTH = arena.rows.length;
const BLAST_RANGE = arena.powerUps.startingBlastRadius;
const BLAST_ACTIVE_MS = 500;
const SOFT_BLOCK_CLEAR_MS = BLAST_ACTIVE_MS + 13 * (1000 / 60);
const SKIN_UPDATE_INTERVAL_MS = 500;
const SKIN_MESSAGE = 13;
const SPAWN_CLEAR_OFFSETS = [[0, 0], [0, -1], [0, 1], [-1, 0], [1, 0]];

                                                               

                          
               
               
                 
                   
                 
                        
                      
            
            
                    
              
                   
                 
                    
                                                                                                                            
  

export class LobbyRoom extends Room {
  maxClients = arena.spawns.length;
  maxMessagesPerSecond = 90;
          softBlocks = new Map                   ();
          hiddenPowerUps = new Map                     ();
          powerUps = new Map                                      ();
          hostId = "";
          playing = false;
          phase                                             = "lobby";
          roundId = 0;
          roundNumber = 0;
          participants = new Set        ();
          competitive = false;
          results                                                                                                                                                                                                                                                                 = null;
          roundEndsAt                = null;
          suddenDeath                                            = null;
          suddenActive = false;
          nextFallingBlock = 0;
          landedBlocks = new Set        ();
          blastRows           = [...arena.rows];
          activeBlasts = new Map                ();
          tnt = new Map             ();
          players = new Map                ();
          changedSkins = new Set        ();
          skinUpdateScheduled = false;

  onCreate() {
    this.onMessageBytes(1, (client, bytes) => this.receiveInputs(client, bytes));
    this.onMessageBytes(6, (client, bytes) => {
      if (bytes.length === 0) client.sendBytes(6, Buffer.from(JSON.stringify(performance.now())));
    });
    this.onMessageBytes(8, (client, bytes) => {
      const player = this.players.get(client.sessionId);
      if (this.phase !== "lobby" || !player || bytes.length !== 1 || bytes[0] > 1) return;
      player.ready = bytes[0] === 1;
      this.publishLobby();
    });
    this.onMessageBytes(9, (client, bytes) => this.startRound(client, bytes));
    this.onMessageBytes(SKIN_MESSAGE, (client, bytes) => this.receiveSkin(client, bytes));
    this.setSimulationInterval(delta => this.simulate(delta), INPUT_STEP_MS);
    this.clock.setInterval(() => {
      if (this.playing || this.phase === "ending") this.publish();
    }, 50);
  }

          startRound(client        , bytes            ) {
    if (this.phase !== "lobby" || bytes.length !== 0 || client.sessionId !== this.hostId) return;
    if (this.players.size === 0 || [...this.players.values()].some(player => !player.ready)) return;
    this.roundNumber = 0;
    for (const player of this.players.values()) player.trophies = 0;
    this.beginRound();
  }

          beginRound() {
    this.playing = true;
    this.phase = "playing";
    void this.lock();
    this.results = null;
    this.roundId++;
    this.roundNumber++;
    this.participants = new Set(this.players.keys());
    this.competitive = this.participants.size >= 2;
    this.roundEndsAt = performance.now() + ROUND_DURATION_MS;
    this.suddenDeath = suddenDeathPlan(arena.rows, this.roundEndsAt);
    this.suddenActive = false;
    this.nextFallingBlock = 0;
    this.landedBlocks.clear();
    this.blastRows = [...arena.rows];
    this.tnt.clear();
    this.activeBlasts.clear();
    this.powerUps.clear();
    this.hiddenPowerUps.clear();
    this.softBlocks.clear();
    for (const [z, row] of arena.rows.entries()) {
      for (let x = 0; x < row.length; x++) {
        if (row[x] === "." && Math.random() < arena.softBlockDensity) {
          this.softBlocks.set(`${x},${z}`, { x, z });
        }
      }
    }
    for (const player of this.players.values()) {
      const [x, z] = arena.spawns[player.slot];
      Object.assign(player, startingUpgrades(), { x, z, alive: true, invulnerable: false, ready: false,
        direction: NO_DIRECTION, ack: 0, received: 0, credit: 0, nextThrowAt: 0, inputs: [] });
      for (const [dx, dz] of SPAWN_CLEAR_OFFSETS) {
        this.softBlocks.delete(`${x + dx},${z + dz}`);
      }
    }
    for (const key of this.softBlocks.keys()) {
      const kind = rollPowerUp();
      if (kind) this.hiddenPowerUps.set(key, kind);
    }
    // Announce the epoch before snapshots so clients discard all previous-round prediction.
    this.publishLobby();
    this.broadcast(4, this.tntSnapshot());
    this.broadcast(7, this.softBlockSnapshot());
    this.broadcast(11, this.powerUpSnapshot());
    this.publish();
  }

          evaluateRound(now        ) {
    if (!this.playing) return;
    const survivors = [...this.players].filter(([id, player]) => this.participants.has(id) && player.alive);
    if (survivors.length > 1 && now < this.roundEndsAt ) return;
    if (!this.competitive && survivors.length === 1 && now < this.roundEndsAt ) return;
    const winnerId = this.competitive && survivors.length === 1 ? survivors[0][0] : null;
    if (winnerId) {
      const winner = this.players.get(winnerId) ;
      winner.trophies++;
      winner.invulnerable = true;
    }
    const championId = winnerId && this.players.get(winnerId) .trophies >= 3 ? winnerId : null;
    const shownAt = Math.max(Math.max(now, performance.now()) + ROUND_END_PAUSE_MS,
      ...[...this.tnt.values()].map(bomb => bomb.detonateAt + BLAST_SETTLE_MS),
      ...[...this.activeBlasts.values()].map(expiry => expiry + 250));
    this.playing = false;
    this.phase = "ending";
    this.results = {
      winnerId, championId, reason: now >= this.roundEndsAt  ? "time" : "elimination",
      roundNumber: this.roundNumber, endedAt: now, shownAt,
      countdownEndsAt: shownAt + (championId ? 10000 : 6000),
      transitionAt: shownAt + (championId ? 10000 : 6000) + RESULTS_ZERO_HOLD_MS,
      standings: [...this.players].map(([id, p]) => ({ id, name: p.name, slot: p.slot, trophies: p.trophies }))
        .sort((a, b) => b.trophies - a.trophies || a.slot - b.slot),
    };
    for (const player of this.players.values()) player.inputs.length = 0;
    this.publish();
    this.publishLobby();
  }

          advanceResults(now        ) {
    if (this.phase === "ending" && this.results && now >= this.results.shownAt) {
      // A stalled event loop must still show every pending explosion before results.
      for (const bomb of this.tnt.values()) {
        if (bomb.detonateAt <= now) this.detonate(bomb);
      }
      const settledAt = Math.max(0,
        ...[...this.tnt.values()].map(bomb => bomb.detonateAt + BLAST_SETTLE_MS),
        ...[...this.activeBlasts.values()].map(expiry => expiry + 250));
      if (settledAt > now) {
        this.results.countdownEndsAt += settledAt - this.results.shownAt;
        this.results.transitionAt += settledAt - this.results.shownAt;
        this.results.shownAt = settledAt;
        this.publishLobby();
        return;
      }
      this.phase = "results";
      this.publishLobby();
    }
    if (this.phase !== "results" || !this.results || now < this.results.transitionAt) return;
    if (!this.results.championId && this.players.size >= 2) {
      this.beginRound();
      return;
    }
    this.phase = "lobby";
    void this.unlock();
    this.roundEndsAt = null;
    this.suddenDeath = null;
    this.suddenActive = false;
    this.results = null;
    for (const player of this.players.values()) {
      player.ready = false;
      player.trophies = 0;
    }
    this.publishLobby();
  }

  onJoin(client        , options                         = {}) {
    if (this.phase !== "lobby") {
      throw new ServerError(4003, "This match is already in progress. Join when everyone returns to the lobby.");
    }
    const occupied = new Set([...this.players.values()].map(player => player.slot));
    const slot = arena.spawns.findIndex((_, index) => !occupied.has(index));
    const [x, z] = arena.spawns[slot];
    const nickname = typeof options.nickname === "string"
      ? Array.from(options.nickname.replace(/[\u0000-\u001f\u007f]/g, "").trim()).slice(0, 20).join("")
      : "";
    this.players.set(client.sessionId, { ...startingUpgrades(), slot, name: nickname || `Player ${slot + 1}`, ready: false, trophies: 0, alive: true, invulnerable: false, nextThrowAt: 0, x, z, direction: NO_DIRECTION, ack: 0, received: 0, credit: 0, inputs: [] });
    if (!this.hostId) this.hostId = client.sessionId;
    this.publishLobby();
    for (const [id, player] of this.players) {
      if (player.skin) client.sendBytes(SKIN_MESSAGE, this.skinSnapshot(id, player.skin));
    }
    client.sendBytes(7, this.softBlockSnapshot());
    client.sendBytes(4, this.tntSnapshot());
    client.sendBytes(11, this.powerUpSnapshot());
    this.publish();
  }

  onLeave(client        ) {
    const now = performance.now();
    // A disconnect between simulation ticks must not settle the deadline before its impact.
    if (this.roundEndsAt !== null && now >= this.roundEndsAt) this.advanceSuddenDeath(now);
    this.players.delete(client.sessionId);
    this.changedSkins.delete(client.sessionId);
    this.participants.delete(client.sessionId);
    if (this.hostId === client.sessionId) this.hostId = this.players.keys().next().value ?? "";
    this.evaluateRound(now);
    this.publish();
    this.publishLobby();
  }

          receiveSkin(client        , bytes            ) {
    const player = this.players.get(client.sessionId);
    if (!player) return;
    if (bytes.length === 0) {
      if (!player.skin) return;
      delete player.skin;
    } else {
      if (bytes.length !== SKIN_V1_RGBA_BYTES || !hasSkinSignature(bytes)) return;
      player.skin = new Uint8Array(bytes);
    }
    this.changedSkins.add(client.sessionId);
    if (this.skinUpdateScheduled) return;
    this.skinUpdateScheduled = true;
    // Send the latest change per player at most once per interval, separately from movement.
    this.clock.setTimeout(() => {
      this.skinUpdateScheduled = false;
      for (const id of this.changedSkins) {
        const current = this.players.get(id);
        if (current) this.broadcast(SKIN_MESSAGE, this.skinSnapshot(id, current.skin));
      }
      this.changedSkins.clear();
    }, SKIN_UPDATE_INTERVAL_MS);
  }

          skinSnapshot(id        , skin             ) {
    return Buffer.from(JSON.stringify({ id, pixels: skin ? btoa(String.fromCharCode(...skin)) : null }));
  }

          receiveInputs(client        , bytes            ) {
    const player = this.players.get(client.sessionId);
    if (!player || !this.playing) return;
    if (bytes.length < 4) return;
    const epoch = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
    if (epoch !== this.roundId) return;
    bytes = bytes.subarray(4);
    if (bytes.length === 0 || bytes.length % 5 !== 0 || bytes.length > 75 || player.inputs.length + bytes.length / 5 > 180) {
      client.leave(4002);
      return;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let offset = 0; offset < bytes.length; offset += 5) {
      const sequence = view.getUint32(offset, true);
      const flags = bytes[offset + 4];
      const primary = flags & 7;
      const encodedSecondary = (flags >> 3) & 7;
      if (sequence !== player.received + 1 || primary > NO_DIRECTION ||
          (primary === NO_DIRECTION && encodedSecondary > NO_DIRECTION)) {
        client.leave(4002);
        return;
      }
      player.received = sequence;
      const pressedWithSecondary = encodedSecondary > NO_DIRECTION;
      const pressedAlone = primary !== NO_DIRECTION && encodedSecondary === primary;
      // Codes 5–7 select one of the other three directions in cyclic order.
      const secondary = pressedWithSecondary ? (primary + encodedSecondary - NO_DIRECTION) % NO_DIRECTION :
        pressedAlone ? NO_DIRECTION : encodedSecondary;
      player.inputs.push({ sequence, primary, secondary,
        turnInPlace: pressedAlone || pressedWithSecondary,
        place: (flags & 64) !== 0, border: (flags & 128) !== 0 });
    }
  }

          simulate(delta        ) {
    const now = performance.now();
    this.advanceResults(now);
    if (!this.playing && this.phase !== "ending") return;
    this.advanceSuddenDeath(now);
    if (!this.playing && this.phase !== "ending") return;
    for (const [key, expiresAt] of this.activeBlasts) {
      if (now >= expiresAt) this.activeBlasts.delete(key);
    }
    for (const bomb of this.tnt.values()) {
      if (bomb.landAt !== undefined && now >= bomb.landAt && inBlast(bomb, now, this.activeBlasts)) {
        this.detonate(bomb);
      }
    }
    this.checkDeaths(now);
    if (!this.playing && this.phase !== "ending") return;
    let clearedBlocks = false;
    let changedPowerUps = false;
    for (const [key, block] of this.softBlocks) {
      if (block.destroyAt !== undefined && now >= block.destroyAt) {
        this.softBlocks.delete(key);
        const kind = this.hiddenPowerUps.get(key);
        this.hiddenPowerUps.delete(key);
        if (kind) {
          this.powerUps.set(key, { x: block.x, z: block.z, kind });
          changedPowerUps = true;
        }
        clearedBlocks = true;
      }
    }
    if (clearedBlocks) this.broadcast(7, this.softBlockSnapshot());
    if (!this.playing) {
      if (changedPowerUps) this.broadcast(11, this.powerUpSnapshot());
      return;
    }
    for (const client of this.clients) {
      const player = this.players.get(client.sessionId);
      if (!player) continue;
      // Bound how far a client can run ahead, while allowing input batches and jitter.
      player.credit = Math.min(12, player.credit + delta / INPUT_STEP_MS);
      while (player.credit >= 1 && player.inputs.length > 0) {
        const input = player.inputs.shift() ;
        player.ack = input.sequence;
        player.credit -= 1;
        // Pre-death packets are acknowledged, but cannot control the border player.
        if (input.border !== !player.alive || (!player.alive && this.suddenActive)) continue;
        const position = movePlayer(
          player, input.primary, input.secondary, INPUT_STEP_MS / arena.stepMs * speedMultiplier(player),
          player.alive
            ? (x, z) => this.openTile(x, z) && !this.bombBlocks(x, z, now)
            : (x, z) => isBorderLane(x, z, ARENA_WIDTH, ARENA_DEPTH),
          input.turnInPlace,
        );
        player.x = position.x;
        player.z = position.z;
        player.direction = position.direction;
        if (player.alive && !player.invulnerable && inBlast(player, now, this.activeBlasts)) {
          this.killPlayer(client.sessionId, player, now);
          this.publish();
          break;
        }
        if (!player.alive) {
          if (input.place) this.placeTnt(client);
          continue;
        }
        const pickupKey = `${Math.round(player.x)},${Math.round(player.z)}`;
        const pickup = this.powerUps.get(pickupKey);
        if (pickup) {
          this.powerUps.delete(pickupKey);
          applyPowerUp(player, pickup.kind);
          changedPowerUps = true;
        }
        if (input.place) this.placeTnt(client);
      }
    }
    if (changedPowerUps) {
      this.broadcast(11, this.powerUpSnapshot());
      this.publish();
    }
    this.evaluateRound(now);
  }

          advanceSuddenDeath(now        ) {
    const plan = this.suddenDeath;
    if (!this.playing || !plan || now < plan.startsAt) return;
    if (!this.suddenActive) {
      this.suddenActive = true;
      this.publishLobby();
      this.publish();
    }
    let changed = false;
    while (this.nextFallingBlock < plan.blocks.length) {
      const block = plan.blocks[this.nextFallingBlock];
      if (now < block.landAt) break;
      this.nextFallingBlock++;
      const key = `${block.x},${block.z}`;
      this.landedBlocks.add(key);
      const row = this.blastRows[block.z];
      this.blastRows[block.z] = row.slice(0, block.x) + "#" + row.slice(block.x + 1);
      this.softBlocks.delete(key);
      this.hiddenPowerUps.delete(key);
      this.powerUps.delete(key);
      this.tnt.delete(key);
      this.activeBlasts.delete(key);
      changed = true;
      for (const [id, player] of this.players) {
        if (player.alive && Math.round(player.x) === block.x && Math.round(player.z) === block.z) {
          this.killPlayer(id, player, block.landAt);
        }
      }
      // Resolve each scheduled impact before catching up later impacts after a stalled tick.
      this.evaluateRound(block.landAt);
      if (!this.playing) break;
    }
    if (changed) {
      this.broadcast(4, this.tntSnapshot());
      this.broadcast(7, this.softBlockSnapshot());
      this.broadcast(11, this.powerUpSnapshot());
      this.publish();
    }
  }

          openTile(x        , z        ) {
    return this.blastRows[z]?.[x] === "." && !this.softBlocks.has(`${x},${z}`);
  }

          bombBlocks(x        , z        , now        ) {
    const bomb = this.tnt.get(`${x},${z}`);
    return bomb !== undefined && (bomb.landAt === undefined || now >= bomb.landAt);
  }

          checkDeaths(now        ) {
    if (this.phase === "ending" || this.phase === "results") return;
    let changed = false;
    for (const [id, player] of this.players) {
      if (player.alive && !player.invulnerable && inBlast(player, now, this.activeBlasts)) {
        this.killPlayer(id, player, now);
        changed = true;
      }
    }
    if (changed) this.publish();
  }

          killPlayer(id        , player        , now        ) {
    if (player.invulnerable || this.phase === "ending" || this.phase === "results") return;
    const { x, z, direction, slot } = player;
    const border = borderSpawn(player, ARENA_WIDTH, ARENA_DEPTH);
    player.alive = false;
    player.x = border.x;
    player.z = border.z;
    player.direction = NO_DIRECTION;
    player.ack = player.received;
    player.inputs.length = 0;
    player.credit = 0;
    this.broadcast(12, Buffer.from(JSON.stringify({
      id, x, z, direction, slot, at: now, borderX: border.x, borderZ: border.z,
    })));
  }

          bombCount(ownerId        ) {
    let count = 0;
    for (const bomb of this.tnt.values()) {
      if (bomb.ownerId === ownerId) count++;
    }
    return count;
  }

          placeTnt(client        ) {
    const player = this.players.get(client.sessionId);
    if (!player || !this.playing || this.bombCount(client.sessionId) >= player.bombCapacity) return;

    const now = performance.now();
    const available = (x        , z        ) => this.openTile(x, z) && !this.tnt.has(`${x},${z}`);
    if (!player.alive && (now < player.nextThrowAt || this.suddenActive || (this.suddenDeath !== null && now >= this.suddenDeath.startsAt))) return;
    const target = player.alive
      ? { x: Math.round(player.x), z: Math.round(player.z) }
      : borderThrowTarget(player, ARENA_WIDTH, ARENA_DEPTH, available);
    if (!target || !available(target.x, target.z)) return;
    const { x, z } = target;
    const key = `${x},${z}`;
    const bomb      = { x, z, detonateAt: now + FUSE_MS, ownerId: client.sessionId, blastRadius: player.blastRadius };
    if (!player.alive) {
      bomb.thrownAt = now;
      bomb.landAt = now + BORDER_THROW_FLIGHT_MS;
      bomb.fromX = player.x;
      bomb.fromZ = player.z;
      player.nextThrowAt = now + BORDER_THROW_COOLDOWN_MS;
    }
    this.tnt.set(key, bomb);
    this.clock.setTimeout(() => {
      if (this.tnt.get(key) === bomb) this.detonate(bomb);
    }, FUSE_MS);
    this.broadcast(4, this.tntSnapshot());
  }

          detonate(first     ) {
    if (!this.playing && this.phase !== "ending") return;
    const now = performance.now();
    this.advanceSuddenDeath(now);
    if ((!this.playing && this.phase !== "ending") || this.tnt.get(`${first.x},${first.z}`) !== first) return;
    const landed = new Map([...this.tnt].filter(([, bomb]) => bomb.landAt === undefined || bomb.landAt <= now));
    const explosion = resolveExplosion(first, landed, this.softBlocks, this.blastRows, BLAST_RANGE);
    for (const key of explosion.detonated) this.tnt.delete(key);
    let burnedPickups = false;
    for (const tile of explosion.tiles) {
      if (this.powerUps.delete(`${tile.x},${tile.z}`)) burnedPickups = true;
    }
    if (burnedPickups) this.broadcast(11, this.powerUpSnapshot());
    const destroyAt = now + SOFT_BLOCK_CLEAR_MS;
    for (const key of explosion.destroyed) {
      const block = this.softBlocks.get(key) ;
      // Further blasts are absorbed without restarting the destruction timer.
      block.hitAt ??= now;
      block.destroyAt ??= destroyAt;
    }
    if (explosion.destroyed.size > 0) this.broadcast(7, this.softBlockSnapshot());
    this.broadcast(4, this.tntSnapshot());
    addBlast(explosion.tiles, now + BLAST_ACTIVE_MS, this.activeBlasts);
    this.broadcast(5, Buffer.from(JSON.stringify({ tiles: explosion.tiles, expiresAt: now + BLAST_ACTIVE_MS })));
    this.checkDeaths(now);
    this.evaluateRound(now);
  }

          softBlockSnapshot() {
    return Buffer.from(JSON.stringify([...this.softBlocks.values()]));
  }

          powerUpSnapshot() {
    return Buffer.from(JSON.stringify([...this.powerUps.values()]));
  }

          tntSnapshot() {
    return Buffer.from(JSON.stringify([...this.tnt.values()]));
  }

          publishLobby() {
    const players = Array.from(this.players, ([id, { slot, name, ready }]) => ({ id, slot, name, ready }));
    this.broadcast(10, Buffer.from(JSON.stringify({
      roomId: this.roomId, hostId: this.hostId, playing: this.playing, phase: this.phase, roundId: this.roundId, roundNumber: this.roundNumber,
      roundEndsAt: this.roundEndsAt, suddenDeath: this.suddenDeath, results: this.results, players,
      turnWithHeldDirections: true, playerSkins: true,
    })));
  }

          publish() {
    const time = performance.now();
    const players = Array.from(this.players).filter(([, player]) => player.alive || (this.playing && !this.suddenActive)).map(([id, player]) => ({
      id, slot: player.slot, x: player.x, z: player.z, direction: player.direction,
      ack: player.ack, time, alive: player.alive, invulnerable: player.invulnerable, blastRadius: player.blastRadius, bombCapacity: player.bombCapacity,
      skateLevel: player.skateLevel, speedMultiplier: speedMultiplier(player), bombCount: this.bombCount(id),
      bombReady: !player.alive && !this.suddenActive && this.bombCount(id) < player.bombCapacity && time >= player.nextThrowAt,
    }));
    this.broadcast(2, Buffer.from(JSON.stringify(players)));
  }
}
