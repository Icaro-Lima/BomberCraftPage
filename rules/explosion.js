                                            
                          
                     
                   
                       
                    
                  
                 
                 
  

const DIRECTIONS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export function resolveExplosion(
  first     ,
  bombs                          ,
  softBlocks                           ,
  rows                   ,
  range        ,
) {
  const pending = [first];
  const detonated = new Set([`${first.x},${first.z}`]);
  const destroyed = new Set        ();
  const blast = new Map              ();

  const hit = (x        , z        ) => {
    const key = `${x},${z}`;
    blast.set(key, { x, z });
    const bomb = bombs.get(key);
    if (bomb && !detonated.has(key)) {
      detonated.add(key);
      pending.push(bomb);
    }
  };

  // Resolve against the original map, then apply all destruction together.
  for (const bomb of pending) {
    const { x, z } = bomb;
    const blastRadius = bomb.blastRadius ?? range;
    hit(x, z);
    for (const [dx, dz] of DIRECTIONS) {
      for (let distance = 1; distance <= blastRadius; distance++) {
        const tx = x + dx * distance;
        const tz = z + dz * distance;
        if (rows[tz]?.[tx] !== ".") break;
        const key = `${tx},${tz}`;
        if (softBlocks.has(key)) {
          destroyed.add(key);
          break;
        }
        hit(tx, tz);
      }
    }
  }
  return { tiles: [...blast.values()], detonated, destroyed };
}
