export function createFrameMeter(windowMs = 500) {
  let previousTime;
  let frames = 0;
  let elapsedMs = 0;
  let drawingMs = 0;

  function reset() {
    previousTime = undefined;
    frames = 0;
    elapsedMs = 0;
    drawingMs = 0;
  }

  return {
    reset,
    sample(now, drawDuration) {
      if (!Number.isFinite(now) || !Number.isFinite(drawDuration) || drawDuration < 0) return null;
      if (previousTime === undefined) {
        previousTime = now;
        return null;
      }
      const interval = now - previousTime;
      if (interval <= 0) return null;
      previousTime = now;
      frames++;
      elapsedMs += interval;
      drawingMs += drawDuration;
      if (elapsedMs < windowMs) return null;

      const result = {
        fps: frames * 1000 / elapsedMs,
        // Canvas commands may finish on the GPU later. This estimates CPU
        // drawing capacity, independently of display refresh and other work.
        estimatedFps: drawingMs > 0 ? frames * 1000 / drawingMs : null,
      };
      frames = 0;
      elapsedMs = 0;
      drawingMs = 0;
      return result;
    },
  };
}
