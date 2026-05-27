import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { Wallet, JsonRpcProvider, FetchRequest } from 'ethers';
import { fetchDailyTasks, getPoints, requestOgMint, submitGdprConsent } from './api';
import { runWalletTasks } from './runner';
import { randomSleep, shuffleArray, formatProxyString } from './sybil';

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

    // Map wallets to preserve their proxy assignment before shuffling
    let walletConfigs = pks.map((pk, i) => ({
        pk: pk.startsWith('0x') ? pk : '0x' + pk,
        proxyStr: proxies[i] || proxies[i % proxies.length],
        nextPk: pks[(i + 1) % pks.length]
    }));

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
        } catch(ex: any) {
            console.log(`❌ Fallback parsing failed: ${ex.message}`);
        }
    }

    const tasks = globalTasks; // Use the globally fetched/scaled tasks for all wallets

    const progressFile = path.join(__dirname, 'progress.json');
    let progress: Record<string, Record<string, string[]>> = {};
    try {
        if (fs.existsSync(progressFile)) progress = JSON.parse(fs.readFileSync(progressFile, 'utf-8'));
    } catch(e) {}

    for (let i = 0; i < walletConfigs.length; i++) {
        const { pk, proxyStr, nextPk } = walletConfigs[i];
        const nextWalletAddr = new Wallet(nextPk.startsWith('0x') ? nextPk : '0x' + nextPk).address;
        const currentAddr = new Wallet(pk).address;

        if (!progress[currentAddr]) progress[currentAddr] = {};
        if (!progress[currentAddr][todayStr]) progress[currentAddr][todayStr] = [];

        const completedTaskIds = progress[currentAddr][todayStr];

        if (completedTaskIds.length >= tasks.length && tasks.length > 0) {
            console.log(`\n⏭️  [${currentAddr}] All ${tasks.length} tasks completed today (${todayStr}). Skipping!`);
            continue;
        }

        const formattedProxy = proxyStr ? formatProxyString(proxyStr) : undefined;

        // GDPR & OG NFT
        try {
            await submitGdprConsent(currentAddr, formattedProxy);
            const ts = Math.floor(Date.now()/1000) + 300;
            const message = `Request Overlayer OG mint\n${currentAddr.toLowerCase()}\n${ts}`;
            const signature = await new Wallet(pk).signMessage(message);
            await requestOgMint(currentAddr, signature, message, formattedProxy);
        } catch (e: any) {
            console.log(`[${currentAddr}] OG Mint / GDPR setup error: ${e.message}`);
        }

        // Run tasks
        const newlyCompleted = await runWalletTasks(
            pk, 
            proxyStr, 
            workingRpc, 
            nextWalletAddr, 
            tasks, 
            completedTaskIds, 
            proxies,
            (taskId: string) => {
                progress[currentAddr][todayStr].push(taskId);
                progress[currentAddr][todayStr] = Array.from(new Set(progress[currentAddr][todayStr]));
                try {
                    fs.writeFileSync(progressFile, JSON.stringify(progress, null, 2));
                } catch (err: any) {
                    console.error(`Failed to save progress.json: ${err.message}`);
                }
            }
        );

        // Fetch Points
        try {
            const pts = await getPoints(currentAddr, formattedProxy);
            console.log(`[${currentAddr}] Total Points: ${pts}`);
        } catch (e) {}

        if (i < walletConfigs.length - 1) {
            const sleepMs = Math.floor(Math.random() * 15000) + 10000;
            console.log(`Sleeping for ${sleepMs/1000}s before next wallet...`);
            await randomSleep(sleepMs, sleepMs);
        }
    }

    console.log('\n🎉 All wallets processed for today. You can close the bot.');
}

main().catch(console.error);
