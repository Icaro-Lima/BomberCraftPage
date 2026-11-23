export const Message = Object.freeze({
  input: 1, players: 2, bombs: 4, blast: 5, clock: 6, crates: 7,
  ready: 8, start: 9, lobby: 10, pickups: 11, death: 12, skin: 13,
});

const JOIN = 10;
const ERROR = 11;
const LEAVE = 12;
const BYTES = 17;
const NO_DIRECTION = 4;
const decoder = new TextDecoder();

export function inputPayload(roundId, inputs) {
  const bytes = new Uint8Array(4 + inputs.length * 5);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, roundId, true);
  for (const [index, input] of inputs.entries()) {
    const offset = 4 + index * 5;
    view.setUint32(offset, input.sequence, true);
    const { primary } = input;
    let { secondary } = input;
    if (input.turnInPlace) {
      // A repeated direction marks a single press. Codes 5–7 mark a press
      // with one of the three other directions held, in cyclic order.
      secondary = secondary === NO_DIRECTION ? primary :
        NO_DIRECTION + ((secondary - primary + NO_DIRECTION) % NO_DIRECTION);
    }
    bytes[offset + 4] = primary | (secondary << 3) |
      (input.place ? 64 : 0) | (input.border ? 128 : 0);
  }
  return bytes;
}

export async function openParty(endpoint, code, nickname, signal, onMessage, onDisconnect) {
  let base;
  try {
    base = new URL(endpoint);
  } catch {
    throw new Error("Enter an HTTP or HTTPS game server address.");
  }
  if (!["http:", "https:"].includes(base.protocol) || base.search || base.hash ||
      base.username || base.password) {
    throw new Error("Enter an HTTP or HTTPS game server address.");
  }
  const route = code ? `joinById/${encodeURIComponent(code)}` : "create/lobby";
  const address = base.href.replace(/\/+$/, "");
  let reservation;
  try {
    const response = await fetch(`${address}/matchmake/${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nickname }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
    });
    reservation = await response.json();
    if (!response.ok || reservation.error) {
      const error = reservation.error || "Could not create or join the room.";
      if (/no rooms found|not found|does not exist/i.test(error)) {
        throw new Error("Room not found. Check the code and try again.");
      }
      throw new Error(error.endsWith(" is locked") ? "This room is full or a match is already in progress." : error);
    }
  } catch (error) {
    if (signal.aborted) throw error;
    if (error instanceof TypeError || error instanceof SyntaxError || error.name === "TimeoutError") {
      throw new Error("Could not reach the game server. Check the server address in Connection.");
    }
    throw error;
  }

  const { roomId, sessionId, processId } = reservation;
  if (!roomId || !sessionId || !processId) throw new Error("The server returned an incomplete room reservation.");

  let socket;
  let joined = false;
  let closed = false;
  let clockSent = null;
  let clockOffset = 0;
  let bestRtt = Infinity;
  let ping = null;
  let clockTimer;
  let handshakeTimer;
  let room;
  const probe = () => {
    if (clockSent !== null && performance.now() - clockSent < 1000) return;
    clockSent = performance.now();
    room.send(Message.clock);
  };
  const cleanup = () => {
    clearTimeout(handshakeTimer);
    clearInterval(clockTimer);
    signal.removeEventListener("abort", abort);
  };
  const close = () => {
    if (closed) return;
    closed = true;
    cleanup();
    if (joined && socket.readyState === WebSocket.OPEN) socket.send(Uint8Array.of(LEAVE));
    socket.close();
  };
  const abort = () => close();

  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const url = address.replace(/^http/, "ws") +
      `/${encodeURIComponent(processId)}/${encodeURIComponent(roomId)}?sessionId=${encodeURIComponent(sessionId)}`;
    socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    room = {
      sessionId,
      now: () => performance.now() + clockOffset,
      get ping() { return ping; },
      send(type, bytes = new Uint8Array()) {
        if (!joined || closed || socket.readyState !== WebSocket.OPEN) return;
        const packet = new Uint8Array(bytes.length + 2);
        packet.set([BYTES, type]);
        packet.set(bytes, 2);
        socket.send(packet);
      },
      close,
    };
    const fail = (reason) => {
      const expected = closed;
      close();
      if (!joined) reject(signal.aborted ? signal.reason : new Error(reason));
      else if (!expected) onDisconnect(reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    handshakeTimer = setTimeout(() => fail("Room connection timed out."), 8000);
    socket.onclose = () => fail("Room connection closed.");
    socket.onmessage = ({ data }) => {
      const packet = new Uint8Array(data);
      if (packet[0] === ERROR) {
        fail("The server rejected the room connection.");
      } else if (packet[0] === JOIN && !joined) {
        clearTimeout(handshakeTimer);
        socket.send(Uint8Array.of(JOIN));
        joined = true;
        probe();
        clockTimer = setInterval(probe, 1100);
        resolve(room);
      } else if (packet[0] === BYTES && packet.length > 2) {
        const type = packet[1];
        const value = JSON.parse(decoder.decode(packet.subarray(2)));
        if (type === Message.clock && clockSent !== null) {
          const rtt = performance.now() - clockSent;
          ping = rtt;
          if (rtt <= bestRtt) {
            bestRtt = rtt;
            clockOffset = value - clockSent - rtt / 2;
          }
          clockSent = null;
        } else {
          // Clock estimates are only needed for snapshots. Until the first
          // probe replies, a snapshot still gives a usable starting offset.
          if (bestRtt === Infinity && type === Message.players && value.length) {
            clockOffset = value[0].time - performance.now();
          }
          onMessage(type, value);
        }
      }
    };
  });
}
