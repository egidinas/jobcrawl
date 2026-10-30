"""Geographic cartogram of the board: real geography, each area swollen or shrunk to its share of the open roles (a "homunculus" map).

    jobcrawl geomap --site SITE [--profile DIR] [--vectors DIR] [--companies FILE] [--cache DIR]     (needs numpy)

Density-equalising cartogram. Stage 1 is Gastner & Newman (2004): the role density is diffused (a heat kernel, applied with numpy's FFT) and
the grid's nodes move along -grad(density)/density, so every cell keeps its mass. Stage 2 corrects what the flow leaves over: Gauss-Newton
steps on the cells' log areas (preconditioned conjugate gradients on the node grid), each kept only when no cell folds and the fit improves.
Each profile scope gets its own extent (worldwide: the whole world; continent EU: Europe; country: its bounds + 3 %; country and admin1: the
state's bounds + 5 %). Outside the land the density is the land's mean (so the extent keeps its area), and empty land keeps a floor of the
mean land density (FLOOR), so nothing vanishes. The role places, the land polygons and the companies are moved by the same displacement
(bilinear between the nodes).

Every scope is drawn in Web Mercator (one projection for all of them, so the scopes line up and the web view can zoom from one to the next):
its extent is the box [x0, y0, x1, y1] in world Mercator units (0..1, y from the north edge), and its plane is that box normalised so the longer
side is 1 (w, h). The outlines are Eurostat GISCO at each scope's level of detail, the rivers Natural Earth (rank filtered per scope).

Reads: SITE/jobs-index.json and SITE/jobs-desc-XX.json (the location text l of every role; jobcrawl.geo.geo.resolve gives its places); the
profile's scopes (without --profile: the worldwide scope); the companies catalogue (--companies: companies[].coordinates [lat, lon], optional);
the outlines and rivers (jobcrawl/map/geo_base.py, downloaded into --cache when they are not there yet).
Writes VECTORS/geo-map-<scope id>.json (version 2, one file per scope: {id, extent, box, w, h, shapes, places, companies, rivers, error, method,
moderate}) and VECTORS/geo-map.json, the index: {version, projection, source, scopes: {id: {file, box, extent, w, h, error, method, moderate,
rivers}}}. Positions are 0..1 units with y counted from the north edge: x, y the true position, cx, cy the cartogram position (density as is), mx, my
the moderate cartogram position (each area (1 - MODERATE) its true size plus MODERATE its cartogram size: a milder distortion). publish copies the
index and every scope file into SITE/match/ (config.json names the index).
"""
import collections
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
MODERATE = 0.3  # the intermediate map: each area 70 % its true size plus 30 % its full-cartogram size (none shrinks below 70 %)
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
SIMPLIFY = 0.0003           # Douglas-Peucker tolerance, in units of the longer side (the outlines and the rivers; 0.003 before the x10 detail)
RING_MIN = 0.000005         # rings smaller than this share of the extent are dropped (islets; never a shape's largest ring, never a hole); a world map keeps islands of about 5,000 km2
VALID_STEP = 0.25           # cells: edges are cut this finely before the areas are measured
OUT_STEP = 2.0              # cells: output edges are cut this finely before the transform (the transform bends them)
DEC = 5                     # decimals of the output positions (rings, rivers, places, companies): the web view zooms in on the extent
WORLD = (-180.0, -60.0, 180.0, 80.0)
EUROPE = (-25.0, 34.0, 45.0, 72.0)
SOURCE = 'Eurostat GISCO boundaries (c) EuroGeographics; Natural Earth (public domain); GeoNames (CC BY 4.0)'
FILE = 'geo-map.json'       # the index (version 2); the scopes are in geo-map-<scope id>.json beside it


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


def _clip_segment(a, b, w, h):
    """The part of the segment a-b inside 0..w x 0..h (Liang-Barsky), or None when it lies outside."""
    t0, t1 = 0.0, 1.0
    dx, dy = b[0] - a[0], b[1] - a[1]
    for p, q in ((-dx, a[0]), (dx, w - a[0]), (-dy, a[1]), (dy, h - a[1])):
        if p == 0:
            if q < 0:
                return None
            continue
        r = q / p
        if p < 0:
            if r > t1:
                return None
            t0 = max(t0, r)
        else:
            if r < t0:
                return None
            t1 = min(t1, r)
    # the ends that are not cut stay exact, so consecutive segments meet at the same point
    return (a if t0 == 0.0 else a + t0 * (b - a)), (b if t1 == 1.0 else a + t1 * (b - a))


