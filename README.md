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

### 🔄 Automatic Task Syncing
- Fetches today's tasks directly from the Overlayer API per wallet.
- Falls back to a local `task-list.txt` cache and scales amounts by 1.5× if no fresh tasks are found.

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
GLOBAL_AUTH_TOKEN=    # Optional master token for global task prefetch
GLOBAL_AUTH_ADDRESS=  # Address matching the master token
```

---

## 🚀 Running the Bot

```bash
npx ts-node index.ts
```

The bot will:
1. Check activity window (waits if outside 05:00–23:00 UTC).
2. Load and pin proxies to wallets (persistent across runs).
3. Find a working Sepolia RPC.
4. Launch 5 parallel workers with staggered startup.
5. Per wallet: authenticate → fetch own tasks → execute with persona timing → save progress.

---

## 💡 Maximizing Your Airdrop Score

To score highest and stay off Sybil watchlists:

| Do | Don't |
|---|---|
| ✅ Use residential/mobile proxies | ❌ Use datacenter IPs for all wallets |
| ✅ Run during daytime hours | ❌ Run at 3am UTC every day |
| ✅ Let each wallet keep its proxy | ❌ Rotate all proxies every run |
| ✅ Use the +10 TX safeguard | ❌ Hit the minimum TX count exactly |
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
