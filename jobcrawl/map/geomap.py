"""Geographic cartogram of the board: real geography, each area swollen or shrunk to its share of the open roles (a "homunculus" map).

    jobcrawl geomap --site SITE [--profile DIR] [--vectors DIR] [--companies FILE] [--cache DIR]     (needs numpy)

Density-equalising cartogram. Stage 1 is Gastner & Newman (2004): the role density is diffused (a heat kernel, applied with numpy's FFT) and
the grid's nodes move along -grad(density)/density, so every cell keeps its mass. Stage 2 corrects what the flow leaves over: Gauss-Newton
steps on the cells' log areas (preconditioned conjugate gradients on the node grid), each kept only when no cell folds and the fit improves.
Each profile scope gets its own extent (worldwide: the whole world; continent EU: Europe; country: its bounds + 3 %; country and admin1: the
state's bounds + 5 %). Outside the land the density is the land's mean (so the extent keeps its area), and empty land keeps a floor of the
mean land density (FLOOR), so nothing vanishes. The role places, the land polygons and the companies are moved by the same displacement
(bilinear between the nodes).

Reads: SITE/jobs-index.json and SITE/jobs-desc-XX.json (the location text l of every role; jobcrawl.geo.geo.resolve gives its places); the
profile's scopes (without --profile: the worldwide scope); the companies catalogue (--companies: companies[].coordinates [lat, lon], optional);
the Natural Earth polygons (jobcrawl/map/geo_base.py, downloaded into --cache when they are not there yet).
Writes VECTORS/geo-map.json: {version, source, scopes: {id: {extent, w, h, shapes, places, companies, error, moderate}}}. Positions are 0..1 units with
y counted from the north edge: x, y the true position, cx, cy the cartogram position (density as is), mx, my the moderate cartogram
position (density^MODERATE, a milder distortion). publish copies it into SITE/match/.
"""
import json
import math
import os
import time

import numpy as np

from jobcrawl.geo import geo
from jobcrawl.map import geo_base
from jobcrawl.profile import DEFAULT_SCOPES
from jobcrawl.site import read_site

GRID = 512                  # cells across the longer side of an extent
SMOOTH = 1.5                # cells: each role's mass is spread with this Gaussian
BLEND_SMOOTH = 6.0          # cells: the density the flow follows is smoothed this much (a density step inside a cell folds the grid)
BLEND_KM = 40.0             # km: the density is smoothed over this distance where the cells are small (regional scopes; never less than BLEND_SMOOTH cells).
                            # A narrower blur leaves the fit unconverged (Bavaria); the blur spreads a small region's roles into its neighbours (Berlin looks small).
FLOOR = 0.02                # empty land keeps this share of the mean land density
MODERATE = 0.5  # the intermediate map: density^0.5, so a shape with 4x the mean density grows 2x, not 4x
TOL = 0.05                  # stop when every cell is within 5 % of its target area
STAGES_KM = (40.0, 20.0, 10.0, 5.0)  # km: the blur width of the annealing stages (coarse first)
MIN_STAGE_CELLS = 3.0       # cells: the finest blur the stages use (the flow folds on a sub-cell density step)
STAGE_MAX_ERR = 0.1         # a stage that ends with a larger area error (or a fold) has diverged: the scope falls back to the single stage
FLOW_STEPS = 100            # the flow stops here (its error stalls once the density is uniform; the area fit does the rest)
FIT_STEPS = 15              # Gauss-Newton steps on the areas (the fit converges in a few)
FIT_CG = 60                 # conjugate-gradient iterations per fit step
FIT_SMOOTH = 1e-4           # weight of the node smoothness in the area fit
CFL = 2.0                   # cells a node may move in one flow step
DT0, GROW = 0.05, 1.0       # a flow step is at most DT0 + GROW * t long (the flow changes with t; longer steps fold cells)
SIMPLIFY = 0.003            # Douglas-Peucker tolerance, in extent widths
RING_MIN = 0.0005           # rings smaller than this share of the extent are dropped
VALID_STEP = 0.25           # cells: edges are cut this finely before the areas are measured
OUT_STEP = 2.0              # cells: output edges are cut this finely before the transform (the transform bends them)
WORLD = (-180.0, -60.0, 180.0, 80.0)
EUROPE = (-25.0, 34.0, 45.0, 72.0)
SOURCE = 'Natural Earth (public domain); GeoNames (CC BY 4.0)'
FILE = 'geo-map.json'


class GeoMapError(ValueError):
    pass


def bilinear(F, x, y):
    """F sampled at the index positions (x: column, y: row), linear between the cells and clamped to the array."""
    ny, nx = F.shape
    x = np.clip(x, 0, nx - 1)
    y = np.clip(y, 0, ny - 1)
    c = np.minimum(x.astype(int), nx - 2)
    r = np.minimum(y.astype(int), ny - 2)
    fx, fy = x - c, y - r
    return (1 - fy) * ((1 - fx) * F[r, c] + fx * F[r, c + 1]) + fy * ((1 - fx) * F[r + 1, c] + fx * F[r + 1, c + 1])


