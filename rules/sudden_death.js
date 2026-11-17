                                           

export const HURRY_REMAINING_MS = 40_000;
export const FALL_MS = 650;
                                                                     

// Clockwise inward spiral, starting at the inner top-left corner.
export function suddenDeathPlan(rows                   , roundEndsAt        ) {
  const startsAt = roundEndsAt - HURRY_REMAINING_MS;
  const tiles         = [];
  const add = (x        , z        ) => { tiles.push({ x, z }); };
  let left = 1, right = rows[0].length - 2, top = 1, bottom = rows.length - 2;
  while (left <= right && top <= bottom) {
    for (let x = left; x <= right; x++) add(x, top);
    top++;
    for (let z = top; z <= bottom; z++) add(right, z);
    right--;
    if (top <= bottom) {
      for (let x = right; x >= left; x--) add(x, bottom);
      bottom--;
    }
    if (left <= right) {
      for (let z = bottom; z >= top; z--) add(left, z);
      left++;
    }
  }
  // Hard blocks take a turn in the spiral, up to the last actual drop.
  const lastIndex = tiles.findLastIndex(({ x, z }) => rows[z]?.[x] === ".");
  const dropWindow = HURRY_REMAINING_MS - FALL_MS;
  const blocks                 = tiles.slice(0, lastIndex + 1).flatMap((tile, index) => {
    if (rows[tile.z]?.[tile.x] !== ".") return [];
    // Use the deadline directly for the final impact, including one-tile boards.
    const landAt = index === lastIndex
      ? roundEndsAt
      : startsAt + FALL_MS + dropWindow * index / lastIndex;
    return [{ ...tile, fallAt: landAt - FALL_MS, landAt }];
  });
  return { startsAt, blocks };
}