def clip_line(pts, w, h):
    """The polyline (n, 2) cut to the rectangle 0..w x 0..h: a list of the pieces inside it (a line that leaves the box and comes back gives two)."""
    pieces, cur = [], []
    for a, b in zip(pts[:-1], pts[1:]):
        seg = _clip_segment(a, b, w, h)
        if seg is None:
            if len(cur) >= 2:
                pieces.append(np.array(cur))
            cur = []
            continue
        p, q = seg
        if not cur or not np.array_equal(cur[-1], p):
            if len(cur) >= 2:
                pieces.append(np.array(cur))
            cur = [p]
        cur.append(q)
    if len(cur) >= 2:
        pieces.append(np.array(cur))
    return pieces


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


def cartogram(rings, points, w, h, grid=GRID, tol=TOL, max_steps=FLOW_STEPS, blend_cells=BLEND_SMOOTH, log=print, mix=1.0):
    """The cartogram of one extent (w x h, normalised so that max(w, h) = 1).

    rings: {shape id: [ring, ...]} with each ring an (n, 2) array of plane points already cut to the extent (see clip_box).
    points: (n, 3) rows of x, y, mass: the roles' places inside the extent.
    mix: the share of the role density in the target, the rest the mean (1: the full cartogram; MODERATE: the intermediate map).
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
        if mix != 1.0:
            dense[land] = (1.0 - mix) * float(dense[land].mean()) + mix * dense[land]
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


def _stage(rings, roles, w, h, grid, sigma, tol, max_steps, log):
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


def cartogram_staged(rings, roles, w, h, sigmas, grid=GRID, tol=TOL, max_steps=FLOW_STEPS, log=print, stage_limit=STAGE_MAX_ERR):
    """Annealed multi-stage cartogram (Gastner, Seguy and More 2018 style): the stages use the blur widths in sigmas (cells, decreasing).
    Each stage starts from the picture the stage before left: its shapes are rasterised at their displaced positions, their uniform
    densities are blurred and the flow and the area fit take them to the next picture. The result composes all stages."""
    cur = {sid: [densify(r, 2.0 / grid) for r in rs] for sid, rs in rings.items()}
    maps, errs, folds, total = [], [], [], 0.0
    for sigma in sigmas:
        res = _stage(cur, roles, w, h, grid, sigma, tol, max_steps, log)
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


def annealed(rings, points, roles, w, h, km_per_cell, grid=GRID, log=print, stage_limit=STAGE_MAX_ERR, mix=1.0):
    """The map of one extent: the annealed stages (STAGES_KM) when they converge, else the single stage (cartogram).
    Returns (result, method) with method 'staged' or 'single'. A scope with fewer than two distinct stages is single.
    mix: the share of the roles in each area's target, the rest its true area (1: the full cartogram)."""
    sigmas = []                                          # blur widths in cells; a stage below MIN_STAGE_CELLS would be a sub-cell step
    for k in STAGES_KM:
        c = max(k / km_per_cell, MIN_STAGE_CELLS)
        if not sigmas or abs(c - sigmas[-1]) > 1e-9:
            sigmas.append(c)
    mixed = roles                                        # mix < 1: each shape's target is fixed here, as the stages would compound a mix
    if mix != 1.0:
        area = {sid: sum(abs(poly_area(r)) for r in rs) for sid, rs in rings.items()}
        ta, tr = sum(area.values()) or 1.0, sum(roles.values()) or 1.0
        mixed = {sid: (1.0 - mix) * area[sid] / ta * tr + mix * float(roles.get(sid, 0.0)) for sid in rings}
    if len(sigmas) >= 2:
        res = cartogram_staged(rings, mixed, w, h, sigmas, grid=grid, log=log, stage_limit=stage_limit)
        if res['ok']:
            return res, 'staged'
        log('  staged method diverged: falling back to the single stage')
    res = cartogram(rings, points, w, h, grid=grid, blend_cells=max(BLEND_SMOOTH, BLEND_KM / km_per_cell), log=log, mix=mix)
    return res, 'single'


def scope_file(scope_id):
    """The file of one scope in the vectors folder (the index is FILE)."""
    return f'geo-map-{scope_id}.json'


def merc(lon, lat):
    """Web Mercator in world units: x 0 at 180 degrees west to 1 at 180 east, y 0 at the top (85.05 north) to 1 at the bottom."""
    lat = np.clip(np.asarray(lat, float), -85.05, 85.05)
    return (np.asarray(lon, float) + 180.0) / 360.0, 0.5 - np.log(np.tan(np.pi / 4 + np.radians(lat) / 2)) / (2 * np.pi)


