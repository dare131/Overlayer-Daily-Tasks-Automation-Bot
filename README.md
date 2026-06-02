# Overlayer Daily Tasks Automation Bot

> [!IMPORTANT]
> **Educational & Research Purpose Only**: This repository is created strictly for **educational, academic, and research purposes**. It is designed as a proof-of-concept to study Web3 automated interactions, programmatic transaction flows, and decentralized network behaviors on the Sepolia testnet. It is not intended for commercial use or any activity that violates third-party terms of service. The authors are not responsible for any misuse, account bans, or restrictions. Use of this codebase is entirely at your own risk.

A production-grade, **Sybil-proof** automation bot for the **Overlayer** protocol on the Ethereum Sepolia testnet. Automates daily tasks—Mint, Stake, Send, Receive, Bridge—for multiple wallets with per-wallet authentication, human-behavior simulation, pinned proxy identities, and crash-resilient progress tracking.

---

## ✨ Key Features

### 🔐 Per-Wallet Authentication
- Each wallet independently authenticates with the Overlayer API via a **nonce → sign → verify** flow.
- Fetches its **own JWT token** and caches it to `progress/session-{address}.json`.
- Tokens are reused across runs until they expire (7-day lifespan), reducing API load.
- Falls back gracefully to global task list if auth fails.

### 🧠 Human-Behaviour Simulation (Anti-Bot Detection)
Every wallet is assigned a **deterministic personality (Persona)** derived from its address:

| Persona | Task Delay | Pause Chance | Style |
|---|---|---|---|
| `cautious` | 8–25s | 30% | Slow, methodical, frequent breaks |
| `normal` | 4–14s | 15% | Average human pace |
| `confident` | 2–8s | 5% | Fast, decisive, fewer pauses |

Additional human-behaviour layers:
- **Gaussian (non-uniform) timing** — delays cluster around a mean like real humans, not flat random.
- **Random micro-breaks** — wallets randomly "step away" for 30–120 seconds between tasks.
- **Activity window gating** — bot only runs between **05:00–23:00 UTC**. If started at 3am, it waits. Bots that run at 3am look like bots.
- **Wallet order shuffling** — first two wallets are processed first; remaining wallets are randomly shuffled each run.

### 📌 Persistent Proxy Identity (Sybil Proof)
- Each wallet is **permanently locked to one proxy IP** in `progress/proxy-map.json`.
- Same wallet → same IP every run → consistent identity across sessions.
- When `proxy.txt` is updated weekly, **stale assignments are auto-reassigned** to new proxies while valid ones are preserved.

### 🔄 Sliding-Window Verification Queue (Anti-Sybil Delay)
- **Initial Sync**: Fetches today's tasks directly from the Overlayer API per wallet, automatically syncing any tasks already completed on the platform to avoid redundant transactions.
- **Persistent Temp Queue**: Completed wallets are queued in a local gitignored file (`progress/verification-queue.json`). To prevent write conflicts and race conditions across parallel workers, the bot uses a global in-memory state mirror synchronized with atomic disk writes.
- **10-Minute Indexing Delay**: To allow Overlayer's database indexer plenty of time to process on-chain blocks, the bot enforces a strict 10-minute wait before verifying tasks.
- **Sliding Window Processing**: Verification is checked asynchronously: as new wallets finish, the bot checks the queue and verifies any wallets that have reached the 10-minute age mark.
- **Final Drain**: At the end of the run, the bot drains the queue, waiting for the remaining wallets to hit their 10-minute mark, retrying any uncompleted tasks, and deleting the temporary queue file when all tasks are successfully verified.
- **Fallback scaling**: Falls back to a local `task-list.txt` cache and scales amounts by 1.5× if no fresh tasks are found on the API.

### ⛽ Gwei-Aware Gas Gating
- **Live Gwei Tracking**: Fetches and displays current network gas fee (Gwei) on startup.
- **Gas Limit Gate**: Supports a user-defined `MAX_GWEI` limit configuration.
- **Auto-Pause & Resume**: If Sepolia network gas price spikes above the limit, workers automatically pause and poll every 30 seconds, resuming only when the fees drop to protect your testnet ETH balance.

### 💰 Automatic Token Top-up
- **Deficit Checks**: Automatically inspects `C+` and `T+` token balances for each wallet on startup.
- **Faucet Collateralization**: If a wallet has less than 5,000 C+ or T+ tokens, the bot automatically mints required collateral from the faucet and executes top-ups to restore a safe 5,000+ token balance.

### 🛡️ Advanced Sybil Protections
- Outgoing sends use **random burn addresses** to break on-chain transfer graphs.
- Receive tasks route through **ephemeral burner wallets** — no self-transfers, no wallet linkage.
- **15 rotating user agents** covering Chrome/Firefox/Safari on Windows, macOS, Linux, and Android.
- **5-thread parallel worker pool** with Gaussian-jittered startup staggering.

