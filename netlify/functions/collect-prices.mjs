import { schedule } from "@netlify/functions";
import * as xrpl from "xrpl";

// ─── CONFIG ───────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
const COINGECKO_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=ripple&vs_currencies=usd";
const XRPL_WS = "wss://xrplcluster.com";

// QFS ecosystem tokens. symbol = the ticker the income tracker uses (must match for alignment).
// currency may be a 3-char code or 40-char hex. issuers/codes verified on-chain.
const TOKENS = [
  // core 7
  { symbol: "RPR", currency: "RPR", issuer: "r3qWgpz2ry3BhcRJ8JE6rxM8esrfhuKp4R" },
  { symbol: "ASC", currency: "ASC", issuer: "r3qWgpz2ry3BhcRJ8JE6rxM8esrfhuKp4R" },
  { symbol: "ARK", currency: "ARK", issuer: "rf5Jzzy6oAFBJjLhokha1v8pXVgYYjee3b" },
  { symbol: "PLR", currency: "PLR", issuer: "rNSYhWLhuHvmURwWbJPBKZMSPsyG5Qek17" },
  { symbol: "STX", currency: "STX", issuer: "rSTAYKxF2K77ZLZ8GoAwTqPGaphAqMyXV" },
  { symbol: "BOX", currency: "BOX", issuer: "rhy4FUHtXrMZhbkBfeYvDv4nz6R7M4cu1t" },
  { symbol: "GRIM", currency: "4752494D00000000000000000000000000000000", issuer: "rHLRdLwXiBZSD53ZQz8ogGJz25LzNCCjSz" },
  // rain / marshal tokens
  { symbol: "xSTIK", currency: "785354494B000000000000000000000000000000", issuer: "rJNV9i4Q6zvRhpE2zjxgkvff3eGHQohZht" },
  { symbol: "Schmeckles", currency: "5363686D65636B6C657300000000000000000000", issuer: "rPxw83ZP6thv7KmG5DpAW4cDW55DZRZ9wu" },
  { symbol: "SHROOMIES", currency: "5348524F4F4D4945530000000000000000000000", issuer: "r4M4TzSypz2gRdS86hTM7oFcSs6yRmEPKZ" },
  { symbol: "Xoge", currency: "586F676500000000000000000000000000000000", issuer: "rJMtvf5B3GbuFMrqybh5wYVXEH4QE8VyU1" },
  { symbol: "XQK", currency: "XQK", issuer: "rHKrPGdpaqNRqRvmsiqQhD6azqc4npWoLC" },
  { symbol: "TRSRY", currency: "5452535259000000000000000000000000000000", issuer: "rLBnhMjV6ifEHYeV4gaS6jPKerZhQddFxW" },
  { symbol: "CORE", currency: "434F524500000000000000000000000000000000", issuer: "rcoreNywaoz2ZCQ8Lg2EbSLnGuRBmun6D" },
  { symbol: "SOLO", currency: "534F4C4F00000000000000000000000000000000", issuer: "rsoLo2S1kiGeCcn6hCUXVrCpGMWLrRrLZz" },
  // wrapped layer-1s
  { symbol: "BTC", currency: "BTC", issuer: "rchGBxcD1A1C2tdxF6papQYZ8kjRKMYcL" },
  { symbol: "ETH", currency: "ETH", issuer: "rcA8X3TVMST1n3CJeAdGk1RdRCHii7N2h" },
  { symbol: "LTC", currency: "LTC", issuer: "rcRzGWq6Ng3jeYhqnmM4zcWcUh69hrQ8V" },
  // bullion
  { symbol: "AAU", currency: "AAU", issuer: "rGho1zZBxtiiyQgMfReAju9Sc2MMtvtAAU" },
  { symbol: "AAG", currency: "AAG", issuer: "rGrvEW7rmaLb7zoVTeLXHmjU8vp8P5CAAG" },
  { symbol: "ACu", currency: "ACu", issuer: "rPFkJ1SH4a9M1HevXNkyc32WMQkMywDACu" },
];

const TABLE = "qfs_prices";

// ─── FETCH XRP/USD ────────────────────────────
async function fetchXrpUsd() {
  try {
    const r = await fetch(COINGECKO_URL);
    if (!r.ok) return null;
    const data = await r.json();
    return data?.ripple?.usd ?? null;
  } catch {
    return null;
  }
}