class Frame:
    """An extent's plane: the extent in Web Mercator (one projection for every scope, so they line up), x east from the west edge, y south
    from the north edge, in units of the longer side (max(w, h) = 1). box: the extent in world units (see merc); deg: plane units per degree
    of latitude at the extent's middle (for distances given in degrees or km)."""

    def __init__(self, box, kx=None):   # kx: no longer used (the projection is the same for every extent)
        self.lon0, self.lat0, self.lon1, self.lat1 = box
        (X0, X1), (Y1, Y0) = merc([self.lon0, self.lon1], [self.lat0, self.lat1])
        self.X0, self.Y0 = float(X0), float(Y0)
        W, H = float(X1 - X0), float(Y1 - Y0)
        self.s = max(W, H)
        self.w, self.h = W / self.s, H / self.s
        self.box = [self.X0, self.Y0, float(X1), float(Y1)]
        self.deg = 1.0 / (360.0 * math.cos(math.radians((self.lat0 + self.lat1) / 2)) * self.s)

    def xy(self, lon, lat):
        """(n, 2) plane points of lon, lat arrays."""
        x, y = merc(lon, lat)
        return np.stack([(x - self.X0) / self.s, (y - self.Y0) / self.s], -1)


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
            found = [s for s in shapes['states'] if s['cc'] == cc and (m['admin1'] in [s['name']] + s['match'] or s.get('parent') == m['admin1'])]
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


def role_places(index, desc, shapes, keys_of=None):
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
            if keys_of is not None:
                keys_of.setdefault(rid, []).append(key)
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


def km(a, b):
    """Great-circle distance in km between two (lat, lon)."""
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 12742 * math.asin(min(1.0, math.sqrt(h)))


def place_of(text, by_id, state_id, country_id, coords):
    """The main place a location text names: (key, name, (lat, lon) or None), or None (the same resolution as role_places)."""
    places = [p for p in geo.resolve(text)['places'] if p.get('country')][:1]
    if not places:
        return None
    p = places[0]; cc, city, state = p['country'], p.get('city', ''), p.get('state', '')
    key = f'{cc}|{city or state}' if (city or state) else cc
    shape = state_id.get((cc, state)) or country_id.get(cc)
    ll = coords.get(f'{cc}|{city}') if city else None
    if ll is not None:
        ll = (float(ll[0]), float(ll[1]))
    elif shape is not None:
        ll = centroid(by_id[shape]['rings'])
    return key, city or state or geo.COUNTRY.get(cc, {}).get('en', cc), ll


def read_history(path):
    """[(company, location, first_seen, last_seen, status)] of the crawl history (scan-history.tsv: every role ever seen)."""
    rows = []
    with open(path, encoding='utf-8') as fh:
        head = fh.readline().rstrip('\n').split('\t'); ix = {h: i for i, h in enumerate(head)}
        for line in fh:
            q = line.rstrip('\n').split('\t')
            if len(q) >= len(head):
                rows.append((q[ix['company']], q[ix['location']], q[ix['first_seen']], q[ix['last_seen']], q[ix['status']]))
    return rows


def catalogue_names(path):
    """{lower-case name or alias: slug} of the companies catalogue."""
    with open(path, encoding='utf-8') as fh:
        data = json.load(fh)
    out = {}
    for c in (data.get('companies', data) if isinstance(data, dict) else data):
        for n in [c.get('name')] + list(c.get('aliases') or []):
            if n and c.get('slug'):
                out[n.lower()] = c['slug']
    return out


def catalogue_places(path, coords):
    """[(slug, (lat, lon), name)] of the branch locations the catalogue itself holds: a branch given with coordinates (companies[].branches as objects with
    "coordinates": [lat, lon]), and the places of the company's own geo classification (companies[].geo.p: city, area, state, country code, continent;
    the city's point from the gazetteer). Branches that are only an address text are placed by the geocoding check (tools/geo_verify.py)."""
    with open(path, encoding='utf-8') as fh:
        data = json.load(fh)
    out = []
    for c in (data.get('companies', data) if isinstance(data, dict) else data):
        slug = c.get('slug')
        if not slug:
            continue
        for b in c.get('branches') or []:
            ll = b.get('coordinates') if isinstance(b, dict) else None
            if ll and len(ll) == 2:
                out.append((slug, (float(ll[0]), float(ll[1])), (b.get('city') or b.get('name') or 'branch')))
        g = c.get('geo')
        for pl in (g.get('p') if isinstance(g, dict) else None) or []:
            if len(pl) >= 4 and pl[0]:
                ll = coords.get(f'{pl[3]}|{pl[0]}')
                if ll is not None:
                    out.append((slug, (float(ll[0]), float(ll[1])), pl[0]))
    return out


