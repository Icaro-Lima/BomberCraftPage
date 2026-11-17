import arena from "./arena.js";

export const POWER_UP_TYPES = ["fire", "bomb", "skate"]         ;
                                                        
                                                                                         

export function startingUpgrades()           {
  return {
    blastRadius: arena.powerUps.startingBlastRadius,
    bombCapacity: arena.powerUps.startingBombCapacity,
    skateLevel: 0,
  };
}

export function applyPowerUp(player          , kind             ) {
  switch (kind) {
    case "fire":
      player.blastRadius = Math.min(player.blastRadius + 1, arena.powerUps.maxBlastRadius);
      break;
    case "bomb":
      player.bombCapacity = Math.min(player.bombCapacity + 1, arena.powerUps.maxBombCapacity);
      break;
    case "skate":
      player.skateLevel = Math.min(player.skateLevel + 1, arena.powerUps.maxSkateLevel);
      break;
  }
}

export function speedMultiplier(player          ) {
  return 1 + player.skateLevel * arena.powerUps.skateSpeedIncrease;
}

export function rollPowerUp(random = Math.random)                          {
  if (random() >= arena.powerUps.dropChance) return undefined;
  return POWER_UP_TYPES[Math.floor(random() * POWER_UP_TYPES.length)];
}