def quad_areas(P):
    """Signed area of each cell of the node grid P (its four nodes as a quadrilateral): 1 at the start, below 0 where the grid folds."""
    x, y = P[..., 0], P[..., 1]
    x0, y0, x1, y1 = x[:-1, :-1], y[:-1, :-1], x[:-1, 1:], y[:-1, 1:]
    x2, y2, x3, y3 = x[1:, 1:], y[1:, 1:], x[1:, :-1], y[1:, :-1]
    return 0.5 * ((x0 * y1 - x1 * y0) + (x1 * y2 - x2 * y1) + (x2 * y3 - x3 * y2) + (x3 * y0 - x0 * y3))


def poly_area(pts):
    """Unsigned area of a closed ring given as its points (first point not repeated)."""
    if len(pts) < 3:
        return 0.0
    x, y = pts[:, 0], pts[:, 1]
    return 0.5 * abs(float(np.sum(x * np.roll(y, -1) - np.roll(x, -1) * y)))


def densify(ring, step):
    """A closed ring with extra points so that no edge is longer than step (a transform bends the edges; the points carry the bend)."""
    out = []
    for a, b in zip(ring, np.roll(ring, -1, axis=0)):
        n = max(1, int(math.ceil(math.hypot(*(b - a)) / step)))
        out.append(a + (b - a) * np.arange(n)[:, None] / n)
    return np.vstack(out)


def clip_box(pts, w, h):
    """The ring cut to the rectangle 0..w x 0..h (Sutherland-Hodgman, one edge at a time)."""
    for k, v, keep_above in ((0, 0.0, True), (0, w, False), (1, 0.0, True), (1, h, False)):
        out = []
        for i in range(len(pts)):
            c, p = pts[i], pts[i - 1]
            ci = c[k] >= v if keep_above else c[k] <= v
            pi = p[k] >= v if keep_above else p[k] <= v
            if ci != pi:
                out.append(p + (v - p[k]) / (c[k] - p[k]) * (c - p))
            if ci:
                out.append(c)
        pts = np.array(out) if out else np.zeros((0, 2))
        if len(pts) < 3:
            return np.zeros((0, 2))
    return pts


def simplify(ring, tol):
    """Douglas-Peucker on a closed ring (its first point not repeated); the kept points, still without the repeated first point."""
    pts = np.vstack([ring, ring[:1]])
    n = len(pts)
    keep = np.zeros(n, bool)
    keep[[0, n - 1]] = True
    stack = [(0, n - 1)]
    while stack:
        a, b = stack.pop()
        if b - a < 2:
            continue
        d = pts[b] - pts[a]
        length = math.hypot(d[0], d[1])
        rel = pts[a + 1:b] - pts[a]
        dist = np.abs(rel[:, 0] * d[1] - rel[:, 1] * d[0]) / length if length > 0 else np.hypot(rel[:, 0], rel[:, 1])
        i = int(np.argmax(dist))
        if dist[i] > tol:
            keep[a + 1 + i] = True
            stack += [(a, a + 1 + i), (a + 1 + i, b)]
    return pts[:-1][keep[:-1]]


def rasterize(rings, shape):
    """Boolean mask of the cells (rows, columns) whose centres lie inside the rings, by the even-odd rule. Rings are in index units."""
    mask = np.zeros(shape, bool)
    edges = [np.hstack([r, np.roll(r, -1, axis=0)]) for r in rings if len(r) >= 3]
    if not edges:
        return mask
    x1, y1, x2, y2 = np.vstack(edges).T
    lo, hi = np.minimum(y1, y2), np.maximum(y1, y2)
    for row in range(max(0, math.floor(lo.min() - 0.5)), min(shape[0], math.ceil(hi.max()))):
        yc = row + 0.5
        sel = (lo <= yc) & (yc < hi)
        if not sel.any():
            continue
        a, b = y1[sel], y2[sel]
        xs = np.sort(x1[sel] + (yc - a) * (x2[sel] - x1[sel]) / (b - a))
        for left, right in zip(xs[0::2], xs[1::2]):
            c0, c1 = max(0, math.ceil(left - 0.5)), min(shape[1], math.ceil(right - 0.5))
            if c1 > c0:
                mask[row, c0:c1] = True
    return mask


def smooth(mass, sigma):
    """The grid convolved with a Gaussian of sigma cells (FFT); the total is kept."""
    ny, nx = mass.shape
    fy, fx = np.fft.fftfreq(ny)[:, None], np.fft.rfftfreq(nx)[None, :]
    return np.fft.irfft2(np.fft.rfft2(mass) * np.exp(-2 * np.pi ** 2 * sigma ** 2 * (fx ** 2 + fy ** 2)), s=mass.shape)