def company_points(index, keys_of, table, hq, near_km=15.0, max_branches=12, history=None, addresses=None):
    """The points of the companies map: [(slug, (lat, lon), ids, place key, meta)]. meta: {'k': kind, 'pn': place name, 'h': roles ever seen there, 'ls': last seen}.
    - 'hq': the company at its headquarters (the catalogue's coordinates, or an address checked on OpenStreetMap when the catalogue has none); ids lists
      the roles there when the company has branch points (None: the point stands for all its roles).
    - 'branch': a place farther than near_km from the headquarters where the company has open roles now; ids = those roles. A company without
      coordinates is located by the geo classification: at the places of its roles.
    - 'past': a place where the company had roles before (history: [(slug, key, name, ll, n, last_seen)]) and has none now.
    - 'addr': a branch address on file (addresses: [(slug, (lat, lon), name)], the checked branches of the catalogue).
    A place within near_km of a point the company already has is not added again."""
    by = {}
    for rid, _title, _co, _url, slug in index:
        ks = keys_of.get(rid)
        if slug and ks:
            by.setdefault(slug, {}).setdefault(ks[0], []).append(rid)       # a role's first place is its main one
    out, seen = [], {}
    for slug in sorted(set(hq) | set(by)):
        base, groups = hq.get(slug), by.get(slug, {})
        home, branches = [], []
        for key, ids in sorted(groups.items(), key=lambda kv: -len(kv[1])):
            ll = (table.get(key) or {}).get('ll')
            if ll is None or (base is not None and km(base, ll) <= near_km) or len(branches) >= max_branches:
                home += ids
            else:
                branches.append((ll, ids, key, table[key]['name']))
        if base is not None:
            out.append((slug, base, home if branches else None, None, {'k': 'hq'}))
            seen.setdefault(slug, []).append(base)
        for ll, ids, key, name in branches:
            out.append((slug, ll, ids, key, {'k': 'branch', 'pn': name}))
            seen.setdefault(slug, []).append(ll)
    near = lambda slug, ll: any(km(ll, q) <= near_km for q in seen.get(slug, []))
    for slug, key, name, ll, n, last in sorted(history or [], key=lambda h: -h[4]):
        if ll is not None and not near(slug, ll) and sum(1 for o in out if o[0] == slug) < max_branches + 1:
            out.append((slug, ll, [], key, {'k': 'past', 'pn': name, 'h': n, 'ls': last})); seen.setdefault(slug, []).append(ll)
    for slug, ll, name in addresses or []:
        if not near(slug, ll):
            out.append((slug, ll, [], None, {'k': 'addr', 'pn': name})); seen.setdefault(slug, []).append(ll)
    return out


def simplify_open(pts, tol):
    """Douglas-Peucker on an open polyline; both ends are kept."""
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
    return pts[keep]


def densify_open(pts, step):
    """An open polyline with extra points so that no edge is longer than step; both ends are kept."""
    out = []
    for a, b in zip(pts[:-1], pts[1:]):
        n = max(1, int(math.ceil(math.hypot(*(b - a)) / step)))
        out.append(a + (b - a) * np.arange(n)[:, None] / n)
    out.append(pts[-1:])
    return np.vstack(out)


def weld_rings(rings, tol, step, carto, carto_m):
    """{shape id: [(simplified ring, dense ring, cartogram positions, moderate positions)]} with the borders two shapes have in common kept as ONE line.
    Every ring is cut into arcs at the points where the set of shapes using its edges changes (a border shared with a neighbour, a stretch with none, a
    triple point); each distinct arc is simplified, cut finely and warped once, and both neighbours are built from that same line. Simplifying each ring
    on its own keeps different points along a common border, and the two outlines then come apart; the warp itself moves equal points equally."""
    Q = 1e5
    key = lambda p: (int(round(p[0] * Q)), int(round(p[1] * Q)))
    prep, uses = {}, {}
    for sid, rs in rings.items():
        for ri, r in enumerate(rs):
            ks, pts = [], []
            for p in r:
                k = key(p)
                if ks and k == ks[-1]:
                    continue
                ks.append(k); pts.append(p)
            if len(ks) > 1 and ks[0] == ks[-1]:
                ks.pop(); pts.pop()
            if len(ks) < 3:
                continue
            prep[(sid, ri)] = (np.array(pts), ks)
            for a, b in zip(ks, ks[1:] + ks[:1]):
                uses.setdefault(frozenset((a, b)), set()).add(sid)
    arcs, plan = {}, {}
    for rk, (pts, ks) in prep.items():
        n = len(ks)
        sig = [frozenset(uses[frozenset((ks[i], ks[(i + 1) % n]))]) for i in range(n)]
        starts = [i for i in range(n) if sig[i] != sig[i - 1]]
        pieces = []
        if not starts:
            pieces.append((list(range(n)) + [0], 'c'))
        else:
            for j, s0 in enumerate(starts):
                e0 = starts[(j + 1) % len(starts)]
                idx, i = [], s0
                while True:
                    idx.append(i); i = (i + 1) % n
                    if i == e0:
                        idx.append(i); break
                pieces.append((idx, 'o'))
        order = []
        for idx, kind in pieces:
            seq = tuple(ks[i] for i in idx)
            canon = min(seq, seq[::-1])
            ck = (kind, canon)
            rev = seq != canon
            if ck not in arcs:
                a = np.array([pts[i] for i in idx])
                arcs[ck] = a[::-1].copy() if rev else a
            order.append((ck, rev))
        plan[rk] = order
    done = {}
    for ck, a in arcs.items():
        if ck[0] == 'c':
            sm = simplify(a[:-1], tol); sm = np.vstack([sm, sm[:1]])
        else:
            sm = simplify_open(a, tol)
        d = densify_open(sm, step)
        done[ck] = (sm, d, carto.apply(d), carto_m.apply(d))
    out = {}
    for (sid, ri), order in plan.items():
        parts = []
        for ck, rev in order:
            sm, d, c, m = done[ck]
            if rev:
                sm, d, c, m = sm[::-1], d[::-1], c[::-1], m[::-1]
            parts.append((sm[:-1], d[:-1], c[:-1], m[:-1]))
        out.setdefault(sid, []).append(tuple(np.vstack([q[i] for q in parts]) for i in range(4)))
    return out


