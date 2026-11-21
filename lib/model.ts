// Token launch radar: value model + farm-plan generator.
//
// The model is computed from the snapshot itself at run time. Nothing about
// any protocol is hardcoded: the category multiples come from the token
// bearing protocols in the same snapshot (median market-cap / TVL per
// category), and every factor below is a function of the protocol's own
// figures (TVL, 7-day change, age, chain count).
//
//   implied = TVL x categoryMultiple x growth x maturity x breadth
//
//   categoryMultiple  median(mcap_usd / tvl_usd) of the protocols in the
//                     same category that already have a token, falling back
//                     to the global median; clamped to [0.02, 2.5].
//   growth            1 + clamp(change_7d, -50, +150) / 250  -> [0.80, 1.60]
//                     (null change counts as 1.00: no signal, no penalty)
//   maturity          0.85 + 0.15 x min(ageDays, 1095) / 1095  -> [0.85, 1.00]
//                     (null listed_at counts as 0.92: unproven, not zero)
//   breadth           1 + 0.02 x min(chains, 12)              -> [1.02, 1.24]
//
// A protocol that already has a token never enters the board: the board is
// the pre-token radar. Token-bearing protocols are used only as comparables
// that calibrate the multiples, and the dashboard shows that table.

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export interface ModelFactors {
  multiple: number;
  growth_factor: number;
  maturity_factor: number;
  breadth_factor: number;
  base_value_usd: number;
}

export interface BoardRow {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  farm_steps: string[];
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number | null;
  listed_at: string | null;
  watchlist: boolean;
  status: "pre-token";
  model: ModelFactors;
}

export interface Comparable {
  slug: string;
  name: string;
  category: string | null;
  tvl_usd: number;
  mcap_usd: number;
  ratio: number;
}

export interface BoardMeta {
  as_of: string;
  floor_usd: number;
  protocols_total: number;
  pre_token_total: number;
  watchlist_total: number;
  excluded_total: number;
  rows: number;
  global_multiple: number;
  category_multiples: Record<string, number>;
  comparables: Comparable[];
  method: string;
}

const DAY_MS = 86_400_000;

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export function ageDays(listedAt: string | null, asOf: string): number | null {
  if (!listedAt) return null;
  const a = Date.parse(asOf + "T00:00:00Z");
  const b = Date.parse(listedAt + "T00:00:00Z");
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  const d = Math.round((a - b) / DAY_MS);
  return d < 0 ? 0 : d;
}

