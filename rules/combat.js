                                           

export function addBlast(tiles        , expiresAt        , active                     ) {
  for (const { x, z } of tiles) {
    const key = `${x},${z}`;
    active.set(key, Math.max(active.get(key) ?? 0, expiresAt));
  }
}

export function inBlast(position      , now        , active                             ) {
  return (active.get(`${Math.round(position.x)},${Math.round(position.z)}`) ?? 0) > now;
}

export function isBorderLane(x        , z        , width        , depth        ) {
  return ((x === 0 || x === width - 1) && z >= 0 && z < depth)
    || ((z === 0 || z === depth - 1) && x >= 0 && x < width);
}

export function borderSpawn(position      , width        , depth        )       {
  const x = Math.max(1, Math.min(width - 2, Math.round(position.x)));
  const z = Math.max(1, Math.min(depth - 2, Math.round(position.z)));
  const sides = [{ x, z: 0 }, { x: width - 1, z }, { x, z: depth - 1 }, { x: 0, z }];
  const distance = (tile      ) => Math.abs(tile.x - position.x) + Math.abs(tile.z - position.z);
  return sides.reduce((nearest, tile) => distance(tile) < distance(nearest) ? tile : nearest);
}

export function borderThrowTarget(
  position      , width        , depth        , isOpen                                   ,
)                   {
  const x = Math.round(position.x);
  const z = Math.round(position.z);
  const dx = x === 0 ? 1 : x === width - 1 ? -1 : 0;
  const dz = dx === 0 ? (z === 0 ? 1 : z === depth - 1 ? -1 : 0) : 0;
  if (dx === 0 && dz === 0) return undefined;
  // Lob over the border wall, up to three tiles into the arena.
  for (let distance = 3; distance >= 1; distance--) {
    const tx = x + dx * distance;
    const tz = z + dz * distance;
    if (isOpen(tx, tz)) return { x: tx, z: tz };
  }
}