def in_ring(x, y, ring):
    """Even-odd test of the points x, y (arrays) against one ring (n, 2)."""
    x1, y1 = ring[:, 0], ring[:, 1]
    x2, y2 = np.roll(x1, -1), np.roll(y1, -1)
    inside = np.zeros(len(x), bool)
    for a, b, c, d in zip(x1, y1, x2, y2):
        cross = (b > y) != (d > y)
        if cross.any():
            xi = a + (y - b) * (c - a) / (d - b + 1e-30)
            inside ^= cross & (x < xi)
    return inside


def shape_of_points(x, y, rings, cc_of=None, only_cc=None):
    """The id of the shape containing each point (None: in no shape; with only_cc, only shapes of that country count)."""
    x, y = np.asarray(x, float), np.asarray(y, float)
    out = [None] * len(x)
    for sid, rs in rings.items():
        if only_cc is not None and cc_of[sid] != only_cc:
            continue
        for r in rs:
            lo, hi = r.min(0), r.max(0)
            m = np.where((x >= lo[0]) & (x <= hi[0]) & (y >= lo[1]) & (y <= hi[1]))[0]
            if len(m):
                hit = in_ring(x[m], y[m], r)
                for i in m[hit]:
                    if out[i] is None:
                        out[i] = sid
    return out


def nearest_on_rings(px, py, rs):
    """(distance, x, y) of the point on the rings' outlines nearest to (px, py)."""
    best = (1e9, px, py)
    for r in rs:
        a, b = r, np.roll(r, -1, axis=0)
        d = b - a
        L = (d ** 2).sum(1)
        t = np.clip(((px - a[:, 0]) * d[:, 0] + (py - a[:, 1]) * d[:, 1]) / np.where(L > 0, L, 1), 0, 1)
        qx, qy = a[:, 0] + t * d[:, 0], a[:, 1] + t * d[:, 1]
        dist = np.hypot(qx - px, qy - py)
        i = int(dist.argmin())
        if dist[i] < best[0]:
            best = (float(dist[i]), float(qx[i]), float(qy[i]))
    return best


def land_snap(pts, ccs, rings, cc_of, tol, eps):
    """Points that fall outside the land of their country (a coastal city a coarse outline leaves in the sea) are moved to the nearest point of that country's outline,
    a little way inland. pts: [(x, y)], ccs: the intended country of each (None: any). Returns (points, number moved, number with no land of their country within tol)."""
    pts = [list(p) for p in pts]
    if not pts:
        return pts, 0, 0
    x = np.array([p[0] for p in pts]); y = np.array([p[1] for p in pts])
    own = shape_of_points(x, y, rings)                       # on land of any country
    moved = lost = 0
    for i, sid in enumerate(own):
        cc = ccs[i]
        if sid is not None and (cc is None or cc_of[sid] == cc or not any(v == cc for v in cc_of.values())):
            continue
        cands = {k: r for k, r in rings.items() if cc is not None and cc_of[k] == cc} or ({k: r for k, r in rings.items()} if cc is None else {})
        if not cands:
            continue
        if cc is not None and sid is not None and shape_of_points([x[i]], [y[i]], cands)[0] is not None:
            continue
        best = (1e9, 0, 0)
        for k, rs in cands.items():
            lo = np.min([r.min(0) for r in rs], 0) - tol; hi = np.max([r.max(0) for r in rs], 0) + tol
            if not (lo[0] <= x[i] <= hi[0] and lo[1] <= y[i] <= hi[1]):
                continue
            c = nearest_on_rings(x[i], y[i], rs)
            if c[0] < best[0]:
                best = c
        if best[0] <= tol:
            d = math.hypot(best[1] - x[i], best[2] - y[i]) or 1.0
            pts[i] = [best[1] + (best[1] - x[i]) / d * eps, best[2] + (best[2] - y[i]) / d * eps]; moved += 1
        elif sid is None:
            lost += 1
    return pts, moved, lost


