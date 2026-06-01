import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { Wallet, JsonRpcProvider, FetchRequest, parseUnits } from 'ethers';
import { fetchDailyTasks, fetchNonce, verifyAuth, getPoints, requestOgMint, submitGdprConsent } from './api';
import { runWalletTasks } from './runner';
import { randomSleep, humanSleep, shuffleArray, formatProxyString, getWalletPersona, isWithinActivityWindow, msUntilActivityWindow } from './sybil';

// Prevent proxy connection socket resets or drops from crashing the Node process
process.on('unhandledRejection', (reason) => {
    console.error('⚠️ Unhandled Promise Rejection (suppressed):', reason);
});

process.on('uncaughtException', (err) => {
    console.error('⚠️ Uncaught Exception (suppressed):', err.message || err);
});

const RPCS = [
    process.env.RPC ||
    "https://rpc.ankr.com/eth_sepolia",
    "https://sepolia.rpc.sentio.xyz",
    "https://rpc.sepolia.ethpandaops.io",
    "https://ethereum-sepolia-public.nodies.app",
    "https://eth-sepolia.api.onfinality.io/public",
    "https://sepolia.drpc.org",
    "https://1rpc.io/sepolia"
];

async function getWorkingRpc(): Promise<string> {
    console.log('Testing RPCs for a working connection...');
    for (const rpc of RPCS) {
        try {
            const fetchReq = new FetchRequest(rpc);
            fetchReq.timeout = 10000;
            const provider = new JsonRpcProvider(fetchReq, undefined, { staticNetwork: true });
            const block = await provider.getBlockNumber();
            console.log(`[RPC OK] ${rpc} (Block: ${block})`);
            return rpc;
        } catch (e) {
            console.log(`[RPC Failed] ${rpc}`);
        }
    }
    throw new Error("No working RPC found!");
}

async function checkGasPriceAndBlock(provider: JsonRpcProvider, maxGwei?: number) {
    if (!maxGwei) return;
    let logged = false;
    while (true) {
        try {
            const feeData = await provider.getFeeData();
            const gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas ?? parseUnits("10", "gwei");
            const gwei = Number(gasPrice) / 1e9;

            if (gwei <= maxGwei) {
                if (logged) {
                    console.log(`\n⛽ Gas price is back down to ${gwei.toFixed(2)} Gwei. Resuming...`);
                }
                break;
            }

            if (!logged) {
                console.log(`\n⛽ [GAS GATE] Current gas price is ${gwei.toFixed(2)} Gwei, which exceeds the limit of ${maxGwei} Gwei. Pausing execution...`);
                logged = true;
            } else {
                process.stdout.write(`.`); // silent dot indicator
            }

            // Sleep for 30 seconds before checking again
            await randomSleep(30000, 30000);
        } catch (e: any) {
            console.log(`\n⚠️ Failed to fetch gas price: ${e.message}. Retrying in 15s...`);
            await randomSleep(15000, 15000);
        }
    }
}

function parseFileLines(filename: string): string[] {
    const filePath = path.join(__dirname, filename);
    if (!fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, 'utf-8');
    return content.split('\n').map(l => l.trim()).filter(l => l.length > 0);
}

function getPreviousDayTasks(allTasks: any[], todayStr: string): any[] {
    const tasksNotToday = allTasks.filter(t => t.startDate && t.startDate !== todayStr);
    if (tasksNotToday.length === 0) return [];

    const dates = Array.from(new Set(tasksNotToday.map(t => t.startDate))).sort().reverse();
    const mostRecentDate = dates[0];
    console.log(`No tasks found for today (${todayStr}). Found previous day tasks from ${mostRecentDate}.`);

    const prevTasks = allTasks.filter(t => t.startDate === mostRecentDate);

    return prevTasks.map(t => {
        let newId = t.id;
        if (t.id.endsWith(mostRecentDate)) {
            newId = t.id.replace(mostRecentDate, todayStr);
        } else {
            newId = `${t.id}_${todayStr}`;
        }

        return {
            ...t,
            id: newId,
            startDate: todayStr,
            amount: Math.ceil((t.amount || 0) * 1.5),
            points: Math.ceil((t.points || 0) * 1.5)
        };
    });
}