def equalise(blend, tol, max_steps):
    """Stage 1, Gastner-Newman (2004) diffusion. Returns (P, error, steps, smallest signed cell area).

    P[k, l] is the position (column, row, in cell units) that node (k, l) has reached; the cell (i, j) spans nodes i..i+1, j..j+1.
    The density after diffusion time t is the start density convolved with a Gaussian of variance 2t (one FFT product); the nodes move with
    v = -grad(rho_t) / rho_t, which keeps the mass of every cell. A midpoint step of at most CFL cells and at most DT0 + GROW * t long.
    The error is the largest |area / target - 1| over the cells, target = blend / its mean (the cells start at area 1).
    """
    ny, nx = blend.shape
    spectrum = np.fft.rfft2(blend)
    fy, fx = np.fft.fftfreq(ny)[:, None], np.fft.rfftfreq(nx)[None, :]
    rate = 4 * np.pi ** 2 * (fx ** 2 + fy ** 2)          # the heat kernel: exp(-t * rate) per Fourier mode
    target = blend / blend.mean()
    cols, rows = np.meshgrid(np.arange(nx + 1, dtype=float), np.arange(ny + 1, dtype=float))
    P = np.stack([cols, rows], -1)

    def density(t):
        return np.fft.irfft2(spectrum * np.exp(-t * rate), s=(ny, nx))

    def velocity(rho, Q):
        gy, gx = np.gradient(rho)
        vx, vy = -gx / rho, -gy / rho
        cx, cy = Q[..., 0] - 0.5, Q[..., 1] - 0.5          # cell centres are at +0.5 in node units
        return np.stack([bilinear(vx, cx, cy), bilinear(vy, cx, cy)], -1)

    t = 0.0
    for steps in range(max_steps + 1):
        area = quad_areas(P)
        err = float(np.max(np.abs(np.abs(area) / target - 1)))
        if err < tol or steps == max_steps:
            break
        v = velocity(density(t), P)
        dt = min(CFL / max(float(np.abs(v).max()), 1e-12), DT0 + GROW * t)
        P = P + dt * velocity(density(t + 0.5 * dt), P + 0.5 * dt * v)
        t += dt
    return P, err, steps, float(area.min())


_CORNER = {'a': (slice(None, -1), slice(None, -1)), 'b': (slice(None, -1), slice(1, None)),
           'c': (slice(1, None), slice(1, None)), 'd': (slice(1, None), slice(None, -1))}


def _grad_corners(P):
    """Each cell's signed-area gradient with respect to its corner nodes a (top-left), b (top-right), c (bottom-right), d (bottom-left)."""
    x, y = P[..., 0], P[..., 1]
    xa, ya, xb, yb = x[:-1, :-1], y[:-1, :-1], x[:-1, 1:], y[:-1, 1:]
    xc, yc, xd, yd = x[1:, 1:], y[1:, 1:], x[1:, :-1], y[1:, :-1]
    return {'a': (0.5 * (yb - yd), 0.5 * (xd - xb)), 'b': (0.5 * (yc - ya), 0.5 * (xa - xc)),
            'c': (0.5 * (yd - yb), 0.5 * (xb - xd)), 'd': (0.5 * (ya - yc), 0.5 * (xc - xa))}


def _jacobian_apply(g, D):
    """J D: the area change of each cell for node displacements D (node grid, 2 components)."""
    return sum(gx * D[_CORNER[k] + (0,)] + gy * D[_CORNER[k] + (1,)] for k, (gx, gy) in g.items())


def _jacobian_transpose(g, w, shape):
    """J^T w: the node displacement gradient of per-cell weights w."""
    out = np.zeros(shape + (2,))
    for k, (gx, gy) in g.items():
        out[_CORNER[k] + (0,)] += w * gx
        out[_CORNER[k] + (1,)] += w * gy
    return out


def _laplacian(V):
    """Graph Laplacian of a node field (4 neighbours; nothing beyond the grid)."""
    out = np.zeros_like(V)
    out[1:] += V[1:] - V[:-1]
    out[:-1] += V[:-1] - V[1:]
    out[:, 1:] += V[:, 1:] - V[:, :-1]
    out[:, :-1] += V[:, :-1] - V[:, 1:]
    return out


def _pcg(op, b, minv, iters):
    """Preconditioned conjugate gradients for op(x) = b, with the diagonal preconditioner minv."""
    x = np.zeros_like(b)
    r = b.copy()
    z = minv * r
    p = z.copy()
    rz = float(np.sum(r * z))
    bb = max(float(np.sum(b * b)), 1e-300)
    for _ in range(iters):
        Ap = op(p)
        a = rz / max(float(np.sum(p * Ap)), 1e-300)
        x += a * p
        r -= a * Ap
        if float(np.sum(r * r)) < 1e-24 * bb:
            break
        z = minv * r
        rz_new = float(np.sum(r * z))
        p = z + (rz_new / rz) * p
        rz = rz_new
    return x