def _is_hole(ring, others):
    """Whether a ring lies inside another ring of the same shape (its first point does, by the even-odd rule)."""
    x, y = float(ring[0][0]), float(ring[0][1])
    for o in others:
        if len(o) < 3:
            continue
        inside, j = False, len(o) - 1
        for i in range(len(o)):
            xi, yi, xj, yj = float(o[i][0]), float(o[i][1]), float(o[j][0]), float(o[j][1])
            if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
                inside = not inside
            j = i
        if inside:
            return True
    return False


def river_rank_limit(width):
    """The largest scalerank drawn for an extent this many degrees of longitude wide: the world (wider than 90) its 3 largest rivers, Europe (wider than 20)
    the 6 largest, a country or a state all of them (None)."""
    return 3 if width > 90 else 6 if width > 20 else None


def river_rows(frame, rivers, carto, carto_m, log=print):
    """The rivers of an extent, as the output's 'rivers': [{'name', 'rank', 'pts': [[x, y, cx, cy, mx, my], ...]}] (see geo_base.load_rivers). Rivers
    above the rank limit are left out, and a detail river (the Europe file) is left out when a kept river of the same name is drawn (the same river
    in both files). Each river is cut to the extent, simplified with SIMPLIFY (the outlines' tolerance), cut finely and warped with the two maps the
    outlines use. Pieces with fewer than 2 points are dropped."""
    limit = river_rank_limit(frame.lon1 - frame.lon0)
    keep = [r for r in rivers if r.get('detail') or limit is None or r['rank'] <= limit]
    named = {r['name'] for r in keep if not r.get('detail') and r['name']}
    rows = []
    for r in keep:
        if r.get('detail') and r['name'] in named:
            continue
        for line in r['lines']:
            for piece in clip_line(ring_xy(frame, line), frame.w, frame.h):
                sm = simplify_open(piece, SIMPLIFY)
                d = densify_open(sm, OUT_STEP / GRID)
                if len(d) < 2:
                    continue
                c, m = carto.apply(d), carto_m.apply(d)
                pts = [[round(float(d[i, 0]), DEC), round(float(d[i, 1]), DEC), round(float(c[i, 0]), DEC), round(float(c[i, 1]), DEC),
                        round(float(m[i, 0]), DEC), round(float(m[i, 1]), DEC)] for i in range(len(d))]
                rows.append({'name': r['name'], 'rank': r['rank'], 'pts': pts})
    log(f'  {len(rows)} river pieces ({sum(len(q["pts"]) for q in rows)} points) of {len(rivers)} rivers read (rank limit {limit or "none"})')
    return rows


