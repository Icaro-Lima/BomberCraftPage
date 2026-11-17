                                                             
                                                            
                                                

export const INPUT_STEP_MS = 1000 / 60;
export const NO_DIRECTION = 4;
const DIRECTIONS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const EPSILON = 0.000001;
const POSITION_PRECISION = 100000;

// Godot stores Vector2 components as float32. Use the same position precision on both sides.
function result(position          , direction        )           {
  return {
    x: Math.round(position.x * POSITION_PRECISION) / POSITION_PRECISION,
    z: Math.round(position.z * POSITION_PRECISION) / POSITION_PRECISION,
    direction,
  };
}

// Positions follow the graph of open tile centers, including its edges.
export function movePlayer(
  position          ,
  primary        ,
  secondary        ,
  distance        ,
  isOpen        ,
  turnInPlace = false,
)           {
  const start = result(position, position.direction ?? NO_DIRECTION);
  distance = Math.floor(distance * POSITION_PRECISION + EPSILON) / POSITION_PRECISION;
  const lastDirection = position.direction ?? NO_DIRECTION;
  const blockedDirection = turnInPlace && primary !== NO_DIRECTION ? primary : lastDirection;
  const originX = Math.round(start.x);
  const originZ = Math.round(start.z);
  // A player may leave a bomb placed under them until they leave its tile.
  const canEnter         = (x, z) => (x === originX && z === originZ) || isOpen(x, z);

  if (primary !== NO_DIRECTION && secondary !== NO_DIRECTION && (primary < 2) !== (secondary < 2)) {
    let { x, z } = start;
    let direction = lastDirection;
    let budget = distance;
    while (budget > EPSILON) {
      const betweenColumns = Math.abs(x - Math.round(x)) > EPSILON;
      const betweenRows = Math.abs(z - Math.round(z)) > EPSILON;
      // Finish the current segment, then try the other held direction at each junction.
      const freshPress = turnInPlace && budget === distance;
      let preferred = !freshPress && direction === primary ? secondary : primary;
      if (betweenColumns) preferred = primary < 2 ? primary : secondary;
      if (betweenRows) preferred = primary >= 2 ? primary : secondary;
      const options = betweenColumns || betweenRows ? [preferred] : [preferred, preferred === primary ? secondary : primary];
      let travel = 0;
      for (const candidate of options) {
        const [dx, dz] = DIRECTIONS[candidate];
        const horizontal = dx !== 0;
        const coordinate = horizontal ? x : z;
        const sign = horizontal ? dx : dz;
        const next = sign > 0 ? Math.floor(coordinate + EPSILON) + 1 : Math.ceil(coordinate - EPSILON) - 1;
        if (!canEnter(horizontal ? next : Math.round(x), horizontal ? Math.round(z) : next)) continue;
        travel = Math.min(Math.abs(next - coordinate), budget);
        x += dx * travel;
        z += dz * travel;
        direction = candidate;
        break;
      }
      if (travel <= EPSILON) break;
      budget -= travel;
    }
    return result({ x, z }, budget === distance ? blockedDirection : direction);
  }

  const attempt = (direction        )           => {
    if (direction === NO_DIRECTION) return start;
    const [dx, dz] = DIRECTIONS[direction];
    const horizontal = dx !== 0;
    const sign = horizontal ? dx : dz;
    const along = horizontal ? start.x : start.z;
    const across = horizontal ? start.z : start.x;
    const lane = Math.round(across);
    const junction = Math.round(along);
    const aheadX = horizontal ? junction + sign : lane;
    const aheadZ = horizontal ? lane : junction + sign;
    let budget = distance;

    if (Math.abs(across - lane) > EPSILON) {
      const junctionX = horizontal ? junction : lane;
      const junctionZ = horizontal ? lane : junction;
      if (!canEnter(junctionX, junctionZ) || !isOpen(aheadX, aheadZ)) return start;
      const alignment = Math.min(Math.abs(across - lane), budget);
      const aligned = across + Math.sign(lane - across) * alignment;
      budget -= alignment;
      if (Math.abs(aligned - lane) > EPSILON) {
        return horizontal ? { x: along, z: aligned } : { x: aligned, z: along };
      }
    }

    let coordinate = along;
    while (budget > EPSILON) {
      const next = sign > 0 ? Math.floor(coordinate + EPSILON) + 1 : Math.ceil(coordinate - EPSILON) - 1;
      const x = horizontal ? next : lane;
      const z = horizontal ? lane : next;
      if (!canEnter(x, z)) break;
      const travel = Math.min(Math.abs(next - coordinate), budget);
      coordinate += sign * travel;
      budget -= travel;
    }
    return horizontal ? { x: coordinate, z: lane } : { x: lane, z: coordinate };
  };

  const moved = attempt(primary);
  if (Math.abs(moved.x - start.x) + Math.abs(moved.z - start.z) > EPSILON) {
    return result(moved, primary);
  }
  if (primary !== NO_DIRECTION && secondary !== NO_DIRECTION && (primary < 2) === (secondary < 2)) {
    return result(start, blockedDirection);
  }
  const fallback = attempt(secondary);
  const usedFallback = Math.abs(fallback.x - start.x) + Math.abs(fallback.z - start.z) > EPSILON;
  return result(fallback, usedFallback ? secondary : blockedDirection);
}
