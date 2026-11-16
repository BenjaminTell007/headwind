"""Small geometry helpers shared by the summary script and the server.

Kept separate so the server doesn't need pandas or numpy just for this.
"""


def segments_cross(p1, p2, a, b):
    """True if segment p1-p2 crosses segment a-b (lon/lat treated as flat, fine at gate scale)."""
    def orient(p, q, r):
        return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
    d1 = orient(a, b, p1)
    d2 = orient(a, b, p2)
    d3 = orient(p1, p2, a)
    d4 = orient(p1, p2, b)
    return (d1 * d2 < 0) and (d3 * d4 < 0)
