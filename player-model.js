// All dimensions and pivots are in model pixels. One tile is 16 model pixels.
export const TILE_PIXELS = 16;

export const playerColors = [
  "#4acbff", "#ff7591", "#ffd451", "#81e77e", "#bc8dff", "#ffa254", "#51e3ca", "#f0b9ff",
];

// Version 1 is a permanent file format. Add a new reader for future layouts.
export const SKIN_V1 = Object.freeze({
  width: 64,
  height: 32,
  signatureX: 60,
  signatureY: 31,
  signature: Object.freeze([66, 67, 83, 255, 75, 73, 78, 255, 86, 49, 33, 255, 16, 64, 32, 255]),
});

export function boxFaces([u, v], [width, height, depth]) {
  return {
    left: [u, v + depth, depth, height],
    front: [u + depth, v + depth, width, height],
    right: [u + depth + width, v + depth, depth, height],
    back: [u + 2 * depth + width, v + depth, width, height],
    top: [u + depth, v, width, depth],
    bottom: [u + depth + width, v, width, depth],
  };
}

function part(name, pivot, corner, size, atlas) {
  return { name, pivot, corner, size, faces: boxFaces(atlas, size) };
}

// XYZ coordinates use +X screen-right when facing forward, +Y up, +Z forward.
export const PLAYER_PARTS = [
  part("head", [0, 17, 0], [-5, 0, -4], [10, 7, 8], [0, 0]),
  part("torso", [0, 17, 0], [-4, -9, -3], [8, 9, 6], [36, 0]),
  part("leftArm", [-5, 16, 0], [-2, -8, -2], [3, 9, 4], [0, 16]),
  part("rightArm", [5, 16, 0], [-1, -8, -2], [3, 9, 4], [14, 16]),
  part("leftLeg", [-2, 8, 0], [-2, -8, -2], [3, 8, 4], [28, 16]),
  part("rightLeg", [2, 8, 0], [-1, -8, -2], [3, 8, 4], [42, 16]),
];

// Quad winding and UV orientation both start at the top-left of each face
// as seen from outside. The bottom has its own rectangle.
export const PLAYER_FACES = {
  left: [4, 7, 3, 0],
  front: [7, 6, 2, 3],
  right: [6, 5, 1, 2],
  back: [5, 4, 0, 1],
  top: [4, 5, 6, 7],
  bottom: [3, 2, 1, 0],
};

export function partVertices([left, bottom, back], [width, height, depth]) {
  const right = left + width;
  const top = bottom + height;
  const front = back + depth;
  return [
    [left, bottom, back], [right, bottom, back], [right, bottom, front], [left, bottom, front],
    [left, top, back], [right, top, back], [right, top, front], [left, top, front],
  ];
}