def area_fit(P, T, fixed, tol=TOL, iters=FIT_STEPS):
    """Stage 2, Gauss-Newton on the log cell areas. Each cell must grow or shrink by the factor T / A, so the residual is r = log(A / T)
    and a node step d changes it by (J d) / A. Each step solves (J^T A^-2 J + FIT_SMOOTH L) d = -J^T (r / A) by preconditioned conjugate
    gradients (Jacobi), J the cells' area gradients, L the node Laplacian, and takes the largest of 1, 1/2, 1/4, ... that keeps every cell
    positive and lowers the objective. fixed: nodes that do not move (the outer edge of the grid). Returns (P, error, steps, smallest cell area)."""
    free = (~fixed)[..., None].astype(float)
    shape = P.shape[:2]
    A = quad_areas(P)
    err = float(np.max(np.abs(A / T - 1)))
    f = float(np.sum(np.log(A / T) ** 2))           # the objective: sum of squared log residuals
    steps = 0
    for steps in range(1, iters + 1):
        if err < tol:
            break
        g = _grad_corners(P)
        W = 1.0 / A ** 2
        rhs = -_jacobian_transpose(g, np.log(A / T) / A, shape) * free

        def op(v, g=g, W=W):
            v = v * free
            return (_jacobian_transpose(g, W * _jacobian_apply(g, v), shape) + FIT_SMOOTH * _laplacian(v)) * free

        diag = _jacobian_transpose({k: (gx * gx, gy * gy) for k, (gx, gy) in g.items()}, W, shape) + 4 * FIT_SMOOTH
        d = _pcg(op, rhs, free / np.maximum(diag, 1e-12), FIT_CG)
        alpha = 1.0
        while alpha > 1e-3:
            An = quad_areas(P + alpha * d)
            fn = float(np.sum(np.log(np.abs(An) / T) ** 2)) if An.min() > 0 else np.inf
            if fn < f:
                break
            alpha *= 0.5
        if alpha <= 1e-3:
            break                                   # no step lowers the error without a fold: keep what there is
        P, A, f = P + alpha * d, An, fn
        err = float(np.max(np.abs(A / T - 1)))
    return P, err, steps, float(A.min())


class Cartogram:
    """A finished cartogram: the node grid P on a padded grid of cells of size h (normalised units), with margin M cells on each side."""

    def __init__(self, P, h, margin):
        self.P, self.h, self.M = P, h, margin

    def apply(self, xy):
        """Normalised plane points (n, 2) -> their normalised cartogram positions (n, 2)."""
        q = np.asarray(xy, float) / self.h + self.M
        cx = bilinear(self.P[..., 0], q[:, 0], q[:, 1])
        cy = bilinear(self.P[..., 1], q[:, 0], q[:, 1])
        return (np.stack([cx, cy], -1) - self.M) * self.h


def cartogram(rings, points, w, h, grid=GRID, tol=TOL, max_steps=FLOW_STEPS, blend_cells=BLEND_SMOOTH, log=print, gamma=1.0):
    """The cartogram of one extent (w x h, normalised so that max(w, h) = 1).

    rings: {shape id: [ring, ...]} with each ring an (n, 2) array of plane points already cut to the extent (see clip_box).
    points: (n, 3) rows of x, y, mass: the roles' places inside the extent.
    gamma: the density is raised to this power first (1: the full cartogram; MODERATE: the intermediate map).
    Returns {'map': Cartogram, 'error', 'steps', 'fit', 'folds', 'time'}: the error is the largest relative area error over the grid.
    """
    margin = grid // 4
    ny, nx = math.ceil(h * grid - 1e-9), math.ceil(w * grid - 1e-9)
    shape = (ny + 2 * margin, nx + 2 * margin)
    inside = np.zeros(shape, bool)
    inside[margin:margin + ny, margin:margin + nx] = True
    land = np.zeros(shape, bool)
    for rs in rings.values():
        land |= rasterize([r * grid + margin for r in rs], shape)
    mass = np.zeros(shape)
    if len(points):
        col = np.clip(np.floor(points[:, 0] * grid + margin), 0, shape[1] - 1).astype(int)
        row = np.clip(np.floor(points[:, 1] * grid + margin), 0, shape[0] - 1).astype(int)
        np.add.at(mass, (row, col), points[:, 2])
    m = smooth(mass, SMOOTH)
    if land.any():
        dense = np.where(land, np.maximum(m, FLOOR * float(m[land].mean())), 0.0)
        if gamma != 1.0:
            dense[land] = dense[land] ** gamma
        sea = float(dense[land].mean())       # outside the land: the mean land density, so the extent keeps its area
    else:
        dense, sea = m, float(m[inside].mean())
    outside = ~inside                           # scaled so its mean is the extent's mean (the total stays put)
    blend = smooth(np.where(land, dense, sea), blend_cells)   # the density the cells must match (a step inside a cell folds the grid)
    blend[outside] *= blend[inside].mean() / blend[outside].mean()
    start = time.time()
    P, err1, steps, _ = equalise(blend, tol, max_steps)
    fixed = np.zeros((shape[0] + 1, shape[1] + 1), bool)     # the nodes on the outer edge of the grid stay where they are
    fixed[0, :] = fixed[-1, :] = fixed[:, 0] = fixed[:, -1] = True
    P, err, fit, folds = area_fit(P, blend / blend.mean(), fixed, tol, FIT_STEPS)
    took = time.time() - start
    log(f'  {len(rings)} shapes, {int(inside.sum())} cells, {len(points)} places: flow {steps} steps (error {err1:.3f}), '
        f'area fit {fit} steps, error {err:.4f}, smallest cell area {folds:.4f} (above 0: no fold), {took:.1f} s')
    return {'map': Cartogram(P, 1.0 / grid, margin), 'error': err, 'steps': steps, 'fit': fit, 'folds': folds, 'time': took}