export function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Median mcap/TVL per category over token-bearing protocols, plus global. */
export function calibrateMultiples(protocols: SnapshotProtocol[]): {
  global: number;
  byCategory: Map<string, number>;
  comparables: Comparable[];
} {
  const ratios: number[] = [];
  const perCat = new Map<string, number[]>();
  const comparables: Comparable[] = [];
  for (const p of protocols) {
    if (p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    const r = clamp(p.mcap_usd / p.tvl_usd, 0.02, 2.5);
    ratios.push(r);
    if (p.category) {
      const arr = perCat.get(p.category) ?? [];
      arr.push(r);
      perCat.set(p.category, arr);
    }
    comparables.push({
      slug: p.slug,
      name: p.name,
      category: p.category,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      ratio: Math.round(r * 1000) / 1000,
    });
  }
  const global = ratios.length > 0 ? median(ratios) : 0.2;
  const byCategory = new Map<string, number>();
  for (const [cat, arr] of perCat) {
    byCategory.set(cat, arr.length >= 3 ? median(arr) : global);
  }
  comparables.sort((a, b) => b.tvl_usd - a.tvl_usd);
  return { global, byCategory, comparables: comparables.slice(0, 24) };
}

export function growthFactor(change7d: number | null): number {
  if (change7d === null || Number.isNaN(change7d)) return 1;
  return 1 + clamp(change7d, -50, 150) / 250;
}

export function maturityFactor(age: number | null): number {
  if (age === null) return 0.92;
  return 0.85 + (0.15 * Math.min(age, 1095)) / 1095;
}

export function breadthFactor(chains: string[]): number {
  return 1 + 0.02 * Math.min(chains.length, 12);
}

export function impliedValue(
  p: SnapshotProtocol,
  multiple: number,
  asOf: string,
): { value: number; factors: ModelFactors } {
  const age = ageDays(p.listed_at, asOf);
  const g = growthFactor(p.change_7d);
  const m = maturityFactor(age);
  const b = breadthFactor(p.chains);
  const base = p.tvl_usd * multiple;
  const value = Math.max(1, Math.round(base * g * m * b));
  return {
    value,
    factors: {
      multiple: Math.round(multiple * 1000) / 1000,
      growth_factor: Math.round(g * 1000) / 1000,
      maturity_factor: Math.round(m * 1000) / 1000,
      breadth_factor: Math.round(b * 1000) / 1000,
      base_value_usd: Math.round(base),
    },
  };
}

export function hasToken(p: SnapshotProtocol): boolean {
  return p.gecko_id !== null || p.symbol !== null;
}

// The snapshot's own watchlist rule, applied with the fields the snapshot
// carries: a wrapped, staked or bridged product of a token that already
// trades is not a protocol still waiting on a launch of its own, and
// neither is an exchange or a versioned copy of another protocol. The
// snapshot carries no parentProtocol, so the parent half of the rule is the
// watchlist itself; everything observable here is applied. Excluded
// protocols are counted in the meta, never silently dropped.
const EXCLUDED_CATEGORIES = new Set([
  "Bridge",
  "Canonical Bridge",
  "CEX",
  "Liquid Staking",
  "Liquid Restaking",
  "Restaked BTC",
]);
const EXCHANGE_PREFIXES = [
  "Binance",
  "Coinbase",
  "Bybit",
  "Kraken",
  "Bitget",
  "OKX",
  "Bitfinex",
  "Gemini",
];
const VERSION_SUFFIX = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

export function isLaunchCandidate(p: SnapshotProtocol): boolean {
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return false;
  if (VERSION_SUFFIX.test(p.name)) return false;
  if (WRAPPED_WORD.test(p.name)) return false;
  for (const ex of EXCHANGE_PREFIXES) {
    if (p.name.startsWith(ex)) return false;
  }
  return true;
}

/** Short human money: 1.24B / 342.5M / 12,400. */
export function fmtUsd(n: number): string {
  if (n >= 1e9) return "$" + trimNum(n / 1e9) + "B";
  if (n >= 1e6) return "$" + trimNum(n / 1e6) + "M";
  if (n >= 1e3) return "$" + trimNum(n / 1e3) + "K";
  return "$" + Math.round(n).toLocaleString("en-US");
}

function trimNum(n: number): string {
  const s = n.toFixed(2);
  return s.replace(/\.?0+$/, "");
}

/** Suggested position size for a farm plan, from the protocol's own TVL. */
function sizeBand(tvl: number): { test: string; main: string } {
  if (tvl >= 1e9) return { test: "$100–$250", main: "$1,000–$5,000" };
  if (tvl >= 250e6) return { test: "$50–$200", main: "$500–$2,000" };
  if (tvl >= 50e6) return { test: "$25–$100", main: "$250–$1,000" };
  return { test: "$10–$50", main: "$100–$500" };
}

interface CategoryPlay {
  act1: string;
  act2: string;
}

// Category-specific core actions. Anything not listed falls back to the
// generic play: the generator never fails on an unseen category.
const PLAYS: Record<string, CategoryPlay> = {
  Dexs: {
    act1: "swap a small amount on the DEX and add it as liquidity to its largest pool",
    act2: "route a second swap through a different pool or pair to touch more of the router",
  },
  Lending: {
    act1: "supply collateral and open a small borrow against it, then repay half",
    act2: "supply a second asset so the account holds more than one collateral type",
  },
  Yield: {
    act1: "deposit into the highest-TVL vault and let one full harvest cycle complete",
    act2: "deposit into a second vault with a different strategy or asset",
  },
  "Risk Curators": {
    act1: "allocate to the curator's largest vault and check the vault's risk report",
    act2: "allocate a smaller amount to a second vault run by the same curator",
  },
  "Onchain Capital Allocator": {
    act1: "deposit into the allocator's flagship vault and read its allocation breakdown",
    act2: "deposit into a second vault with a different allocation mandate",
  },
  RWA: {
    act1: "buy the smallest available position in the flagship real-world asset vault",
    act2: "hold the position through one yield distribution and record the payout",
  },
  "Collateral Markets": {
    act1: "post collateral and mint against it at a conservative ratio, then unwind half",
    act2: "open a second collateral position with a different asset",
  },
  CDP: {
    act1: "open a collateralised debt position at a conservative ratio and mint a small amount",
    act2: "adjust the position once: add collateral or repay part of the debt",
  },
  Payments: {
    act1: "send a small payment through the network and confirm it settles end to end",
    act2: "receive a payment back through the same route to complete a round trip",
  },
  "Liquid Staking": {
    act1: "stake a small amount and hold the liquid staking token through one reward cycle",
    act2: "use the staking token once in a supported DeFi pool",
  },
  "Liquid Restaking": {
    act1: "restake a small amount and confirm the position accrues restaking rewards",
    act2: "move the restaked position to a second operator or vault",
  },
  Bridge: {
    act1: "bridge a small amount across the bridge and confirm it arrives on the other chain",
    act2: "bridge back half of it to complete a round trip through the bridge",
  },
  Derivatives: {
    act1: "open a small perpetual or options position and close it after one session",
    act2: "open a second small position on a different market the protocol lists",
  },
  "Prediction Market": {
    act1: "place a small prediction on an active market and hold it to settlement",
    act2: "place a second small prediction on a different market",
  },
  "NFT Marketplace": {
    act1: "list or buy a low-priced item and confirm the trade settles",
    act2: "make a second trade in a different collection on the same marketplace",
  },
  Gaming: {
    act1: "play one full session and complete the onboarding quest or first mission",
    act2: "play a second session on a different day to show returning activity",
  },
  "Algo-Stables": {
    act1: "mint a small amount of the stable asset against collateral and hold it a week",
    act2: "provide the stable asset as liquidity in its main pool",
  },
  "Privacy": {
    act1: "run one private transaction end to end and confirm it settles",
    act2: "run a second private transaction on a different day",
  },
  "Reserve Currency": {
    act1: "bond or stake a small amount and hold it through one full epoch",
    act2: "claim the rewards once and restake them",
  },
  "Cross Chain": {
    act1: "move a small amount across chains through the protocol and confirm arrival",
    act2: "repeat the cross-chain move on a second route the protocol supports",
  },
};

const GENERIC_PLAY: CategoryPlay = {
  act1: "use the protocol's main feature once with a small amount and confirm the transaction settles",
  act2: "use a second feature of the protocol so the account touches more than one part of it",
};

function playFor(category: string | null): CategoryPlay {
  if (category && PLAYS[category]) return PLAYS[category];
  return GENERIC_PLAY;
}

/**
 * Six concrete farm steps for one protocol. Every step carries what it
 * costs and how long it takes, and names the protocol's own chain and size.
 * Steps stay within 20-600 characters by construction (templates are short
 * and slots are bounded); main.ts re-checks every step before writing.
 */
export function farmSteps(p: SnapshotProtocol, asOf: string): string[] {
  const chain = p.chains[0] ?? "its main chain";
  const otherChain = p.chains[1];
  const size = sizeBand(p.tvl_usd);
  const play = playFor(p.category);
  const age = ageDays(p.listed_at, asOf);
  const ageNote =
    age === null
      ? "no listing date is published"
      : "tracked since " + (p.listed_at ?? "an unknown date");
  const growthNote =
    p.change_7d === null
      ? "no 7-day change is reported"
      : "TVL moved " +
        (p.change_7d >= 0 ? "+" : "") +
        p.change_7d.toFixed(1) +
        "% in 7 days";
  const steps: string[] = [
    "Verify first: open " +
      p.name +
      "'s official site and docs (30 minutes, $0) and confirm it still records no token, " +
      "that " +
      ageNote +
      ", and that " +
      growthNote +
      " — never farm from a lookalike link.",
    "Fund the run: bridge " +
      size.test +
      " of USDC to " +
      chain +
      " through the official bridge (gas about $2–$8, 10–20 minutes) and keep a little native gas aside for later steps.",
    "Do the core action: " +
      play.act1 +
      " with " +
      size.test +
      " (about 15–30 minutes including confirmations), then save the transaction hash and a screenshot of the position.",
    "Go deeper: " +
      play.act2 +
      " with " +
      size.main +
      " only after the first position settles (about 20–40 minutes); a second distinct action counts more than repeating the first.",
    otherChain
      ? "Spread chains: repeat the core action once on " +
        otherChain +
        " with " +
        size.test +
        " (about 15–30 minutes) so the account shows activity on two of the " +
        p.chains.length +
        " chains this protocol runs on."
      : "Stay consistent: repeat the core action once more after 7 days with " +
        size.test +
        " (about 15 minutes) so the account shows returning activity instead of a single-day burst.",
    "Track and stay ready: once a week for 10 minutes, record new transactions in a note, watch the protocol's official announcements for a token or points update, and keep the position funded so a snapshot or claim never catches it empty.",
  ];
  return steps;
}

/** Build the full board: every pre-token launch candidate, ranked by implied value. */
export function buildBoard(snapshot: Snapshot): { rows: BoardRow[]; meta: BoardMeta } {
  const watch = new Set(snapshot.watchlist);
  const { global, byCategory, comparables } = calibrateMultiples(snapshot.protocols);
  const rows: BoardRow[] = [];
  let excluded = 0;
  for (const p of snapshot.protocols) {
    if (hasToken(p)) continue;
    if (!isLaunchCandidate(p)) {
      excluded++;
      continue;
    }
    const multiple = p.category && byCategory.has(p.category)
      ? (byCategory.get(p.category) as number)
      : global;
    const { value, factors } = impliedValue(p, multiple, snapshot.as_of);
    rows.push({
      slug: p.slug,
      name: p.name,
      rank: 0,
      implied_value_usd: value,
      farm_steps: farmSteps(p, snapshot.as_of),
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      age_days: ageDays(p.listed_at, snapshot.as_of),
      listed_at: p.listed_at,
      watchlist: watch.has(p.slug),
      status: "pre-token",
      model: factors,
    });
  }
  rows.sort(
    (a, b) =>
      b.implied_value_usd - a.implied_value_usd ||
      b.tvl_usd - a.tvl_usd ||
      (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0),
  );
  rows.forEach((r, i) => {
    r.rank = i + 1;
  });
  const catMult: Record<string, number> = {};
  for (const [k, v] of [...byCategory.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    catMult[k] = Math.round(v * 1000) / 1000;
  }
  const meta: BoardMeta = {
    as_of: snapshot.as_of,
    floor_usd: snapshot.floor_usd,
    protocols_total: snapshot.protocols.length,
    pre_token_total: rows.length + excluded,
    watchlist_total: snapshot.watchlist.length,
    excluded_total: excluded,
    rows: rows.length,
    global_multiple: Math.round(global * 1000) / 1000,
    category_multiples: catMult,
    comparables,
    method:
      "implied = TVL x category multiple (median mcap/TVL of token-bearing protocols in the same category, " +
      "global median " +
      Math.round(global * 1000) / 1000 +
      "x as fallback) x growth (7d change) x maturity (age) x breadth (chain count). " +
      "Board holds pre-token launch candidates only: wrapped, staked and bridged products, exchanges and " +
      "versioned copies are not launch candidates (the snapshot's own watchlist rule) and are excluded, " +
      excluded +
      " of them; token-bearing protocols calibrate the multiples.",
  };
  return { rows, meta };
}
