import type { APIRoute } from 'astro';

type Vec3 = [number, number, number];

const allowedExpression = /^[0-9+\-*/().,\s_tpieEacdgilmnoqrstuxyzMPhAIN]+$/;

function asNumber(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function compileExpression(expression: unknown, fallback: string) {
  const source = String(expression || fallback).trim() || fallback;
  const normalized = source
    .replace(/\bpi\b/gi, 'Math.PI')
    .replace(/\bsin\b/g, 'Math.sin')
    .replace(/\bcos\b/g, 'Math.cos')
    .replace(/\btan\b/g, 'Math.tan')
    .replace(/\bsqrt\b/g, 'Math.sqrt')
    .replace(/\babs\b/g, 'Math.abs')
    .replace(/\bpow\b/g, 'Math.pow')
    .replace(/\bexp\b/g, 'Math.exp');

  if (!allowedExpression.test(normalized)) {
    throw new Error(`Unsupported expression: ${source}`);
  }

  const fn = new Function('t', `"use strict"; return (${normalized});`);
  return {
    source,
    valueAt(t: number) {
      const value = Number(fn(t));
      if (!Number.isFinite(value)) throw new Error(`Expression did not produce a finite value at t=${t.toFixed(3)}.`);
      return value;
    },
  };
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function addScaled(a: Vec3, b: Vec3, scale: number): Vec3 {
  return [a[0] + b[0] * scale, a[1] + b[1] * scale, a[2] + b[2] * scale];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function norm(a: Vec3) {
  return Math.hypot(a[0], a[1], a[2]);
}

function dist2(a: Vec3, b: Vec3) {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return dx * dx + dy * dy + dz * dz;
}

function mean(points: Vec3[]): Vec3 {
  const sum = points.reduce<Vec3>((acc, point) => [acc[0] + point[0], acc[1] + point[1], acc[2] + point[2]], [0, 0, 0]);
  return [sum[0] / points.length, sum[1] / points.length, sum[2] / points.length];
}

function unit(a: Vec3, fallback: Vec3): Vec3 {
  const magnitude = norm(a);
  if (magnitude < 1e-9) return fallback;
  return [a[0] / magnitude, a[1] / magnitude, a[2] / magnitude];
}

function supportCorners(center: Vec3, tangent: Vec3, length: number, width: number) {
  const xAxis = unit(tangent, [1, 0, 0]);
  let yAxis = unit(cross([0, 0, 1], xAxis), [0, 1, 0]);
  const zAxis = unit(cross(xAxis, yAxis), [0, 0, 1]);
  yAxis = unit(cross(zAxis, xAxis), yAxis);

  const corners = [
    addScaled(addScaled(center, xAxis, length / 2), yAxis, -width / 2),
    addScaled(addScaled(center, xAxis, length / 2), yAxis, width / 2),
    addScaled(addScaled(center, xAxis, -length / 2), yAxis, width / 2),
    addScaled(addScaled(center, xAxis, -length / 2), yAxis, -width / 2),
  ];

  return { corners, axes: { x: xAxis, y: yAxis, z: zAxis } };
}

function positionAt(order: number[], frames: { corners: Vec3[]; axes: Record<string, Vec3> }[]) {
  const last = frames.length - 1;
  const corners = order.map((frameIndex, leg) => frames[Math.min(last, Math.max(0, frameIndex))].corners[leg]);
  const center = mean(corners);
  const axes = frames[Math.min(last, Math.max(0, Math.round(order.reduce((a, b) => a + b, 0) / order.length)))].axes;
  return { corners, center, axes };
}

function priority(currPos: Vec3[], leg: number, centroid: Vec3, trialPos: Vec3[]) {
  const wCentroid = 100.0;
  const wTarget = 0.1;
  const dCentroid = dist2(currPos[leg], centroid);
  const dFootTarget = dist2(currPos[leg], trialPos[leg]);
  return wCentroid * dCentroid - wTarget * dFootTarget;
}

function generateGait(frames: { corners: Vec3[]; axes: Record<string, Vec3> }[]) {
  const order = [0, 0, 0, 0];
  const maxIndex = frames.length - 1;
  const gait = [];

  for (let step = 0; step < maxIndex * 4; step += 1) {
    const stance = positionAt(order, frames);
    gait.push({ step, order: [...order], ...stance });
    if (order.every((index) => index >= maxIndex)) break;

    const minimum = Math.min(...order);
    const centroid = mean(stance.corners);
    const priorities = order.map((frameIndex, leg) => {
      if (frameIndex >= maxIndex) return -Number.POSITIVE_INFINITY;
      const trial = [...order];
      trial[leg] += 1;
      const trialPos = positionAt(trial, frames).corners;
      const raw = priority(stance.corners, leg, centroid, trialPos);
      return Math.log10(Math.max(Math.abs(raw), 1e-9)) - frameIndex + minimum;
    });

    const bestLeg = priorities.reduce((best, value, index) => (value > priorities[best] ? index : best), 0);
    order[bestLeg] = Math.min(maxIndex, order[bestLeg] + 1);
  }

  gait.push({ step: gait.length, order: [...order], ...positionAt(order, frames) });
  return gait;
}

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json();
    const samples = Math.round(asNumber(body.samples, 30, 4, 160));
    const length = asNumber(body.length, 0.34, 0.02, 2);
    const width = asNumber(body.width, 0.18, 0.02, 2);
    const x = compileExpression(body.x_expr, 'sin(2*pi*t)');
    const y = compileExpression(body.y_expr, 'cos(2*pi*t)');
    const z = compileExpression(body.z_expr, '0.55*cos(2*pi*t)');

    const trajectory = Array.from({ length: samples }, (_, index) => {
      const t = index / Math.max(1, samples - 1);
      return [x.valueAt(t), y.valueAt(t), z.valueAt(t)] as Vec3;
    });

    const frames = trajectory.map((center, index) => {
      const prev = trajectory[Math.max(0, index - 1)];
      const next = trajectory[Math.min(samples - 1, index + 1)];
      const tangent = sub(next, prev);
      return {
        index,
        center,
        ...supportCorners(center, tangent, length, width),
      };
    });
    const gait = generateGait(frames);

    return new Response(JSON.stringify({
      ok: true,
      trajectory,
      frames,
      gait,
      summary: {
        samples,
        gait_steps: gait.length,
        length,
        width,
        x_expr: x.source,
        y_expr: y.source,
        z_expr: z.source,
      },
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return new Response(JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