def scope_map(scope, box, kx, shapes, table, companies, shape_roles, log=print, rivers=()):
    """The map of one scope: shapes, places, companies and rivers with their true and cartogram positions, and the validation."""
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
    cc_of = {sid: names[sid]['cc'] for sid in rings}
    tol = 0.8 * frame.deg                                   # 0.8 degrees: a city this close to its country's coast, in a coarse outline's sea, is moved ashore
    eps = 0.004 * frame.deg
    inside_places = []
    for rec in table.values():
        if rec['ll'] is None:
            continue
        x, y = frame.xy([rec['ll'][1]], [rec['ll'][0]])[0]
        if 0 <= x <= frame.w and 0 <= y <= frame.h:
            inside_places.append((rec, x, y))
    snapped, n_moved, n_lost = land_snap([(x, y) for _r, x, y in inside_places], [r['cc'] for r, _x, _y in inside_places], rings, cc_of, tol, eps)
    inside_places = [(rec, p[0], p[1]) for (rec, _x, _y), p in zip(inside_places, snapped)]
    log(f'  places on land: {n_moved} moved ashore, {n_lost} with no land of their country nearby')
    place_shape = shape_of_points([x for _r, x, _y in inside_places], [y for _r, _x, y in inside_places], rings)        # the shape each place lies in (a district, a state, a country)
    for (rec, _x, _y), sid in zip(inside_places, place_shape):
        rec['shape'] = sid
    points = np.array([[x, y, rec['share']] for rec, x, y in inside_places]).reshape(-1, 3)
    km_per_cell = 111.2 / frame.deg / GRID               # a degree of latitude is 111.2 km
    roles_in = {}
    for rec, _x, _y in inside_places:
        if rec['shape'] in rings:
            roles_in[rec['shape']] = roles_in.get(rec['shape'], 0.0) + rec['share']
    res, method = annealed(rings, points, roles_in, frame.w, frame.h, km_per_cell, log=log)
    carto = res['map']
    res_m, method_m = annealed(rings, points, roles_in, frame.w, frame.h, km_per_cell, log=log, mix=MODERATE)
    carto_m = res_m['map']
    comp_in = []
    for comp in companies:                                    # (slug, (lat, lon)) or (slug, (lat, lon), ids, place key, meta)
        slug, (lat, lon) = comp[0], comp[1]
        ids, key, meta = (comp[2], comp[3], comp[4]) if len(comp) > 4 else (None, None, {'k': 'hq'})
        x, y = frame.xy([lon], [lat])[0]
        if 0 <= x <= frame.w and 0 <= y <= frame.h:
            comp_in.append((slug, x, y, ids, key, meta))
    if comp_in:
        ccs = [(k.split('|')[0] if k else (m.get('cc') or None)) for _s, _x, _y, _i, k, m in comp_in]
        snapped, n_moved, n_lost = land_snap([(x, y) for _s, x, y, _i, _k, _m in comp_in], ccs, rings, cc_of, tol, eps)
        comp_in = [(c[0], p[0], p[1]) + tuple(c[3:]) for c, p in zip(comp_in, snapped)]
        comp_cc = [cc_of.get(sid) for sid in shape_of_points([p[0] for p in snapped], [p[1] for p in snapped], rings)]       # the country each point lies in
        log(f'  companies on land: {n_moved} moved ashore, {n_lost} with no land nearby')
    else:
        comp_cc = []
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
    welded = weld_rings(rings, SIMPLIFY, OUT_STEP * cell, carto, carto_m)         # borders in common stay one line, before and after the warp
    for sid in rings:
        out_rings = []
        parts = welded.get(sid, [])
        big = max(range(len(parts)), key=lambda i: poly_area(parts[i][0]) if len(parts[i][0]) >= 3 else -1, default=-1)
        for i, (sm, d, c, m) in enumerate(parts):
            # a small ring goes, unless it is the shape's largest (a small state such as Bremen stays on a continent's map) or a hole
            # (the hole of an enclave: without it the state around it would cover the enclave)
            if len(sm) < 3 or (i != big and poly_area(sm) < RING_MIN * frame.w * frame.h and not _is_hole(sm, [q[0] for j, q in enumerate(parts) if j != i])):
                continue
            out_rings.append([[round(float(a), DEC), round(float(b), DEC), round(float(c_[0]), DEC), round(float(c_[1]), DEC),
                               round(float(m_[0]), DEC), round(float(m_[1]), DEC)]
                              for (a, b), c_, m_ in zip(d, c, m)])
        if out_rings:
            sh = names[sid]
            row = {'id': sid, 'name': sh['name'], 'kind': sh['kind'], 'roles': int(round(roles_in.get(sid, 0.0))), 'rings': out_rings}
            if sh.get('de'):
                row['de'] = sh['de']
            if sh.get('parent'):
                row['parent'] = sh['parent']
            out_shapes.append(row)
    out_places = []
    if inside_places:
        pos = carto.apply([[x, y] for _rec, x, y in inside_places])
        pos_m = carto_m.apply([[x, y] for _rec, x, y in inside_places])
        for (rec, x, y), (cx, cy), (mx, my) in zip(inside_places, pos, pos_m):
            out_places.append({'id': rec['key'], 'name': rec['name'], 'n': rec['n'], 'x': round(x, DEC), 'y': round(y, DEC),
                               'cx': round(float(cx), DEC), 'cy': round(float(cy), DEC), 'mx': round(float(mx), DEC), 'my': round(float(my), DEC)})
    out_rivers = river_rows(frame, rivers, carto, carto_m, log)
    out_companies = []
    if comp_in:
        pos = carto.apply([[x, y] for _s, x, y, _i, _k, _m in comp_in])
        pos_m = carto_m.apply([[x, y] for _s, x, y, _i, _k, _m in comp_in])
        for (slug, x, y, ids, key, meta), (cx, cy), (mx, my), cc in zip(comp_in, pos, pos_m, comp_cc):
            row = {'slug': slug, 'x': round(x, DEC), 'y': round(y, DEC), 'cx': round(float(cx), DEC), 'cy': round(float(cy), DEC),
                   'mx': round(float(mx), DEC), 'my': round(float(my), DEC)}
            if cc:
                row['cc'] = cc
            if ids is not None:
                row['ids'] = ids                                              # the roles this point stands for (a branch, or the headquarters beside branches)
            if key:
                row['b'] = key
            if meta.get('k') != 'hq':
                row.update({kk: vv for kk, vv in (('k', meta.get('k')), ('pn', meta.get('pn')), ('h', meta.get('h')), ('ls', meta.get('ls'))) if vv})
            out_companies.append(row)
    log(f'  {len(out_shapes)} shapes, {len(out_places)} places, {len(out_companies)} companies in the extent')
    return {'extent': [round(v, 4) for v in box], 'box': [round(v, 7) for v in frame.box], 'w': round(frame.w, 4), 'h': round(frame.h, 4), 'shapes': out_shapes,
            'places': out_places, 'companies': out_companies, 'rivers': out_rivers, 'error': round(res['error'], 4), 'method': method,
            'moderate': {'error': round(res_m['error'], 4), 'method': method_m, 'mix': MODERATE}}


