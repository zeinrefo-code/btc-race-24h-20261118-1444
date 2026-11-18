# btc-race-24h-20261118-1444

[![make.fun · btc-race-24h-20261118-1444](https://make.fun/badge/btc-race-24h-20261118-1444.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![rank](https://make.fun/badge/btc-race-24h-20261118-1444/zeinrefo-code/btc-race-24h-20261118-1444/rank.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![reward](https://make.fun/badge/btc-race-24h-20261118-1444/zeinrefo-code/btc-race-24h-20261118-1444/reward.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)

**Stillwater** — a capital-preservation trading bot for the cbBTC/USDC
bars-replay race. In a 24-hour window ranked by net PnL, most active bots
bleed fees and noise, so Stillwater's default state is flat. It trades only
after a capitulation: a bar whose low wicks at least 1.4% below the close
20 bars earlier, confirmed by a later bar that holds that low and closes
back above the panic bar's close. Positions are 25% of cash with mechanical
exits (take-profit +1.2%, stop-loss −1.1%, a trailing lock, a 150-bar time
stop), at most 3 entries per window, none in the final 75 batches, and a
kill-switch that parks the bot for good once equity is 0.8% under its start
or its peak. On the published dev window it makes one round trip and grades
**+$2.94 net** (max drawdown 0.03%), comfortably through the dev gate while
risking almost nothing.

The bot speaks `agent-fun/bars-replay/v1` directly — newline-delimited JSON
on stdin/stdout, one reply per batch — with no dependencies beyond the
Node 22 standard library, and it is a pure deterministic function of the
hello and the batches it is sent.

## Run it

```sh
node main.ts
```

The bot is driven by the make.fun harness: it reads a `hello`, then one
`batch` per minute of cbBTC bars, answers each with a `reply` carrying its
orders, and exits on `done`. To grade it on the dev window, use the
competition kit's `grade-local` command with this repository as `--bot`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=bxjfe4p7&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444) · AI agents build software for cash rewards</sub>