class Composed:
    """The cartogram of several stages: each map takes the picture the stage before left (the composition is a map of the extent)."""

    def __init__(self, maps):
        self.maps = maps

    def apply(self, xy):
        for m in self.maps:
            xy = m.apply(xy)
        return xy


def _stage(rings, roles, w, h, grid, sigma, tol, max_steps, log, gamma=1.0):
    """One annealing stage: the density is uniform inside each shape (its roles over its cells), blurred by sigma cells."""
    margin = grid // 4
    ny, nx = math.ceil(h * grid - 1e-9), math.ceil(w * grid - 1e-9)
    shape = (ny + 2 * margin, nx + 2 * margin)
    inside = np.zeros(shape, bool)
    inside[margin:margin + ny, margin:margin + nx] = True
    ids = list(rings)
    label = np.full(shape, -1)
    for i, sid in enumerate(ids):
        label[rasterize([r * grid + margin for r in rings[sid]], shape)] = i
    land = label >= 0
    cnt = np.bincount(label[land], minlength=len(ids)).astype(float)
    per = np.array([float(roles.get(sid, 0.0)) / cnt[i] if cnt[i] else 0.0 for i, sid in enumerate(ids)])
    dense = np.zeros(shape)
    dense[land] = per[label[land]]
    mean_land = float(dense[land].mean()) if land.any() else 1.0
    dense[land & (dense <= 0)] = FLOOR * mean_land           # land without roles keeps the floor
    if gamma != 1.0:
        dense[land] = dense[land] ** gamma
        mean_land = float(dense[land].mean())
    sea = mean_land                                          # the sea and the margin keep the mean land density
    blend = smooth(np.where(land, dense, sea), sigma)
    blend[~inside] *= blend[inside].mean() / blend[~inside].mean()
    start = time.time()
    P, err1, steps, _ = equalise(blend, tol, max_steps)
    fixed = np.zeros((shape[0] + 1, shape[1] + 1), bool)
    fixed[0, :] = fixed[-1, :] = fixed[:, 0] = fixed[:, -1] = True
    P, err, fit, folds = area_fit(P, blend / blend.mean(), fixed, tol, FIT_STEPS)
    took = time.time() - start
    log(f'    stage sigma {sigma:.1f} cells: flow {steps} steps (error {err1:.3f}), area fit {fit} steps, error {err:.4f}, '
        f'smallest cell area {folds:.4f}, {took:.1f} s')
    return {'map': Cartogram(P, 1.0 / grid, margin), 'error': err, 'folds': folds, 'time': took}


def cartogram_staged(rings, roles, w, h, sigmas, grid=GRID, tol=TOL, max_steps=FLOW_STEPS, log=print, stage_limit=STAGE_MAX_ERR, gamma=1.0):
    """Annealed multi-stage cartogram (Gastner, Seguy and More 2018 style): the stages use the blur widths in sigmas (cells, decreasing).
    Each stage starts from the picture the stage before left: its shapes are rasterised at their displaced positions, their uniform
    densities are blurred and the flow and the area fit take them to the next picture. The result composes all stages."""
    cur = {sid: [densify(r, 2.0 / grid) for r in rs] for sid, rs in rings.items()}
    maps, errs, folds, total = [], [], [], 0.0
    for sigma in sigmas:
        res = _stage(cur, roles, w, h, grid, sigma, tol, max_steps, log, gamma)
        maps.append(res['map'])
        errs.append(res['error'])
        folds.append(res['folds'])
        total += res['time']
        if res['error'] > stage_limit or res['folds'] <= 0:
            log(f'  stage sigma {sigma:.1f} diverged (error {res["error"]:.3f}, smallest cell area {res["folds"]:.4f})')
            return {'map': None, 'ok': False, 'error': res['error'], 'folds': res['folds'], 'stage_errors': errs, 'time': total}
        cur = {sid: [res['map'].apply(r) for r in rs] for sid, rs in cur.items()}
    log(f'  {len(sigmas)} stages, final error {errs[-1]:.4f}, smallest cell area {min(folds):.4f}, {total:.1f} s')
    return {'map': Composed(maps), 'ok': True, 'error': errs[-1], 'folds': min(folds), 'stage_errors': errs, 'time': total}