def build(site, profile, vectors, companies=None, cache=None, log=print, history=None, verified=None):
    """Writes VECTORS/geo-map-<scope id>.json for each scope and the index VECTORS/geo-map.json for the board in SITE. Returns the index's path."""
    if not os.path.exists(os.path.join(site, 'jobs-index.json')):
        raise GeoMapError(f'no jobs-index.json in {site} (run jobcrawl build first)')
    cache = cache or os.path.join(vectors, '.geo-cache')
    shapes = geo_base.load(cache, ('DE',), log)
    index, desc = read_site(site)
    keys_of = {}
    table, unplaced, shape_share = role_places(index, desc, shapes, keys_of)
    log(f'roles: {len(index)}, placed {len(index) - unplaced}, not placed {unplaced} (remote or no place named); {len(table)} places')
    hq = dict(read_companies(companies)) if companies else {}
    hist, addrs = [], []
    if history and os.path.exists(history) and companies:
        by_id = {s['id']: s for s in shapes['countries'] + shapes['states']}
        state_id = {(s['cc'], s['name']): s['id'] for s in shapes['states']}
        country_id = {s['cc']: s['id'] for s in shapes['countries']}
        coords = geo.coords()
        slug_of = catalogue_names(companies)
        slug_of.update({co.lower(): sl for _r, _t, co, _u, sl in index if sl})
        acc, texts = {}, {}
        for co, loc, _first, last, _st in read_history(history):
            sl = slug_of.get(co.lower())
            if not sl or not loc:
                continue
            if loc not in texts:
                texts[loc] = place_of(loc.split(' | ')[0], by_id, state_id, country_id, coords)
            pl = texts[loc]
            if pl:
                a = acc.setdefault((sl, pl[0]), [pl[1], pl[2], 0, ''])
                a[2] += 1; a[3] = max(a[3], last)
        hist = [(sl, key, v[0], v[1], v[2], v[3]) for (sl, key), v in acc.items()]
        log(f'history: {len(hist)} (company, place) pairs from {len(texts)} location texts')
    if companies:
        addrs += catalogue_places(companies, geo.coords())
    if verified and os.path.exists(verified):
        with open(verified, encoding='utf-8') as fh:
            ver = json.load(fh)
        for key, v in ver.items():
            if v.get('status') in ('ok', 'filled') and v.get('found'):
                sl = key.split('#')[0]
                if '#b' in key:
                    addrs.append((sl, (v['found'][0], v['found'][1]), (v.get('addr') or {}).get('city') or 'branch address'))
                elif sl not in hq and v.get('status') == 'filled':
                    hq[sl] = (v['found'][0], v['found'][1])          # no coordinates on file: the checked address
    comp = company_points(index, keys_of, table, hq, history=hist, addresses=addrs)
    log(f'company points by kind: {dict(collections.Counter(c[4]["k"] for c in comp))}')
    log(f'company points: {len(comp)} for {len(hq)} companies with coordinates, {sum(1 for c in comp if c[3])} of them at branch locations, {len({c[0] for c in comp} - set(hq))} companies without coordinates located by their roles')
    scopes = profile['scopes'] if profile else DEFAULT_SCOPES
    os.makedirs(vectors, exist_ok=True)
    index = {'version': 2, 'projection': 'mercator', 'source': SOURCE, 'scopes': {}}
    for scope in scopes:
        sh = geo_base.load_scope(cache, scope, 'DE', log)                  # the outlines at this scope's level of detail (the world 1:10M, Europe 1:3M, Germany and Bavaria's districts 1:1M)
        box, kx = scope_box(scope, sh)
        rivers = geo_base.load_rivers(cache, geo_base.detail_of(scope) == 'europe', log)
        m = dict(scope_map(scope, box, kx, sh, table, comp, shape_roles=shape_share, log=log, rivers=rivers), id=scope['id'])
        name = scope_file(scope['id'])
        path_scope = os.path.join(vectors, name)
        with open(path_scope, 'w', encoding='utf-8') as fh:
            json.dump(m, fh, ensure_ascii=False, separators=(',', ':'))
        log(f'{name}: {os.path.getsize(path_scope) / 1e6:.2f} MB')
        index['scopes'][scope['id']] = {'file': name, 'box': m['box'], 'extent': m['extent'], 'w': m['w'], 'h': m['h'], 'error': m['error'],
                                        'method': m['method'], 'moderate': m['moderate'], 'rivers': len(m['rivers'])}
    path = os.path.join(vectors, FILE)
    with open(path, 'w', encoding='utf-8') as fh:
        json.dump(index, fh, ensure_ascii=False, separators=(',', ':'))
    total = os.path.getsize(path) + sum(os.path.getsize(os.path.join(vectors, v['file'])) for v in index['scopes'].values())
    log(f'geo-map: index of {len(scopes)} scopes, {os.path.getsize(path)} bytes; {total / 1e6:.2f} MB in all -> {path}')
    return path
