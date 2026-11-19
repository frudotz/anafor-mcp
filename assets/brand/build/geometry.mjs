export function pathGeometry(d, curveSteps = 64, includeControls = false) {
  const tokens = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) ?? [];
  const points = [];
  let index = 0;
  let command = '';
  let current = [0, 0];
  let start = [0, 0];
  let previousCubicControl = null;
  const point = (relative) => {
    const x = Number(tokens[index++]);
    const y = Number(tokens[index++]);
    return relative ? [current[0] + x, current[1] + y] : [x, y];
  };
  while (index < tokens.length) {
    if (/^[a-z]$/i.test(tokens[index])) command = tokens[index++];
    const upper = command.toUpperCase();
    const relative = command === command.toLowerCase();
    if (upper === 'M' || upper === 'L') {
      current = point(relative);
      if (upper === 'M') {
        start = current;
        command = relative ? 'l' : 'L';
      }
      points.push(current);
      previousCubicControl = null;
    } else if (upper === 'H') {
      const value = Number(tokens[index++]);
      current = [relative ? current[0] + value : value, current[1]];
      points.push(current);
    } else if (upper === 'V') {
      const value = Number(tokens[index++]);
      current = [current[0], relative ? current[1] + value : value];
      points.push(current);
    } else if (upper === 'C') {
      const p0 = current;
      const p1 = point(relative);
      const p2 = point(relative);
      const p3 = point(relative);
      if (includeControls) points.push(p1, p2);
      for (let step = 1; step <= curveSteps; step++) {
        const t = step / curveSteps;
        const u = 1 - t;
        points.push([
          u ** 3 * p0[0] + 3 * u ** 2 * t * p1[0] + 3 * u * t ** 2 * p2[0] + t ** 3 * p3[0],
          u ** 3 * p0[1] + 3 * u ** 2 * t * p1[1] + 3 * u * t ** 2 * p2[1] + t ** 3 * p3[1],
        ]);
      }
      if (!curveSteps) points.push(p3);
      current = p3;
      previousCubicControl = p2;
    } else if (upper === 'S') {
      const p0 = current;
      const p1 = previousCubicControl
        ? [2 * current[0] - previousCubicControl[0], 2 * current[1] - previousCubicControl[1]]
        : current;
      const p2 = point(relative);
      const p3 = point(relative);
      if (includeControls) points.push(p1, p2);
      for (let step = 1; step <= curveSteps; step++) {
        const t = step / curveSteps;
        const u = 1 - t;
        points.push([
          u ** 3 * p0[0] + 3 * u ** 2 * t * p1[0] + 3 * u * t ** 2 * p2[0] + t ** 3 * p3[0],
          u ** 3 * p0[1] + 3 * u ** 2 * t * p1[1] + 3 * u * t ** 2 * p2[1] + t ** 3 * p3[1],
        ]);
      }
      if (!curveSteps) points.push(p3);
      current = p3;
      previousCubicControl = p2;
    } else if (upper === 'Z') {
      current = start;
      points.push(current);
      command = '';
    } else {
      throw new Error(`Unsupported SVG path command: ${command}`);
    }
  }
  return points;
}

export function bounds(paths, transform = { x: 0, y: 0, scale: 1 }) {
  const points = paths.flatMap((d) =>
    pathGeometry(d).map(([x, y]) => [
      transform.x + x * transform.scale,
      transform.y + y * transform.scale,
    ]),
  );
  return {
    minX: Math.min(...points.map((p) => p[0])),
    minY: Math.min(...points.map((p) => p[1])),
    maxX: Math.max(...points.map((p) => p[0])),
    maxY: Math.max(...points.map((p) => p[1])),
  };
}

export const width = (box) => box.maxX - box.minX;
export const height = (box) => box.maxY - box.minY;
export const centerX = (box) => (box.minX + box.maxX) / 2;
export const centerY = (box) => (box.minY + box.maxY) / 2;