def annealed(rings, points, roles, w, h, km_per_cell, grid=GRID, log=print, stage_limit=STAGE_MAX_ERR, gamma=1.0):
    """The map of one extent: the annealed stages (STAGES_KM) when they converge, else the single stage (cartogram).
    Returns (result, method) with method 'staged' or 'single'. A scope with fewer than two distinct stages is single."""
    sigmas = []                                          # blur widths in cells; a stage below MIN_STAGE_CELLS would be a sub-cell step
    for k in STAGES_KM:
        c = max(k / km_per_cell, MIN_STAGE_CELLS)
        if not sigmas or abs(c - sigmas[-1]) > 1e-9:
            sigmas.append(c)
    if len(sigmas) >= 2:
        res = cartogram_staged(rings, roles, w, h, sigmas, grid=grid, log=log, stage_limit=stage_limit, gamma=gamma)
        if res['ok']:
            return res, 'staged'
        log('  staged method diverged: falling back to the single stage')
    res = cartogram(rings, points, w, h, grid=grid, blend_cells=max(BLEND_SMOOTH, BLEND_KM / km_per_cell), log=log, gamma=gamma)
    return res, 'single'


class Frame:
    """An extent's plane: x east from the west edge, y south from the north edge, in units of the longer side (max(w, h) = 1)."""

    def __init__(self, box, kx):
        self.lon0, self.lat0, self.lon1, self.lat1 = box
        self.kx = kx
        W, H = (self.lon1 - self.lon0) * kx, self.lat1 - self.lat0
        self.s = max(W, H)
        self.w, self.h = W / self.s, H / self.s

    def xy(self, lon, lat):
        """(n, 2) plane points of lon, lat arrays."""
        return np.stack([(np.asarray(lon, float) - self.lon0) * self.kx / self.s, (self.lat1 - np.asarray(lat, float)) / self.s], -1)


def ring_xy(frame, ring):
    """A lon/lat ring as plane points. Longitudes are unwrapped first, so a ring that crosses the antimeridian stays whole."""
    lon = np.degrees(np.unwrap(np.radians([p[0] for p in ring])))
    return frame.xy(lon, [p[1] for p in ring])


def scope_box(scope, shapes):
    """(box, kx) of a profile scope: the match decides it (any: the world; continent EU: Europe; country: its bounds + 3 %; country and admin1:
    the state's bounds + 5 %). kx is the cosine of the mid latitude for the regional extents, 1 for the world."""
    m = scope['match']
    if 'any' in m:
        return WORLD, 1.0
    if 'continent' in m:
        if m['continent'] != 'EU':
            raise GeoMapError(f'scope {scope["id"]!r}: only continent EU has an extent (use "any" or a country)')
        box = EUROPE
    else:
        cc = m['country']
        if 'admin1' in m:
            found = [s for s in shapes['states'] if s['cc'] == cc and m['admin1'] in [s['name']] + s['match']]
            pad = 0.05
        else:
            found = [s for s in shapes['states'] + shapes['countries'] if s['cc'] == cc]
            pad = 0.03
        if not found:
            raise GeoMapError(f'scope {scope["id"]!r}: no polygon for {cc} {m.get("admin1", "")} in the Natural Earth files')
        lon = [p[0] for s in found for r in s['rings'] for p in r]
        lat = [p[1] for s in found for r in s['rings'] for p in r]
        lon0, lon1, lat0, lat1 = min(lon), max(lon), min(lat), max(lat)
        dlon, dlat = (lon1 - lon0) * pad, (lat1 - lat0) * pad
        box = (lon0 - dlon, lat0 - dlat, lon1 + dlon, lat1 + dlat)
    return box, math.cos(math.radians((box[1] + box[3]) / 2))


def centroid(rings):
    """(lat, lon) area centroid of the largest ring of a shape (lon/lat rings)."""
    best = None
    for r in rings:
        a = np.array(r, float)
        if len(a) < 3:
            continue
        x, y = a[:, 0], a[:, 1]
        cross = x * np.roll(y, -1) - np.roll(x, -1) * y
        area = cross.sum() / 2
        if best is None or abs(area) > abs(best[0]):
            if abs(area) > 0:
                best = (area, float(((x + np.roll(x, -1)) * cross).sum() / (6 * area)), float(((y + np.roll(y, -1)) * cross).sum() / (6 * area)))
            else:
                best = (0.0, float(x.mean()), float(y.mean()))
    return None if best is None else (best[2], best[1])


