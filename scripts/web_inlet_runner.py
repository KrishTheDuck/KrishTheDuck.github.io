from __future__ import annotations

import argparse
import json
import math
import traceback
from pathlib import Path

import matplotlib

matplotlib.use("Agg")

import matplotlib.pyplot as plt
import numpy as np
from scipy.optimize import differential_evolution


def theta_from_beta(mach, beta, gamma):
    num = 2 / math.tan(beta) * (mach**2 * math.sin(beta) ** 2 - 1)
    den = mach**2 * (gamma + math.cos(2 * beta)) + 2
    return math.atan(num / den)


def oblique(mach_1, beta, gamma):
    mn_1 = mach_1 * math.sin(beta)
    theta = theta_from_beta(mach_1, beta, gamma)
    mn2_sq = ((gamma - 1) * mn_1**2 + 2) / (2 * gamma * mn_1**2 - (gamma - 1))
    if mn2_sq <= 0:
        return math.nan, math.nan, math.nan
    mach_2 = math.sqrt(mn2_sq) / math.sin(beta - theta)
    p2p1 = 1 + (2 * gamma / (gamma + 1)) * (mn_1**2 - 1)
    r2r1 = ((gamma + 1) * mn_1**2) / ((gamma - 1) * mn_1**2 + 2)
    tpr = p2p1 * (p2p1 / r2r1) ** (-gamma / (gamma - 1))
    return theta, mach_2, tpr


def area_ratio(mach, gamma):
    term_1 = 2 / (gamma + 1)
    term_2 = 1 + (gamma - 1) / 2 * mach**2
    exponent = (gamma + 1) / (2 * (gamma - 1))
    return (1 / mach) * (term_1 * term_2) ** exponent


def solve_mach_from_area_ratio(target, gamma):
    if target < 1:
        return math.nan
    if abs(target - 1) < 1e-6:
        return 1.0
    lo, hi = 1.0, 10.0
    for _ in range(35):
        mid = 0.5 * (lo + hi)
        if area_ratio(mid, gamma) > target:
            hi = mid
        else:
            lo = mid
    return 0.5 * (lo + hi)


def calc_ramp_physics(beta_1, betas, mach_0, x_c, y_c, gamma, n_ramps, contraction=1.2):
    s = {
        "tprs": np.full(n_ramps, np.nan),
        "machs": np.full(n_ramps + 2, np.nan),
        "thetas_rel": np.full(n_ramps, np.nan),
        "betas_abs": np.full(n_ramps, np.nan),
        "xs": np.full(n_ramps + 1, np.nan),
        "ys": np.full(n_ramps + 1, np.nan),
    }
    s["machs"][0] = mach_0
    s["xs"][0] = 0
    s["ys"][0] = 0

    theta_1 = theta_from_beta(mach_0, beta_1, gamma)
    if theta_1 <= 0 or not math.isfinite(theta_1):
        return -1, s
    _, mach_2, tpr_1 = oblique(mach_0, beta_1, gamma)
    s["thetas_rel"][0] = theta_1
    s["betas_abs"][0] = beta_1
    s["machs"][1] = mach_2
    s["tprs"][0] = tpr_1
    theta_abs = theta_1

    for ramp in range(2, n_ramps + 1):
        beta_abs = float(betas[ramp - 2])
        m1 = math.tan(theta_abs)
        c1 = s["ys"][ramp - 2] - m1 * s["xs"][ramp - 2]
        m2 = math.tan(beta_abs)
        c2 = y_c - m2 * x_c
        if abs(m1 - m2) < 1e-9:
            return -1, s
        x_new = (c2 - c1) / (m1 - m2)
        y_new = m1 * x_new + c1
        if y_new >= y_c or x_new <= s["xs"][ramp - 2] + 5e-3 or x_new >= x_c - 5e-3:
            return -1, s

        beta_rel = beta_abs - theta_abs
        if s["machs"][ramp - 1] <= 1:
            return -1, s
        mu = math.asin(1 / s["machs"][ramp - 1])
        if beta_rel <= mu or beta_rel >= math.pi / 2:
            return -1, s
        theta_rel = theta_from_beta(s["machs"][ramp - 1], beta_rel, gamma)
        if theta_rel <= 0 or not math.isfinite(theta_rel):
            return -1, s
        _, mach_next, tpr = oblique(s["machs"][ramp - 1], beta_rel, gamma)
        if not math.isfinite(mach_next):
            return -1, s

        s["xs"][ramp - 1] = x_new
        s["ys"][ramp - 1] = y_new
        s["thetas_rel"][ramp - 1] = theta_rel
        s["betas_abs"][ramp - 1] = beta_abs
        s["machs"][ramp] = mach_next
        s["tprs"][ramp - 1] = tpr
        theta_abs += theta_rel

    y_end = math.tan(theta_abs) * x_c + (s["ys"][n_ramps - 1] - math.tan(theta_abs) * s["xs"][n_ramps - 1])
    if y_end >= y_c:
        return -1, s
    mach_cowl = s["machs"][n_ramps]
    if mach_cowl <= 1:
        return -1, s
    throat_area = area_ratio(mach_cowl, gamma) / contraction
    mach_throat = solve_mach_from_area_ratio(throat_area, gamma)
    if not math.isfinite(mach_throat):
        return -1, s
    _, mach_sub, tpr_normal = oblique(mach_throat, math.pi / 2, gamma)
    if not math.isfinite(tpr_normal):
        return -1, s

    s["xs"][n_ramps] = x_c
    s["ys"][n_ramps] = y_end
    s["machs"][n_ramps + 1] = mach_sub
    tpr_final = float(np.prod(s["tprs"]) * tpr_normal)
    return tpr_final, s


