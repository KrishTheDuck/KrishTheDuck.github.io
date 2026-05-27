import type { APIRoute } from 'astro';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const PYTHON_EXE = 'S:\\UMD\\Hypersonics Folder\\Hypersonics v2.2\\.venv\\Scripts\\python.exe';
const RUNNER = path.join(process.cwd(), 'scripts', 'web_inlet_runner.py');
const GENERATED_ROOT = path.join(process.cwd(), 'public', 'generated', 'inlet');

function asNumber(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asInt(value: unknown, fallback: number) {
  return Math.round(asNumber(value, fallback));
}

export const POST: APIRoute = async ({ request }) => {
  try {
    const raw = await request.json().catch(() => ({}));
    const runId = randomUUID();
    const outdir = path.join(GENERATED_ROOT, runId);
    await mkdir(outdir, { recursive: true });
    const input = {
      mach: asNumber(raw.mach, 4),
      gamma: asNumber(raw.gamma, 1.4),
      n_ramps: asInt(raw.n_ramps, 3),
      y_c: asNumber(raw.y_c, 0.33),
      target_throat: asNumber(raw.target_throat, 0.05),
      num_x: asInt(raw.num_x, 1),
      x_min: asNumber(raw.x_min, 0.5),
      x_max: asNumber(raw.x_max, 1.3),
      num_beta: asInt(raw.num_beta, 28),
      beta_min_deg: asNumber(raw.beta_min_deg, 14.58),
      beta_max_deg: asNumber(raw.beta_max_deg, 40),
    };
    const inputPath = path.join(outdir, 'input.json');
    await writeFile(inputPath, JSON.stringify(input, null, 2), 'utf-8');

    const { stdout, stderr } = await execFileAsync(PYTHON_EXE, [RUNNER, '--input', inputPath, '--outdir', outdir], {
      timeout: 120000,
      maxBuffer: 1024 * 1024 * 8,
    });
    const result = JSON.parse(await readFile(path.join(outdir, 'result.json'), 'utf-8'));

    return Response.json({
      ...result,
      image: result.image ? `/generated/inlet/${runId}/${result.image}` : undefined,
      stdout,
      stderr,
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