### 🔁 Resilience & Recovery
- Per-wallet progress saved in real-time to `progress/progress-{address}.json`.
- Automatic proxy rotation on network/timeout errors (up to 15 retries per action).
- Global `unhandledRejection` and `uncaughtException` guards prevent single-wallet failures from crashing the entire run.

---

## 📁 Folder Structure

```
.
├── api.ts                    # Overlayer REST API: auth, nonce, tasks, GDPR
├── constants.ts              # Contract ABIs and Sepolia addresses
├── index.ts                  # Main coordinator, proxy map, worker pool
├── runner.ts                 # Per-wallet execution pipeline with persona
├── sybil.ts                  # Human-behaviour primitives (persona, timing, UA)
├── pv.txt                    # Private keys (one per line, gitignored)
├── proxy.txt                 # Proxies (one per line, gitignored)
├── task-list.txt             # Daily task fallback cache
└── progress/
    ├── proxy-map.json        # Persistent wallet→proxy pin (gitignored)
    ├── session-{addr}.json   # Per-wallet JWT cache (gitignored)
    └── progress-{addr}.json  # Per-wallet task completion log (gitignored)
```

---

## ⚙️ Setup & Installation

### 1. Prerequisites
[Node.js](https://nodejs.org/) v20+ required.

### 2. Install Dependencies
```bash
npm install
```

### 3. Configuration

**`pv.txt`** — One private key per line:
```
0xabc123...
0xdef456...
```

**`proxy.txt`** — One proxy per line (`ip:port:user:pass` or `ip:port`):
```
104.207.36.21:3129:user:pass
216.26.248.17:3129
```

> Update `proxy.txt` weekly with fresh proxies. The bot automatically detects stale proxy assignments and reassigns wallets to new proxies on startup — no manual config needed.

**`.env`** (optional — copy from `.env.example`):
```env
RPC=https://eth-sepolia.g.alchemy.com/v2/YOUR_KEY
MAX_GWEI=20           # Optional max gas limit in Gwei. Blocks execution when Sepolia gas is high.
```

---

## 🚀 Running the Bot

```bash
npx ts-node index.ts
```

The bot will:
1. Find a working Sepolia RPC and display/check the current Gas fee in Gwei against `MAX_GWEI`.
2. Check activity window (waits if outside 05:00–23:00 UTC).
3. Load and pin proxies to wallets (persistent across runs).
4. **Master Task Sync**: Authenticate using the first wallet in `pv.txt` as the master wallet, fetch today's tasks from the API, and cache them locally (in `task-list.txt` and `progress/session-{address}.json`). If the API is unreachable, it automatically falls back to cached tasks or scales the previous day's tasks by 1.5x.
5. Launch 5 parallel workers with staggered startup.
6. Per wallet: check gas → authenticate (reusing cached JWT session if valid to prevent double login) → fetch tasks → execute on-chain transactions with persona timing → save progress → add to 10-minute verification queue.
7. **Asynchronous Check**: Workers check the queue after processing each wallet, verifying those that have reached the 10-minute age mark.
8. **Final Drain**: After the worker pool finishes, the bot waits for the remaining wallets in the queue to reach 10 minutes, verifies them, and deletes the temporary queue file.

---

## 💡 Maximizing Your Airdrop Score

To score highest and stay off Sybil watchlists:

| Do | Don't |
|---|---|
| ✅ Use residential/mobile proxies | ❌ Use datacenter IPs for all wallets |
| ✅ Run during daytime hours | ❌ Run at 3am UTC every day |
| ✅ Let each wallet keep its proxy | ❌ Rotate all proxies every run |
| ✅ Use the +6-15 random TX safeguard | ❌ Hit the minimum TX count exactly |
| ✅ Fund wallets with some ETH history | ❌ Use brand-new empty wallets only |

---

## 💸 Support & Tips

If this bot has helped you, feel free to support further development!

<a href="https://nowpayments.io/donation?api_key=c0df45b8-76ae-42f2-b09e-861973bd4794" target="_blank" rel="noreferrer noopener">
    <img src="https://nowpayments.io/images/embeds/donation-button-black.svg" alt="Crypto donation button by NOWPayments">
</a>

Direct Link: [Donate via NOWPayments](https://nowpayments.io/donation/ravi)

*(Note: GitHub sanitizes raw iframe widgets for security reasons, so please use the button or direct link above)*

---

## 🔒 Safety & Security

- **Never commit `pv.txt` or `proxy.txt`** — both are gitignored by default.
- The `progress/` directory (JWT tokens, proxy map, progress files) is also gitignored.
- This codebase targets the **Sepolia testnet only**. No real funds at risk.
- Rotate private keys and proxies regularly for operational security.

---

## 📄 Educational License & Terms of Use

This software is provided "as is", without warranty of any kind, express or implied, including but not limited to the warranties of merchantability, fitness for a particular purpose, and non-infringement. In no event shall the authors or copyright holders be liable for any claim, damages, or other liability, whether in an action of contract, tort or otherwise, arising from, out of, or in connection with the software or the use or other dealings in the software.

**MIT License** — See [LICENSE](./LICENSE) for full terms.