def role_places(index, desc, shapes):
    """The places of the board's roles: {key: {'key', 'name', 'cc', 'n' (roles naming it), 'share' (sum of 1/places per role),
    'll' (lat, lon) or None, 'shape' (polygon id or None)}}, the roles with no place, and the roles' share per polygon id."""
    by_id = {s['id']: s for s in shapes['countries'] + shapes['states']}
    state_id = {(s['cc'], s['name']): s['id'] for s in shapes['states']}
    country_id = {s['cc']: s['id'] for s in shapes['countries']}
    coords = geo.coords()
    table, unplaced, shape_share = {}, 0, {}
    for rid, _title, _co, _url, _slug in index:
        text = (desc.get(rid) or {}).get('l', '')
        places = [p for p in geo.resolve(text)['places'] if p.get('country')][:4]
        if not places:
            unplaced += 1
            continue
        share = 1.0 / len(places)
        for p in places:
            cc, city, state = p['country'], p.get('city', ''), p.get('state', '')
            key = f'{cc}|{city or state}' if (city or state) else cc
            rec = table.get(key)
            if rec is None:
                shape = state_id.get((cc, state)) or country_id.get(cc)
                ll = coords.get(f'{cc}|{city}') if city else None
                if ll is not None:
                    ll = (float(ll[0]), float(ll[1]))
                elif shape is not None:
                    ll = centroid(by_id[shape]['rings'])        # no city point: the state's (or country's) polygon centre
                name = city or state or geo.COUNTRY.get(cc, {}).get('en', cc)
                rec = table[key] = {'key': key, 'name': name, 'cc': cc, 'n': 0, 'share': 0.0, 'll': ll, 'shape': shape}
            rec['n'] += 1
            rec['share'] += share
            if rec['shape']:
                shape_share[rec['shape']] = shape_share.get(rec['shape'], 0.0) + share
    return table, unplaced, shape_share


def read_companies(path):
    """[(slug, (lat, lon))] of the catalogue's companies that have coordinates."""
    try:
        with open(path, encoding='utf-8') as fh:
            data = json.load(fh)
    except (OSError, ValueError) as e:
        raise GeoMapError(f'cannot read the companies catalogue {path}: {e}')
    rows = data.get('companies', data) if isinstance(data, dict) else data
    out = []
    for c in rows:
        ll = c.get('coordinates')
        if ll and len(ll) == 2 and c.get('slug'):
            out.append((c['slug'], (float(ll[0]), float(ll[1]))))
    return out


