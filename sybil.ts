// ─────────────────────────────────────────────────────────────────────────────
// sybil.ts — Human-behaviour primitives for Sybil resistance
// Every function here is designed to make the bot indistinguishable from a
// real human user across timing, amounts, ordering, and network fingerprint.
// ─────────────────────────────────────────────────────────────────────────────

// ── Basic sleep (uniform random in range) ────────────────────────────────────
export function randomSleep(minMs: number, maxMs: number): Promise<void> {
    const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Gaussian (normal) random number — Box-Muller transform ───────────────────
// Produces numbers clustered around 0 with std deviation 1.
// More realistic than flat uniform — humans don't have flat reaction times.
function randomGaussian(): number {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

// ── Human-like sleep (Gaussian-distributed, clamped to [min, max]) ────────────
// Mean is midpoint of range; std deviation is ~18% of range for natural spread.
export function humanSleep(minMs: number, maxMs: number): Promise<void> {
    const mean = (minMs + maxMs) / 2;
    const std  = (maxMs - minMs) / 5.5; // ~5.5σ covers 99.99% of range
    const raw  = mean + randomGaussian() * std;
    const ms   = Math.round(Math.max(minMs, Math.min(maxMs, raw)));
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Amount jitter (add small positive variance to transaction amounts) ────────
export function randomJitterAmount(baseAmount: number, maxVariancePercent: number): string {
    const variance = baseAmount * (maxVariancePercent / 100);
    const jitter = Math.random() * variance;
    return (baseAmount + jitter).toFixed(3);
}

// ── Shuffle array (Fisher-Yates) ─────────────────────────────────────────────
export function shuffleArray<T>(array: T[]): T[] {
    const arr = [...array];
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

// ── Wallet Persona ────────────────────────────────────────────────────────────
// Each wallet gets a DETERMINISTIC personality derived from its address.
// Same wallet = same persona every run. Different wallets = different speed/style.
// This means behaviour is consistent per-wallet but varied across wallets —
// exactly what a real set of human users looks like.
export type WalletPersona = {
    name: 'cautious' | 'normal' | 'confident';
    minTaskDelay: number;  // ms between tasks
    maxTaskDelay: number;
    minActionDelay: number; // ms between on-chain actions
    maxActionDelay: number;
    txPauseChance: number;  // 0-1 probability of a random "human pause" mid-session
};

export function getWalletPersona(address: string): WalletPersona {
    // Sum the last 6 hex digits of the address as a simple deterministic hash
    const seed = parseInt(address.slice(-6), 16) % 3;
    const personas: WalletPersona[] = [
        // Cautious — methodical, slow, long breaks
        { name: 'cautious',  minTaskDelay: 8000,  maxTaskDelay: 25000, minActionDelay: 4000, maxActionDelay: 12000, txPauseChance: 0.3 },
        // Normal — average human pace
        { name: 'normal',    minTaskDelay: 4000,  maxTaskDelay: 14000, minActionDelay: 2000, maxActionDelay: 7000,  txPauseChance: 0.15 },
        // Confident — quick, decisive, fewer pauses
        { name: 'confident', minTaskDelay: 2000,  maxTaskDelay: 8000,  minActionDelay: 1500, maxActionDelay: 4000,  txPauseChance: 0.05 },
    ];
    return personas[seed];
}

// ── Activity window check ─────────────────────────────────────────────────────
// Returns true if current UTC hour is within a plausible human-activity window.
// Humans don't transact at 3am — bots do. This gates execution naturally.
export function isWithinActivityWindow(): boolean {
    const utcHour = new Date().getUTCHours();
    // Active window: 05:00–23:00 UTC (covers Asia/EU/US waking hours)
    return utcHour >= 5 && utcHour < 23;
}

// How many ms until the activity window opens (if currently outside)
export function msUntilActivityWindow(): number {
    const now = new Date();
    const utcHour = now.getUTCHours();
    if (utcHour >= 5 && utcHour < 23) return 0;
    // Calculate wait until 05:00 UTC
    const openHour = 5;
    const hoursUntilOpen = utcHour >= 23 ? (24 - utcHour + openHour) : (openHour - utcHour);
    return hoursUntilOpen * 3600 * 1000;
}

// ── Random micro-break injector ───────────────────────────────────────────────
// Based on persona's txPauseChance, occasionally inject a longer "human break"
// of 30–120 seconds — simulates user stepping away, reading, etc.
export async function maybeTakeMicroBreak(persona: WalletPersona, label: string): Promise<void> {
    if (Math.random() < persona.txPauseChance) {
        const breakMs = Math.floor(Math.random() * 90000) + 30000; // 30–120 sec
        console.log(`  [${label}] 💤 Taking a ${Math.round(breakMs / 1000)}s micro-break (human-like pause)...`);
        await humanSleep(breakMs, breakMs + 5000);
    }
}

// ── Extended user agent pool ─────────────────────────────────────────────────
// 15 real, current UAs covering Chrome/Firefox/Safari on Win/Mac/Linux/Mobile.
// A wider pool reduces the chance that multiple wallets share the same UA,
// making them look like distinct browser sessions.
const USER_AGENTS = [
    // Chrome Windows
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 11.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    // Chrome macOS
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    // Chrome Linux
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Ubuntu; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    // Firefox Windows
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
    // Firefox macOS
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.4; rv:125.0) Gecko/20100101 Firefox/125.0',
    // Firefox Linux
    'Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0',
    // Safari macOS
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
    // Chrome Android (mobile looks even more human)
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.6312.86 Mobile Safari/537.36',
];

export function getRandomUserAgent(): string {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// ── Proxy string formatter ────────────────────────────────────────────────────
export function formatProxyString(proxyStr: string): string {
    let uri = proxyStr.trim();
    if (uri.startsWith('http')) return uri;
    const parts = uri.split(':');
    if (parts.length === 4) return `http://${parts[2]}:${parts[3]}@${parts[0]}:${parts[1]}`;
    return `http://${uri}`;
}

