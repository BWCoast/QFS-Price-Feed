# QFS Token Price Feed

Real-time price tracker for the 6 QFS (Quantum Financial Systems) tokens on the XRP Ledger.

## Tokens Tracked

| Symbol | Name      | Issuer |
|--------|-----------|--------|
| RPR    | Reaper    | `r3qWgpz2ry3BhcRJ8JE6rxM8esrfhuKp4R` |
| ASC    | Ascendant | `r3qWgpz2ry3BhcRJ8JE6rxM8esrfhuKp4R` |
| ARK    | Ark       | `rf5Jzzy6oAFBJjLhokha1v8pXVgYYjee3b` |
| PLR    | Pillar    | `rNSYhWLhuHvmURwWbJPBKZMSPsyG5Qek17` |
| STX    | Staykx    | `rSTAYKxF2K77ZLZ8GoAwTqPGaphAqMyXV` |
| BOX    | Box       | `rhy4FUHtXrMZhbkBfeYvDv4nz6R7M4cu1t` |

## Features

- Live prices via OnTheDEX REST API + WebSocket
- XRP/USD conversion via CoinGecko
- Sparkline charts with 4H / 1D / 1W / 1M timeframe controls
- 15m / 1h / 24h trend percentages
- Light/dark mode (persists between visits)
- 4 animated refresh bar variants
- Scheduled Netlify function writes price snapshots to Supabase every 5 minutes

## File Structure

```
├── index.html                        # The price feed page (standalone, no build)
├── netlify.toml                      # Netlify config
├── package.json                      # Dependencies for the scheduled function
└── netlify/
    └── functions/
        └── collect-prices.mjs        # Scheduled function — fetches XRPL DEX prices → Supabase
```

## Deployment (Netlify)

1. Connect this repo to a Netlify site
2. Add these **environment variables** in Site settings → Environment variables:

| Variable           | Value                                          |
|--------------------|------------------------------------------------|
| `SUPABASE_URL`     | `https://wcnqphmvvjncjponpueo.supabase.co`    |
| `SUPABASE_ANON_KEY`| *(provided separately — do not commit to repo)*|

3. Deploy. The scheduled function runs automatically every 5 minutes.

## Supabase Table

Table name: `qfs_prices`

| Column     | Type        | Notes                  |
|------------|-------------|------------------------|
| id         | int8        | Auto-incrementing PK   |
| symbol     | text        | Token symbol (RPR, ASC, etc.) |
| price_xrp  | numeric     | Price in XRP           |
| price_usd  | numeric     | Price in USD (nullable)|
| fetched_at | timestamptz | Default: now()         |

RLS policies are enabled:
- **Public read access** — anyone can query prices
- **Anon insert access** — the Netlify function can write rows

## Data Sources

- **Live prices:** [OnTheDEX API](https://api.onthedex.live)
- **Historical snapshots:** Supabase (written by the scheduled function)
- **XRP/USD rate:** [CoinGecko API](https://api.coingecko.com)
- **DEX book prices:** XRPL WebSocket (`wss://xrplcluster.com`)