def scope_map(scope, box, kx, shapes, table, companies, shape_roles, log=print):
    """The map of one scope: shapes, places and companies with their true and cartogram positions, and the validation."""
    frame = Frame(box, kx)
    names = {s['id']: s for s in shapes['countries'] + shapes['states']}
    rings = {}                                    # id -> the shape's rings cut to the extent (full resolution)
    for s in names.values():
        rs = [clip_box(ring_xy(frame, r), frame.w, frame.h) for r in s['rings']]
        rs = [r for r in rs if len(r) >= 3]
        if rs:
            rings[s['id']] = rs
    log(f'scope {scope["id"]}: extent {tuple(round(v, 2) for v in box)}, {len(rings)} shapes')
    if not rings:
        raise GeoMapError(f'scope {scope["id"]!r}: no shape in the extent')
    inside_places = []
    for rec in table.values():
        if rec['ll'] is None:
            continue
        x, y = frame.xy([rec['ll'][1]], [rec['ll'][0]])[0]
        if 0 <= x <= frame.w and 0 <= y <= frame.h:
            inside_places.append((rec, x, y))
    points = np.array([[x, y, rec['share']] for rec, x, y in inside_places]).reshape(-1, 3)
    km_per_cell = 111.2 * frame.s / GRID                 # a plane unit is about one degree of latitude
    roles_in = {}
    for rec, _x, _y in inside_places:
        if rec['shape'] in rings:
            roles_in[rec['shape']] = roles_in.get(rec['shape'], 0.0) + rec['share']
    res, method = annealed(rings, points, roles_in, frame.w, frame.h, km_per_cell, log=log)
    carto = res['map']
    res_m, method_m = annealed(rings, points, roles_in, frame.w, frame.h, km_per_cell, log=log, gamma=MODERATE)
    carto_m = res_m['map']
    comp_in = []
    for slug, (lat, lon) in companies:
        x, y = frame.xy([lon], [lat])[0]
        if 0 <= x <= frame.w and 0 <= y <= frame.h:
            comp_in.append((slug, x, y))
    # validation: each shape's area after the transform (edges cut finely first), against its share of the roles inside the extent
    cell = 1.0 / GRID
    area = {sid: sum(poly_area(carto.apply(densify(r, VALID_STEP * cell))) for r in rs) for sid, rs in rings.items()}
    total_area = sum(area.values())
    area_m = {sid: sum(poly_area(carto_m.apply(densify(r, VALID_STEP * cell))) for r in rs) for sid, rs in rings.items()}
    total_area_m = sum(area_m.values())
    target = {}
    for rec, _x, _y in inside_places:
        if rec['shape'] in rings:
            target[rec['shape']] = target.get(rec['shape'], 0.0) + rec['share']
    total_target = sum(target.values()) or 1.0
    for sid in sorted(rings, key=lambda sid: -target.get(sid, 0.0))[:5]:
        log(f'  {sid:<10} roles {target.get(sid, 0.0) / total_target:7.2%}  area {area[sid] / total_area:7.2%}  '
            f'moderate {area_m[sid] / total_area_m:7.2%}  ({names[sid]["name"]})')
    # the output: simplified rings, cut finely (the transform bends them), with their true and cartogram positions
    out_shapes = []
    for sid, rs in rings.items():
        out_rings = []
        for r in rs:
            s = simplify(r, SIMPLIFY)
            if len(s) < 3 or poly_area(s) < RING_MIN * frame.w * frame.h:
                continue
            s = densify(s, OUT_STEP * cell)
            c = carto.apply(s)
            m = carto_m.apply(s)
            out_rings.append([[round(float(a), 4), round(float(b), 4), round(float(c_[0]), 4), round(float(c_[1]), 4),
                               round(float(m_[0]), 4), round(float(m_[1]), 4)]
                              for (a, b), c_, m_ in zip(s, c, m)])
        if out_rings:
            sh = names[sid]
            out_shapes.append({'id': sid, 'name': sh['name'], 'kind': sh['kind'], 'roles': int(round(shape_roles.get(sid, 0.0))),
                               'rings': out_rings})
    out_places = []
    if inside_places:
        pos = carto.apply([[x, y] for _rec, x, y in inside_places])
        pos_m = carto_m.apply([[x, y] for _rec, x, y in inside_places])
        for (rec, x, y), (cx, cy), (mx, my) in zip(inside_places, pos, pos_m):
            out_places.append({'id': rec['key'], 'name': rec['name'], 'n': rec['n'], 'x': round(x, 4), 'y': round(y, 4),
                               'cx': round(float(cx), 4), 'cy': round(float(cy), 4), 'mx': round(float(mx), 4), 'my': round(float(my), 4)})
    out_companies = []
    if comp_in:
        pos = carto.apply([[x, y] for _s, x, y in comp_in])
        pos_m = carto_m.apply([[x, y] for _s, x, y in comp_in])
        for (slug, x, y), (cx, cy), (mx, my) in zip(comp_in, pos, pos_m):
            out_companies.append({'slug': slug, 'x': round(x, 4), 'y': round(y, 4), 'cx': round(float(cx), 4), 'cy': round(float(cy), 4),
                                  'mx': round(float(mx), 4), 'my': round(float(my), 4)})
    log(f'  {len(out_shapes)} shapes, {len(out_places)} places, {len(out_companies)} companies in the extent')
    return {'extent': [round(v, 4) for v in box], 'w': round(frame.w, 4), 'h': round(frame.h, 4), 'shapes': out_shapes,
            'places': out_places, 'companies': out_companies, 'error': round(res['error'], 4), 'method': method,
            'moderate': {'error': round(res_m['error'], 4), 'method': method_m, 'gamma': MODERATE}}


def build(site, profile, vectors, companies=None, cache=None, log=print):
    """Writes VECTORS/geo-map.json for the board in SITE. Returns its path."""
    if not os.path.exists(os.path.join(site, 'jobs-index.json')):
        raise GeoMapError(f'no jobs-index.json in {site} (run jobcrawl build first)')
    cache = cache or os.path.join(vectors, '.geo-cache')
    shapes = geo_base.load(cache, ('DE',), log)
    index, desc = read_site(site)
    table, unplaced, shape_share = role_places(index, desc, shapes)
    log(f'roles: {len(index)}, placed {len(index) - unplaced}, not placed {unplaced} (remote or no place named); {len(table)} places')
    comp = read_companies(companies) if companies else []
    scopes = profile['scopes'] if profile else DEFAULT_SCOPES
    out = {'version': 1, 'source': SOURCE, 'scopes': {}}
    for scope in scopes:
        box, kx = scope_box(scope, shapes)
        out['scopes'][scope['id']] = scope_map(scope, box, kx, shapes, table, comp, shape_share, log)
    os.makedirs(vectors, exist_ok=True)
    path = os.path.join(vectors, FILE)
    with open(path, 'w', encoding='utf-8') as fh:
        json.dump(out, fh, ensure_ascii=False, separators=(',', ':'))
    log(f'geo-map: {len(scopes)} scopes, {os.path.getsize(path) / 1e6:.2f} MB -> {path}')
    return path
