import { schedule } from "@netlify/functions";
import * as xrpl from "xrpl";

// ─── CONFIG ───────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
const COINGECKO_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=ripple&vs_currencies=usd";
const XRPL_WS = "wss://xrplcluster.com";

// QFS Tokens — 6 XRPL tokens
// All use standard 3-char currency codes (no hex encoding needed)
const TOKENS = [
  { symbol: "RPR", currency: "RPR", issuer: "r3qWgpz2ry3BhcRJ8JE6rxM8esrfhuKp4R" },
  { symbol: "ASC", currency: "ASC", issuer: "r3qWgpz2ry3BhcRJ8JE6rxM8esrfhuKp4R" },
  { symbol: "ARK", currency: "ARK", issuer: "rf5Jzzy6oAFBJjLhokha1v8pXVgYYjee3b" },
  { symbol: "PLR", currency: "PLR", issuer: "rNSYhWLhuHvmURwWbJPBKZMSPsyG5Qek17" },
  { symbol: "STX", currency: "STX", issuer: "rSTAYKxF2K77ZLZ8GoAwTqPGaphAqMyXV" },
  { symbol: "BOX", currency: "BOX", issuer: "rhy4FUHtXrMZhbkBfeYvDv4nz6R7M4cu1t" },
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

// ─── FETCH TOKEN PRICE FROM XRPL DEX ─────────
async function fetchTokenPrice(client, token) {
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
