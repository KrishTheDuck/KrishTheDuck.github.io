import type { APIRoute } from 'astro';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const HYPERSONICS_ROOT = 'S:\\UMD\\Hypersonics Folder\\Hypersonics v2.2';
const PYTHON_EXE = path.join(HYPERSONICS_ROOT, '.venv', 'Scripts', 'python.exe');
const RUNNER = path.join(HYPERSONICS_ROOT, 'web_waverider_runner.py');
const PUBLIC_ROOT = path.join(process.cwd(), 'public');
const GENERATED_ROOT = path.join(PUBLIC_ROOT, 'generated', 'waverider');

type WaveriderInput = {
  mach: number;
  gamma: number;
  beta: number;
  seed_num: number;
  nghost: number;
  span: number;
  nsamples: number;
  fct_type: string;
  fct_abcdn: number[];
  icc_type: string;
  icc_abcdn: number[];
  cma_control_points?: number[][];
};

function asNumber(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asInt(value: unknown, fallback: number) {
  const parsed = Math.round(asNumber(value, fallback));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asAbcdn(value: unknown, fallback: number[]) {
  if (Array.isArray(value)) {
    const parsed = value.map((item) => Number(item));
    if (parsed.length === 5 && parsed.every(Number.isFinite)) return parsed;
  }
  if (typeof value === 'string') {
    const parsed = value.split(',').map((item) => Number(item.trim()));
    if (parsed.length === 5 && parsed.every(Number.isFinite)) return parsed;
  }
  return fallback;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function buildInput(raw: Record<string, unknown>) {
  const input: WaveriderInput = {
    mach: clamp(asNumber(raw.mach, 4), 1.2, 12),
    gamma: clamp(asNumber(raw.gamma, 1.4), 1.05, 1.8),
    beta: clamp(asNumber(raw.beta, 20), 2, 70),
    seed_num: clamp(asInt(raw.seed_num, 51), 11, 151),
    nghost: clamp(asInt(raw.nghost, 5), 1, 20),
    span: clamp(asNumber(raw.span, 0.5), 0.05, 5),
    nsamples: clamp(asInt(raw.nsamples, 9), 5, 25),
    fct_type: String(raw.fct_type || 'Cosine'),
    fct_abcdn: asAbcdn(raw.fct_abcdn, [-0.1, 4, 0, -0.11, 1]),
    icc_type: String(raw.icc_type || 'Cosine'),
    icc_abcdn: asAbcdn(raw.icc_abcdn, [0.01, 4, 0, 0, 1]),
    cma_control_points: Array.isArray(raw.cma_control_points) ? raw.cma_control_points as number[][] : undefined,
  };

  if (input.seed_num % 2 === 0) input.seed_num += 1;

  return {
    Mesh: {
      filename: 'Waverider_Mesh.stl',
      LE_condition: 0,
      LE_radius: 1.5,
    },
    global: {
      Freestream: {
        mach: input.mach,
        gamma: input.gamma,
        beta: input.beta,
      },
      'Design Parameters': {
        seed_num: input.seed_num,
        nghost: input.nghost,
        span: input.span,
      },
      nsamples: input.nsamples,
    },
    FCT: {
      function_type: input.fct_type,
      abcdn: input.fct_abcdn,
    },
    ICC: {
      function_type: input.icc_type,
      abcdn: input.icc_abcdn,
    },
    ...(input.cma_control_points ? { OptimizedICC: input.cma_control_points } : {}),
  };
}

export const POST: APIRoute = async ({ request }) => {
  try {
    const raw = await request.json();
    const runId = randomUUID();
    const outdir = path.join(GENERATED_ROOT, runId);
    await mkdir(outdir, { recursive: true });

    const input = buildInput(raw || {});
    const inputPath = path.join(outdir, 'input.json');
    await writeFile(inputPath, JSON.stringify(input, null, 2), 'utf-8');

    let stdout = '';
    let stderr = '';
    try {
      const result = await execFileAsync(
        PYTHON_EXE,
        [RUNNER, '--input', inputPath, '--outdir', outdir],
        {
          cwd: HYPERSONICS_ROOT,
          timeout: 90000,
          maxBuffer: 1024 * 1024 * 16,
        },
      );
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (error) {
      if (error && typeof error === 'object') {
        stdout = 'stdout' in error ? String(error.stdout || '') : '';
        stderr = 'stderr' in error ? String(error.stderr || '') : '';
      }
    }

    const resultText = await readFile(path.join(outdir, 'result.json'), 'utf-8');
    const result = JSON.parse(resultText);
    const baseUrl = `/generated/waverider/${runId}`;

    return Response.json({
      ...result,
      runId,
      input,
      stdout,
      stderr,
      images: result.images
        ? {
            waverider: result.images.waverider ? `${baseUrl}/${result.images.waverider}` : undefined,
            cma: result.images.cma ? `${baseUrl}/${result.images.cma}` : undefined,
            fallback: result.images.fallback ? `${baseUrl}/${result.images.fallback}` : undefined,
          }
        : undefined,
    });
  } catch (error) {
    return Response.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
};
