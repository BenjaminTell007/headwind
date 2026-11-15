"""Reference model of the Markets.sol pricing math, in integers, rounding the same way.

The server and the page can use this to quote trades without a call to the chain,
and test_model() checks the invariants the contract relies on.

Units: 1 MON = 10**18 wei. One outcome share pays 1 wei of MON if it wins,
so 10**18 shares pay 1 MON.
"""

from math import isqrt

BPS = 10_000
WAD = 10**18


def ceil_div(a, b):
    return -(-a // b)


def ceil_sqrt(x):
    r = isqrt(x)
    return r if r * r == x else r + 1


class Market:
    def __init__(self, seed, prior_yes_bps, fee_bps):
        # Seed L MON mints L complete sets (L YES + L NO). Keep the reserves at the
        # ratio that makes price(YES) = prior, hand the extra shares to the creator.
        assert 100 <= prior_yes_bps <= 9_900
        if prior_yes_bps >= BPS // 2:
            self.no = seed
            self.yes = seed * (BPS - prior_yes_bps) // prior_yes_bps
            self.creator_yes, self.creator_no = seed - self.yes, 0
        else:
            self.yes = seed
            self.no = seed * prior_yes_bps // (BPS - prior_yes_bps)
            self.creator_yes, self.creator_no = 0, seed - self.no
        self.fee_bps = fee_bps
        self.lp_supply = seed
        self.fees = 0
        self.sets = seed  # complete sets outstanding = MON backing the shares

    def price_yes(self):
        return self.no * WAD // (self.yes + self.no)

    def buy(self, yes, amount):
        fee = amount * self.fee_bps // BPS
        x = amount - fee
        self.fees += fee
        self.sets += x
        k = self.yes * self.no
        if yes:
            n1 = self.no + x
            new_y = ceil_div(k, n1)
            out = self.yes + x - new_y
            self.yes, self.no = new_y, n1
        else:
            y1 = self.yes + x
            new_n = ceil_div(k, y1)
            out = self.no + x - new_n
            self.yes, self.no = y1, new_n
        assert self.yes * self.no >= k
        return out

    def sell(self, yes, shares):
        # Selling s of side A back: pool takes s, burns r complete sets, pays r MON.
        # (a + s - r)(b - r) = a*b  ->  r = (a + s + b - sqrt((a + s + b)^2 - 4 s b)) / 2
        a, b = (self.yes, self.no) if yes else (self.no, self.yes)
        k = a * b
        B = a + shares + b
        r = (B - ceil_sqrt(B * B - 4 * shares * b)) // 2
        a, b = a + shares - r, b - r
        assert a * b >= k and b > 0
        if yes:
            self.yes, self.no = a, b
        else:
            self.no, self.yes = a, b
        self.sets -= r
        fee = r * self.fee_bps // BPS
        self.fees += fee
        return r - fee

    def cost_for_shares(self, yes, shares):
        # Gross MON to buy exactly `shares` of a side (used to size a hedge).
        # (a + x - S)(b + x) = a*b  ->  x = (-(a + b - S) + sqrt((a + b - S)^2 + 4 b S)) / 2
        a, b = (self.yes, self.no) if yes else (self.no, self.yes)
        c = a + b - shares
        x = (-c + ceil_sqrt(c * c + 4 * b * shares) + 1) // 2  # round up
        return ceil_div(x * BPS, BPS - self.fee_bps)


def test_model():
    import random

    m = Market(seed=10 * WAD, prior_yes_bps=3_000, fee_bps=100)
    assert abs(m.price_yes() - 3 * WAD // 10) < 10**6, m.price_yes()

    # buying YES raises the price of YES, selling lowers it
    p0 = m.price_yes()
    got = m.buy(True, 1 * WAD)
    assert m.price_yes() > p0 and got > 1 * WAD  # at ~0.3 you get more than 1 share per MON
    p1 = m.price_yes()
    back = m.sell(True, got)
    assert m.price_yes() < p1
    assert back < 1 * WAD  # round trip loses the fees, never gains

    # cost_for_shares is the inverse of buy
    for target in (WAD // 2, 3 * WAD, 7 * WAD):
        mm = Market(seed=10 * WAD, prior_yes_bps=2_500, fee_bps=100)
        cost = mm.cost_for_shares(True, target)
        assert mm.buy(True, cost) >= target

    # random walk: the contract stays solvent and k never falls
    rng = random.Random(1)
    m = Market(seed=5 * WAD, prior_yes_bps=5_000, fee_bps=50)
    held = {True: m.creator_yes, False: m.creator_no}
    for _ in range(5_000):
        side = rng.random() < 0.5
        if rng.random() < 0.6 or held[side] == 0:
            held[side] += m.buy(side, rng.randint(1, 2 * WAD))
        else:
            held[side] -= (s := rng.randint(1, held[side]))
            m.sell(side, s)
        # every YES and NO share in existence is backed by one wei of a complete set
        assert held[True] + m.yes == m.sets == held[False] + m.no
        assert 0 < m.price_yes() < WAD
    print("model ok, final price", m.price_yes() / WAD)


if __name__ == "__main__":
    test_model()