function updateTaskListFile(fetchedTasks: any[]) {
    try {
        const taskListPath = path.join(__dirname, 'task-list.txt');
        let currentList: any = { success: true, tasks: [] };
        if (fs.existsSync(taskListPath)) {
            const raw = fs.readFileSync(taskListPath, 'utf-8');
            const firstBrace = raw.indexOf('{');
            const json = firstBrace !== -1 ? raw.slice(firstBrace) : raw;
            currentList = JSON.parse(json.trim());
        }
        if (!currentList.tasks) currentList.tasks = [];

        for (const t of fetchedTasks) {
            const idx = currentList.tasks.findIndex((ext: any) => ext.id === t.id);
            if (idx !== -1) {
                currentList.tasks[idx] = t;
            } else {
                currentList.tasks.push(t);
            }
        }
        currentList.timestamp = new Date().toISOString();
        fs.writeFileSync(taskListPath, JSON.stringify(currentList, null, 4));
        console.log(`Updated task-list.txt with ${fetchedTasks.length} tasks.`);
    } catch (e: any) {
        console.log(`Could not auto-update task-list.txt: ${e.message}`);
    }
}

async function main() {
    console.log('🚀 Starting Ultimate Overlayer Sybil-Proof Bot...');

    const pks = parseFileLines('pv.txt');
    const proxies = parseFileLines('proxy.txt');

    if (pks.length === 0) {
        console.error('❌ No private keys found in pv.txt! Exiting.');
        process.exit(1);
    }

    console.log(`Loaded ${pks.length} wallets and ${proxies.length} proxies.`);
    const workingRpc = await getWorkingRpc();

    // --- GAS PRICE CHECK & GATING ---
    const MAX_GWEI = process.env.MAX_GWEI ? parseFloat(process.env.MAX_GWEI) : undefined;
    const tempProvider = new JsonRpcProvider(workingRpc, undefined, { staticNetwork: true });
    try {
        const feeData = await tempProvider.getFeeData();
        const gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas ?? parseUnits("10", "gwei");
        const currentGwei = Number(gasPrice) / 1e9;
        if (MAX_GWEI !== undefined) {
            console.log(`⛽ Current Sepolia Gas: ${currentGwei.toFixed(2)} Gwei (Limit set to: ${MAX_GWEI} Gwei)`);
            await checkGasPriceAndBlock(tempProvider, MAX_GWEI);
        } else {
            console.log(`⛽ Current Sepolia Gas: ${currentGwei.toFixed(2)} Gwei (No limit set)`);
        }
    } catch (e: any) {
        console.log(`⚠️ Initial gas check failed: ${e.message}`);
    }

    // --- ACTIVITY WINDOW GATE ---
    // Only run during human-plausible hours (05:00–23:00 UTC).
    // If outside window, wait until it opens instead of running at 3am.
    if (!isWithinActivityWindow()) {
        const waitMs = msUntilActivityWindow();
        const waitMin = Math.round(waitMs / 60000);
        console.log(`\n🗓️  Outside activity window (05:00–23:00 UTC). Waiting ${waitMin} minutes until window opens...`);
        await randomSleep(waitMs, waitMs + 300_000); // add up to 5min jitter on wake
        console.log('Activity window open. Resuming...');
    }

    // --- PERSISTENT PROXY MAP (with weekly rotation support) ---
    // Each wallet is permanently pinned to ONE proxy, saved to disk.
    // When proxy.txt is updated (old proxies removed, new ones added), wallets
    // whose pinned proxy is no longer in the list are automatically reassigned.
    const progressDir = path.join(__dirname, 'progress');
    if (!fs.existsSync(progressDir)) { try { fs.mkdirSync(progressDir, { recursive: true }); } catch { } }
    const proxyMapFile = path.join(progressDir, 'proxy-map.json');
    let proxyMap: Record<string, string> = {};
    try {
        if (fs.existsSync(proxyMapFile)) proxyMap = JSON.parse(fs.readFileSync(proxyMapFile, 'utf-8'));
    } catch { }

    // Build a Set of currently active proxies for O(1) lookup
    const activeProxySet = new Set(proxies);

    let proxyMapUpdated = false;
    let reassignedCount = 0;
    let newlyPinnedCount = 0;
    let proxyAssignIndex = 0; // Round-robin cursor across the active proxy list

    let walletConfigs = pks.map((pk, i) => {
        const normPk = pk.startsWith('0x') ? pk : '0x' + pk;
        const addr = new Wallet(normPk).address.toLowerCase();

        const existingProxy = proxyMap[addr];
        const isStale = existingProxy && !activeProxySet.has(existingProxy);

        if (!existingProxy || isStale) {
            // New wallet OR pinned proxy was removed from proxy.txt — reassign
            if (proxies.length > 0) {
                proxyMap[addr] = proxies[proxyAssignIndex % proxies.length];
                proxyAssignIndex++;
            } else {
                proxyMap[addr] = '';
            }
            if (isStale) reassignedCount++;
            else newlyPinnedCount++;
            proxyMapUpdated = true;
        }

        return {
            pk: normPk,
            proxyStr: proxyMap[addr],
            nextPk: pks[(i + 1) % pks.length]
        };
    });

    if (proxyMapUpdated) {
        try { fs.writeFileSync(proxyMapFile, JSON.stringify(proxyMap, null, 2)); } catch { }
        if (reassignedCount > 0)
            console.log(`📌 Proxy rotation: ${reassignedCount} wallet(s) reassigned to new proxies, ${newlyPinnedCount} newly pinned. Saved.`);
        else
            console.log(`📌 Proxy map: ${newlyPinnedCount} new wallet(s) pinned and saved.`);
    } else {
        console.log(`📌 Proxy map OK — ${Object.keys(proxyMap).length} wallets pinned, 0 stale.`);
    }

    // Keep first 2 wallets in order, shuffle the rest (Sybil proofing)
    const firstTwo = walletConfigs.slice(0, 2);
    let theRest = walletConfigs.slice(2);
    console.log(`Keeping first ${firstTwo.length} wallets in order, shuffling the remaining ${theRest.length}...`);
    theRest = shuffleArray(theRest);

    walletConfigs = [...firstTwo, ...theRest];

    const GLOBAL_AUTH_TOKEN = process.env.GLOBAL_AUTH_TOKEN || '';
    const GLOBAL_AUTH_ADDRESS = process.env.GLOBAL_AUTH_ADDRESS || '';
    let globalTasks: any[] = [];
    const todayStr = new Date().toISOString().split('T')[0];

    if (GLOBAL_AUTH_TOKEN && GLOBAL_AUTH_ADDRESS) {
        console.log(`\nFetching tasks from API globally using master auth token...`);
        try {
            const globalProxy = walletConfigs[0]?.proxyStr ? formatProxyString(walletConfigs[0].proxyStr) : undefined;
            const fetchedTasks = await fetchDailyTasks(GLOBAL_AUTH_ADDRESS, GLOBAL_AUTH_TOKEN, globalProxy);
            console.log(`✅ Loaded ${fetchedTasks.length} tasks from API.`);
            if (fetchedTasks.length > 0) {
                updateTaskListFile(fetchedTasks);
                globalTasks = fetchedTasks;
            }
        } catch (e: any) {
            console.log(`❌ API failed, using fallback... (${e.message})`);
        }
    } else {
        console.log(`\n⚠️ GLOBAL_AUTH_TOKEN or GLOBAL_AUTH_ADDRESS is missing in .env. Falling back to local task list cache.`);
    }

    if (globalTasks.length === 0) {
        try {
            const rawContent = fs.readFileSync(path.join(__dirname, 'task-list.txt'), 'utf-8');
            const firstBrace = rawContent.indexOf('{');
            const jsonContent = firstBrace !== -1 ? rawContent.slice(firstBrace) : rawContent;
            const parsed = JSON.parse(jsonContent.trim());
            const allFallbackTasks = parsed.tasks || [];

            let todayFallbackTasks = allFallbackTasks.filter((t: any) => t.startDate === todayStr);
            if (todayFallbackTasks.length > 0) {
                console.log(`✅ Loaded ${todayFallbackTasks.length} tasks from fallback task-list.txt for today (${todayStr}).`);
                globalTasks = todayFallbackTasks;
            } else {
                const scaledTasks = getPreviousDayTasks(allFallbackTasks, todayStr);
                if (scaledTasks.length > 0) {
                    console.log(`⚠️ Scaling previous day's tasks by 1.5x (Loaded ${scaledTasks.length} tasks).`);
                    globalTasks = scaledTasks;
                } else {
                    console.log(`❌ No fallback tasks found at all in task-list.txt.`);
                }
            }
        } catch (ex: any) {
            console.log(`❌ Fallback parsing failed: ${ex.message}`);
        }
    }

    const tasks = globalTasks; // Use the globally fetched/scaled tasks for all wallets

    const runForWallet = async (walletConf: typeof walletConfigs[0], index: number) => {
        const { pk, proxyStr, nextPk } = walletConf;
        const nextWalletAddr = new Wallet(nextPk.startsWith('0x') ? nextPk : '0x' + nextPk).address;
        const currentAddr = new Wallet(pk).address;

        // Check gas price before running wallet tasks
        if (MAX_GWEI !== undefined) {
            const checkProvider = new JsonRpcProvider(workingRpc, undefined, { staticNetwork: true });
            await checkGasPriceAndBlock(checkProvider, MAX_GWEI);
        }

        const persona = getWalletPersona(currentAddr);
        console.log(`[${currentAddr.slice(0, 8)}] 🧠 Persona: ${persona.name}`);

        // progressDir is already created in main() scope above — reuse it
        const walletProgressFile = path.join(progressDir, `progress-${currentAddr.toLowerCase()}.json`);
        const sessionFile = path.join(progressDir, `session-${currentAddr.toLowerCase()}.json`);

        let completedTaskIds: string[] = [];
        try {
            if (fs.existsSync(walletProgressFile)) {
                const data = JSON.parse(fs.readFileSync(walletProgressFile, 'utf-8'));
                completedTaskIds = data[todayStr] || [];
            }
        } catch (e) { }
        // NOTE: early skip check removed — completion is re-checked below after
        // per-wallet tasks are resolved (walletTasks may differ from global tasks)

        const formattedProxy = proxyStr ? formatProxyString(proxyStr) : undefined;
        const signerWallet = new Wallet(pk);

        // --- PER-WALLET AUTH WITH JWT SESSION CACHE ---
        let walletTasks = tasks; // Default to globally fetched tasks as fallback
        let walletToken = '';
        try {
            // Try to load a saved session token first
            if (fs.existsSync(sessionFile)) {
                const session = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'));
                const expiry = new Date(session.expiresAt).getTime();
                // Use cached token if it has more than 1 hour left before expiry
                if (session.token && expiry - Date.now() > 3600_000) {
                    walletToken = session.token;
                    console.log(`[${currentAddr.slice(0, 8)}] 🔑 Reusing cached JWT (expires ${session.expiresAt.slice(0, 10)}).`);
                }
            }

            if (!walletToken) {
                // Fresh authentication
                console.log(`[${currentAddr.slice(0, 8)}] 🔐 Authenticating with Overlayer API...`);
                const nonce = await fetchNonce(currentAddr, formattedProxy);
                const ts = Math.floor(Date.now() / 1000) + 300;
                const authMessage = `Request Overlayer social session\n${currentAddr.toLowerCase()}\n${ts}\n${nonce}`;
                const authSignature = await signerWallet.signMessage(authMessage);
                const { token, expiresAt } = await verifyAuth(currentAddr, authMessage, authSignature, formattedProxy);
                walletToken = token;
                // Save JWT + expiry to disk for reuse next run
                try {
                    fs.writeFileSync(sessionFile, JSON.stringify({ token, expiresAt }, null, 2));
                } catch { }
                console.log(`[${currentAddr.slice(0, 8)}] ✅ Auth token obtained and cached.`);
            }

            // Fetch this wallet's own daily tasks using its pinned proxy
            const ownTasks = await fetchDailyTasks(currentAddr, walletToken, formattedProxy);
            if (ownTasks.length > 0) {
                walletTasks = ownTasks;
                console.log(`[${currentAddr.slice(0, 8)}] ✅ Loaded ${ownTasks.length} personal tasks.`);
                const apiCompletedIds = ownTasks.filter(t => t.completed).map(t => t.id);
                if (apiCompletedIds.length > 0) {
                    completedTaskIds = Array.from(new Set([...completedTaskIds, ...apiCompletedIds]));
                    console.log(`[${currentAddr.slice(0, 8)}] 📊 API reports ${apiCompletedIds.length} task(s) already completed.`);
                }
            } else {
                console.log(`[${currentAddr.slice(0, 8)}] ⚠️ No tasks returned. Using global task list.`);
            }
        } catch (authErr: any) {
            console.log(`[${currentAddr.slice(0, 8)}] ⚠️ Auth failed: ${authErr.message?.slice(0, 80)}. Falling back to global task list.`);
        }

        // Re-check completion using wallet-specific tasks
        if (completedTaskIds.length >= walletTasks.length && walletTasks.length > 0) {
            console.log(`\n⏭️  [${currentAddr.slice(0, 8)}] All ${walletTasks.length} tasks completed today (${todayStr}). Skipping!`);
            return;
        }

        // GDPR & OG NFT — send wallet token in Authorization header via proxy
        try {
            // Bug fix: submitGdprConsent now receives the wallet-specific token
            await submitGdprConsent(currentAddr, formattedProxy, walletToken);
            const ts = Math.floor(Date.now() / 1000) + 300;
            const message = `Request Overlayer OG mint\n${currentAddr.toLowerCase()}\n${ts}`;
            const signature = await new Wallet(pk).signMessage(message);
            await requestOgMint(currentAddr, signature, message, formattedProxy);
        } catch (e: any) {
            console.log(`[${currentAddr.slice(0, 8)}] OG Mint / GDPR setup error: ${e.message}`);
        }

        // Run tasks
        await runWalletTasks(
            pk,
            proxyStr,
            workingRpc,
            nextWalletAddr,
            walletTasks,
            completedTaskIds,
            proxies,
            (taskId: string) => {
                completedTaskIds.push(taskId);
                completedTaskIds = Array.from(new Set(completedTaskIds));
                try {
                    const data = { [todayStr]: completedTaskIds };
                    fs.writeFileSync(walletProgressFile, JSON.stringify(data, null, 2));
                } catch (err: any) {
                    console.error(`[${currentAddr.slice(0, 8)}] Failed to save progress: ${err.message}`);
                }
            }
        );

        // Fetch Points
        try {
            const pts = await getPoints(currentAddr, formattedProxy);
            console.log(`[${currentAddr.slice(0, 8)}] Total Points: ${pts}`);
        } catch (e) { }

        // Introduce a short stagger sleep between processed wallets in the pool
        const sleepMs = Math.floor(Math.random() * 5000) + 3000;
        console.log(`[${currentAddr.slice(0, 8)}] Staggering for ${sleepMs / 1000}s...`);
        await randomSleep(sleepMs, sleepMs);
    };

    // Custom Concurrency Pool Runner
    async function runPool(walletTasksList: (() => Promise<void>)[], concurrency: number) {
        const workers = Array(concurrency).fill(null).map(async (_, idx) => {
            // Stagger worker startup: use Gaussian delay based on slot position.
            // Jitter prevents thundering-herd on RPC and API at startup.
            if (idx > 0) {
                const baseStagger = idx * 3000;
                const jitter = Math.floor(Math.random() * 4000);
                await humanSleep(baseStagger, baseStagger + jitter);
            }
            while (walletTasksList.length > 0) {
                const walletTask = walletTasksList.shift();
                if (walletTask) {
                    await walletTask();
                }
            }
        });
        await Promise.all(workers);
    }

    const walletTasks = walletConfigs.map((walletConf, index) => {
        return () => runForWallet(walletConf, index);
    });

    console.log(`\n🚀 Starting concurrent processing of ${walletTasks.length} wallets with 5 parallel workers...`);
    await runPool(walletTasks, 5);

    // --- VERIFICATION & RETRY PHASE (IN THE END) ---
    console.log('\n⏳ Waiting 60 seconds for Overlayer transaction indexing to settle before final verification...');
    for (let count = 60; count > 0; count -= 10) {
        console.log(`   Verification starts in ${count}s...`);
        await randomSleep(10000, 10000);
    }

    console.log('\n🔍 Starting final verification phase with Overlayer API...');
    const retryWalletTasks = walletConfigs.map((walletConf) => {
        return async () => {
            const { pk, proxyStr } = walletConf;
            const currentAddr = new Wallet(pk).address;
            const formattedProxy = proxyStr ? formatProxyString(proxyStr) : undefined;
            const sessionFile = path.join(progressDir, `session-${currentAddr.toLowerCase()}.json`);
            const walletProgressFile = path.join(progressDir, `progress-${currentAddr.toLowerCase()}.json`);

            let walletToken = '';
            try {
                if (fs.existsSync(sessionFile)) {
                    const session = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'));
                    walletToken = session.token;
                }
            } catch { }

            if (!walletToken) {
                try {
                    const nonce = await fetchNonce(currentAddr, formattedProxy);
                    const ts = Math.floor(Date.now() / 1000) + 300;
                    const authMessage = `Request Overlayer social session\n${currentAddr.toLowerCase()}\n${ts}\n${nonce}`;
                    const authSignature = await new Wallet(pk).signMessage(authMessage);
                    const { token } = await verifyAuth(currentAddr, authMessage, authSignature, formattedProxy);
                    walletToken = token;
                } catch (e: any) {
                    console.log(`[${currentAddr.slice(0, 8)}] ❌ Verification auth failed: ${e.message?.slice(0, 80)}`);
                    return;
                }
            }

            try {
                const latestTasks = await fetchDailyTasks(currentAddr, walletToken, formattedProxy);
                const uncompleted = latestTasks.filter(t => t.active && !t.completed);

                if (uncompleted.length === 0) {
                    console.log(`[${currentAddr.slice(0, 8)}] ✅ All tasks successfully verified on Overlayer!`);
                    const verifiedIds = latestTasks.filter(t => t.completed).map(t => t.id);
                    fs.writeFileSync(walletProgressFile, JSON.stringify({ [todayStr]: verifiedIds }, null, 2));
                    return;
                }

                console.log(`[${currentAddr.slice(0, 8)}] ⚠️ Overlayer API reports ${uncompleted.length} task(s) still NOT verified. Retrying execution...`);
                for (const t of uncompleted) {
                    console.log(`  - Retrying task: ${t.title} (${t.type})`);
                }

                const nextWalletAddr = new Wallet(walletConf.nextPk.startsWith('0x') ? walletConf.nextPk : '0x' + walletConf.nextPk).address;

                await runWalletTasks(
                    pk,
                    proxyStr,
                    workingRpc,
                    nextWalletAddr,
                    uncompleted,
                    [],
                    proxies,
                    (taskId: string) => {
                        try {
                            let completedIds: string[] = [];
                            if (fs.existsSync(walletProgressFile)) {
                                const data = JSON.parse(fs.readFileSync(walletProgressFile, 'utf-8'));
                                completedIds = data[todayStr] || [];
                            }
                            completedIds.push(taskId);
                            completedIds = Array.from(new Set(completedIds));
                            fs.writeFileSync(walletProgressFile, JSON.stringify({ [todayStr]: completedIds }, null, 2));
                        } catch { }
                    }
                );

            } catch (err: any) {
                console.log(`[${currentAddr.slice(0, 8)}] ❌ Error verifying tasks: ${err.message?.slice(0, 80)}`);
            }
        };
    });

    console.log(`\n🔄 Running final cleanup & retry on ${retryWalletTasks.length} wallets...`);
    await runPool(retryWalletTasks, 5);

    console.log('\n🎉 Verification and retry completed. You can close the bot.');
}

main().catch(console.error);
