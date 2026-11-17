// The room rules depend on a small part of Colyseus. Practice supplies that
// interface in memory, so its game rules are identical to an online room.
export class Room {
  roomId = "Practice";
  clients = [];
  handlers = new Map();
  intervals = new Set();
  timeouts = new Set();
  clock = {
    setInterval: (callback, duration) => {
      this.intervals.add(setInterval(callback, duration));
    },
    setTimeout: (callback, duration) => {
      const id = setTimeout(() => {
        this.timeouts.delete(id);
        callback();
      }, duration);
      this.timeouts.add(id);
    },
  };

  onMessageBytes(type, callback) {
    this.handlers.set(type, callback);
  }

  setSimulationInterval(callback, duration) {
    let last = performance.now();
    this.clock.setInterval(() => {
      const now = performance.now();
      callback(now - last);
      last = now;
    }, duration);
  }

  broadcast(type, bytes) {
    for (const client of this.clients) client.sendBytes(type, bytes);
  }

  lock() {}
  unlock() {}

  dispose() {
    for (const id of this.intervals) clearInterval(id);
    for (const id of this.timeouts) clearTimeout(id);
    this.intervals.clear();
    this.timeouts.clear();
    this.clients.length = 0;
  }
}

export class ServerError extends Error {}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// The shared lobby writes its JSON messages using Buffer.from().
export const Buffer = { from: (value) => encoder.encode(value) };

export async function openPractice(nickname, onMessage) {
  const { LobbyRoom } = await import("./rules/lobby.js");
  const room = new LobbyRoom();
  const client = {
    sessionId: "local",
    sendBytes(type, bytes) {
      onMessage(type, JSON.parse(decoder.decode(bytes)));
    },
  };

  return {
    sessionId: client.sessionId,
    now: () => performance.now(),
    start() {
      room.onCreate();
      room.clients.push(client);
      room.onJoin(client, { nickname });
      this.send(8, Uint8Array.of(1));
      this.send(9);
    },
    send(type, bytes = new Uint8Array()) {
      room.handlers.get(type)?.(client, bytes);
    },
    close() {
      room.dispose();
    },
  };
}