// ─── FETCH TOKEN PRICE (AMM pool first, DEX order book fallback) ─────────
// AMM pool price is steadier than top-of-book for thinly-traded tokens.
async function fetchTokenPrice(client, token) {
  // AMM: price in XRP = xrpReserve / tokenReserve
  try {
    const r = await client.request({
      command: "amm_info",
      asset: { currency: "XRP" },
      asset2: { currency: token.currency, issuer: token.issuer },
    });
    const amm = r.result?.amm;
    if (amm) {
      const a1 = amm.amount, a2 = amm.amount2;
      const xrpAmt = typeof a1 === "string" ? +a1 / 1e6 : +a2 / 1e6;
      const tokAmt = typeof a1 === "string" ? +a2?.value : +a1?.value;
      if (xrpAmt > 0 && tokAmt > 0) return xrpAmt / tokAmt;
    }
  } catch {
    /* no AMM pool — fall back to DEX book */
  }

  const tryBook = async (gets, pays) => {
    try {
      const r = await client.request({
        command: "book_offers",
        taker_gets: gets,
        taker_pays: pays,
        limit: 5,
      });
      return r.result?.offers ?? [];
    } catch {
      return [];
    }
  };

  // Side A: someone is selling XRP for the token
  // (pay XRP, receive token → gives us token price in XRP)
  const A = await tryBook(
    { currency: "XRP" },
    { currency: token.currency, issuer: token.issuer }
  );
  if (A.length) {
    const b = A[0];
    const xrpDrops =
      typeof b.TakerGets === "string"
        ? +b.TakerGets
        : (+b.TakerGets?.value ?? 0) * 1e6;
    const tokAmount =
      typeof b.TakerPays === "string"
        ? +b.TakerPays
        : +b.TakerPays?.value ?? 0;
    if (tokAmount > 0) return xrpDrops / 1e6 / tokAmount;
  }

  // Side B: someone is selling the token for XRP (flipped order book)
  const B = await tryBook(
    { currency: token.currency, issuer: token.issuer },
    { currency: "XRP" }
  );
  if (B.length) {
    const b = B[0];
    const tokAmount =
      typeof b.TakerGets === "string"
        ? +b.TakerGets
        : +b.TakerGets?.value ?? 0;
    const xrpDrops =
      typeof b.TakerPays === "string"
        ? +b.TakerPays
        : (+b.TakerPays?.value ?? 0) * 1e6;
    if (tokAmount > 0) return xrpDrops / 1e6 / tokAmount;
  }

  return null;
}

// ─── WRITE TO SUPABASE ────────────────────────
async function insertRows(rows) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${TABLE}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      Prefer: "return=minimal",
    },
    body: JSON.stringify(rows),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Supabase insert failed: ${r.status} — ${text}`);
  }
}

// ─── MAIN HANDLER ─────────────────────────────
// Runs every 5 minutes via Netlify scheduled function
export const handler = schedule("*/5 * * * *", async () => {
  console.log(`[qfs-prices] Starting run at ${new Date().toISOString()}`);

  // 1. Get XRP/USD rate
  const xrpUsd = await fetchXrpUsd();
  console.log(`[qfs-prices] XRP/USD: ${xrpUsd ?? "unavailable"}`);

  // 2. Connect to XRPL
  const client = new xrpl.Client(XRPL_WS);
  await client.connect();

  const rows = [];

  // 3. Fetch price for each token
  for (const token of TOKENS) {
    const priceXrp = await fetchTokenPrice(client, token);
    if (priceXrp === null) {
      console.warn(
        `[qfs-prices] No price found for ${token.symbol} — skipping`
      );
      continue;
    }
    const priceUsd = xrpUsd !== null ? priceXrp * xrpUsd : null;
    rows.push({
      symbol: token.symbol,
      price_xrp: priceXrp,
      price_usd: priceUsd,
    });
    console.log(
      `[qfs-prices] ${token.symbol}: ${priceXrp} XRP / ${priceUsd ?? "?"} USD`
    );
  }

  // 4. Disconnect XRPL
  await client.disconnect();

  // 5. Write to Supabase (only if we got at least one price)
  if (rows.length > 0) {
    await insertRows(rows);
    console.log(`[qfs-prices] Inserted ${rows.length} rows into Supabase`);
  } else {
    console.warn("[qfs-prices] No rows to insert — nothing written");
  }

  return { statusCode: 200 };
});