def optimize_case(beta_1, mach, x_c, y_c, gamma, n_ramps):
    lip_angle = math.atan(y_c / x_c)
    nvars = n_ramps - 1
    lower = max(lip_angle, beta_1 + 0.02)
    bounds = [(lower + i * 1e-3, math.radians(85)) for i in range(nvars)]

    def objective(values):
        if any(values[i] >= values[i + 1] for i in range(len(values) - 1)):
            return 1e4
        tpr, _ = calc_ramp_physics(beta_1, values, mach, x_c, y_c, gamma, n_ramps)
        return 1e4 if tpr <= 0 or not math.isfinite(tpr) else -tpr

    result = differential_evolution(objective, bounds, maxiter=55, popsize=8, polish=True, seed=2, workers=1)
    if not result.success and not math.isfinite(result.fun):
        return None
    tpr, sol = calc_ramp_physics(beta_1, result.x, mach, x_c, y_c, gamma, n_ramps)
    if tpr <= 0:
        return None
    sol["tpr"] = tpr
    sol["beta1"] = beta_1
    sol["x_c"] = x_c
    sol["y_c"] = y_c
    sol["throat"] = y_c - sol["ys"][-1]
    sol["betas_opt"] = result.x
    return sol


def plot_results(points, target_sol, target_throat, output_path):
    fig = plt.figure(figsize=(14, 4.8), dpi=170)
    ax1 = fig.add_subplot(1, 3, 1)
    ax2 = fig.add_subplot(1, 3, 2)
    ax3 = fig.add_subplot(1, 3, 3)

    beta = [math.degrees(p["beta1"]) for p in points]
    tpr = [p["tpr"] for p in points]
    throat = [p["throat"] for p in points]
    ax1.scatter(beta, tpr, s=20, color="#0f766e")
    ax1.set_title("TPR vs beta1")
    ax1.set_xlabel("beta1 [deg]")
    ax1.set_ylabel("TPR")
    ax1.grid(True, alpha=0.25)

    ax2.scatter(beta, throat, s=20, color="#2563eb")
    ax2.axhline(target_throat, color="#dc2626", linestyle="--", linewidth=1.4)
    ax2.set_title("Throat gap vs beta1")
    ax2.set_xlabel("beta1 [deg]")
    ax2.set_ylabel("Throat [m]")
    ax2.grid(True, alpha=0.25)

    if target_sol:
        xs, ys = target_sol["xs"], target_sol["ys"]
        ax3.plot(xs, ys, color="#111827", linewidth=2.5, label="ramp")
        ax3.scatter([target_sol["x_c"]], [target_sol["y_c"]], color="#dc2626", s=55, label="cowl lip")
        ax3.plot([target_sol["x_c"], target_sol["x_c"]], [ys[-1], target_sol["y_c"]], color="#c026d3", linewidth=3, label="throat")
        for i in range(len(xs) - 1):
            if i == 0:
                x_end = target_sol["x_c"] + 0.15
                y_end = ys[i] + math.tan(target_sol["beta1"]) * (x_end - xs[i])
                ax3.plot([xs[i], x_end], [ys[i], y_end], "--", color="#0891b2", linewidth=1.3)
            else:
                ax3.plot([xs[i], target_sol["x_c"]], [ys[i], target_sol["y_c"]], "--", color="#2563eb", linewidth=1.1)
        ax3.set_title(f"Target geometry\nTPR {target_sol['tpr']:.3f}, throat {target_sol['throat']:.3f} m")
        ax3.set_aspect("equal", adjustable="box")
        ax3.grid(True, alpha=0.25)
        ax3.legend(fontsize=8)

    fig.tight_layout()
    fig.savefig(output_path, bbox_inches="tight")
    plt.close(fig)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--outdir", required=True, type=Path)
    args = parser.parse_args()
    args.outdir.mkdir(parents=True, exist_ok=True)
    result_path = args.outdir / "result.json"

    try:
        cfg = json.loads(args.input.read_text(encoding="utf-8"))
        mach = float(cfg.get("mach", 4))
        gamma = float(cfg.get("gamma", 1.4))
        n_ramps = int(cfg.get("n_ramps", 3))
        y_c = float(cfg.get("y_c", 0.33))
        target = float(cfg.get("target_throat", 0.05))
        x_values = np.linspace(float(cfg.get("x_min", 0.5)), float(cfg.get("x_max", 1.3)), int(cfg.get("num_x", 1)))
        beta_min = float(cfg.get("beta_min_deg", math.degrees(math.asin(1 / mach)) + 0.1))
        beta_max = float(cfg.get("beta_max_deg", 40))
        beta_values = np.radians(np.linspace(beta_min, beta_max, int(cfg.get("num_beta", 28))))

        points = []
        for x_c in x_values:
            for beta_1 in beta_values:
                sol = optimize_case(beta_1, mach, x_c, y_c, gamma, n_ramps)
                if sol:
                    points.append(sol)
        if not points:
            raise ValueError("No valid inlet geometries found for these inputs.")

        best_tpr = max(points, key=lambda p: p["tpr"])
        target_sol = min(points, key=lambda p: abs(p["throat"] - target))
        image = args.outdir / "inlet_results.png"
        plot_results(points, target_sol, target, image)
        payload = {
            "ok": True,
            "image": image.name,
            "summary": {
                "valid": len(points),
                "best_tpr": best_tpr["tpr"],
                "target_tpr": target_sol["tpr"],
                "target_throat": target_sol["throat"],
                "x_c": target_sol["x_c"],
                "beta1_deg": math.degrees(target_sol["beta1"]),
            },
        }
    except Exception as exc:
        payload = {"ok": False, "error": str(exc), "traceback": traceback.format_exc()}

    result_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(json.dumps(payload))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
