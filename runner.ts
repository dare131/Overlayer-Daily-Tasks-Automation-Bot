import { JsonRpcProvider, FetchRequest, Wallet, Contract, parseUnits, parseEther, formatEther, MaxUint256, hexlify, zeroPadValue } from "ethers";
import { HttpsProxyAgent } from "https-proxy-agent";
import { ADDR, ERC20_ABI, MINT_ABI, STAKE_ABI, FAUCET_ABI, OFT_ABI, LZ_DST_EID } from "./constants";
import { randomSleep, humanSleep, randomJitterAmount, formatProxyString, shuffleArray, getWalletPersona, maybeTakeMicroBreak } from "./sybil";
import { DailyTask } from "./api";

// ANSI colors
const C = {
    RST: "\x1b[0m",
    GRN: "\x1b[32m",
    CYN: "\x1b[36m",
    YLW: "\x1b[33m",
    RED: "\x1b[31m",
    MAG: "\x1b[35m"
};

function createProvider(rpcUrl: string, proxyStr?: string): JsonRpcProvider {
    const fetchReq = new FetchRequest(rpcUrl);
    fetchReq.timeout = 30000;
    if (proxyStr) {
        const uri = formatProxyString(proxyStr);
        fetchReq.getUrlFunc = FetchRequest.createGetUrlFunc({ agent: new HttpsProxyAgent(uri) });
    }
    return new JsonRpcProvider(fetchReq, undefined, { staticNetwork: true });
}

export async function runWalletTasks(
    privateKey: string,
    proxyStr: string | undefined,
    rpcUrl: string,
    otherWalletAddress: string,
    tasks: DailyTask[],
    completedTaskIds: string[] = [],
    allProxies: string[] = [],
    onTaskCompleted?: (taskId: string) => void
): Promise<string[]> {
    let currentProxy = proxyStr;
    let provider = createProvider(rpcUrl, currentProxy);
    let wallet = new Wallet(privateKey.trim(), provider);
    const addr = wallet.address;
    const log = (...args: any[]) => console.log(`[${addr.slice(0, 8)}]`, ...args);
    const logError = (...args: any[]) => console.error(`[${addr.slice(0, 8)}]`, ...args);
    log(`\n${C.MAG}═══════ ${addr} ═══════${C.RST}`);
    log(`Proxy: ${currentProxy ? currentProxy : 'NONE'}`);

    // Wallet Persona — deterministic personality from address
    const persona = getWalletPersona(addr);
    log(`${C.CYN}Persona: ${persona.name} (task delay: ${persona.minTaskDelay/1000}–${persona.maxTaskDelay/1000}s, pause chance: ${(persona.txPauseChance*100).toFixed(0)}%)${C.RST}`);
    const tag = addr.slice(0, 8);

    // --- BUILD TASK INDEX ---
    // Ignore API's t.completed since it belongs to the master wallet. Use local progress instead.
    const activeTasks = tasks.filter(t => t.active);
    const completedTasks = activeTasks.filter(t => completedTaskIds.includes(t.id));
    const pendingTasks = activeTasks.filter(t => !completedTaskIds.includes(t.id));
    
    let totalTargetTx = 0;
    
    // Summing required amounts
    const amounts = {
        usdc: { mint: 0, stake: 0, bridge: 0, send: 0, receive: 0 },
        usdt: { mint: 0, stake: 0, bridge: 0, send: 0, receive: 0 }
    };
    
    for (const t of pendingTasks) {
        const p = t.product as 'usdc' | 'usdt';
        const type = t.type as 'mint' | 'stake' | 'bridge' | 'send' | 'receive' | 'transaction';
        if (p && amounts[p] && type in amounts[p]) {
            amounts[p][type as 'mint'|'stake'|'bridge'|'send'|'receive'] = Math.max(amounts[p][type as 'mint'|'stake'|'bridge'|'send'|'receive'], (t.amount || 0));
        }
        if (type === 'transaction') {
            totalTargetTx = Math.max(totalTargetTx, (t.amount || 0));
        }
    }

    // Calculate amounts with a 5% buffer to account for positive jitter in subsequent steps
    const requiredUsdcForSubsequent = (amounts.usdc.stake + amounts.usdc.bridge + amounts.usdc.send + amounts.usdc.receive) * 1.05;
    const baseUsdcMint = amounts.usdc.mint > 0 || requiredUsdcForSubsequent > 0 ? Math.ceil(Math.max(amounts.usdc.mint, requiredUsdcForSubsequent) + 10) : 0;
    
    const requiredUsdtForSubsequent = (amounts.usdt.stake + amounts.usdt.bridge + amounts.usdt.send + amounts.usdt.receive) * 1.05;
    const baseUsdtMint = amounts.usdt.mint > 0 || requiredUsdtForSubsequent > 0 ? Math.ceil(Math.max(amounts.usdt.mint, requiredUsdtForSubsequent) + 10) : 0;

    log(`\n${C.CYN}=== TASK INDEX ===${C.RST}`);
    log(`Total Active Tasks: ${activeTasks.length}`);
    log(`Confirmed (Completed): ${C.GRN}${completedTasks.length}${C.RST}`);
    log(`Pending: ${C.YLW}${pendingTasks.length}${C.RST}`);
    
    if (pendingTasks.length > 0) {
        log(`\n${C.CYN}Pending Action Amounts:${C.RST}`);
        if (baseUsdcMint > 0 || baseUsdtMint > 0) log(`- Mint: ${baseUsdcMint} USDC, ${baseUsdtMint} USDT`);
        if (amounts.usdc.stake > 0 || amounts.usdt.stake > 0) log(`- Stake: ${amounts.usdc.stake} USDC, ${amounts.usdt.stake} USDT`);
        if (amounts.usdc.bridge > 0 || amounts.usdt.bridge > 0) log(`- Bridge: ${amounts.usdc.bridge} USDC, ${amounts.usdt.bridge} USDT`);
        if (amounts.usdc.send > 0 || amounts.usdt.send > 0) log(`- Send: ${amounts.usdc.send} USDC, ${amounts.usdt.send} USDT`);
        if (amounts.usdc.receive > 0 || amounts.usdt.receive > 0) log(`- Receive: ${amounts.usdc.receive} USDC, ${amounts.usdt.receive} USDT`);
        if (totalTargetTx > 0) log(`- Dummy TX Target: ${totalTargetTx}`);
    }
    log(`${C.CYN}==================${C.RST}\n`);

    if (pendingTasks.length === 0) {
        log(`${C.GRN}🎉 No pending tasks for ${addr.slice(0,8)}. Skipping to next wallet!${C.RST}`);
        return [];
    }

    const completedThisRun: string[] = [];
    let txCount = 0;

    let faucet = new Contract(ADDR.AAVE_FAUCET, FAUCET_ABI, wallet);
    let cPlus = new Contract(ADDR.C_PLUS, MINT_ABI, wallet);
    let tPlus = new Contract(ADDR.T_PLUS, MINT_ABI, wallet);
    let scPlus = new Contract(ADDR.SC_PLUS, STAKE_ABI, wallet);
    let stPlus = new Contract(ADDR.ST_PLUS, STAKE_ABI, wallet);
    let usdc = new Contract(ADDR.USDC, ERC20_ABI, wallet);
    let usdt = new Contract(ADDR.USDT, ERC20_ABI, wallet);

    // Identify individual tasks
    const usdcMintTask = pendingTasks.find(t => t.product === 'usdc' && t.type === 'mint');
    const usdtMintTask = pendingTasks.find(t => t.product === 'usdt' && t.type === 'mint');
    const usdcStakeTask = pendingTasks.find(t => t.product === 'usdc' && t.type === 'stake');
    const usdtStakeTask = pendingTasks.find(t => t.product === 'usdt' && t.type === 'stake');
    const usdcSendTask = pendingTasks.find(t => t.product === 'usdc' && t.type === 'send');
    const usdtSendTask = pendingTasks.find(t => t.product === 'usdt' && t.type === 'send');
    const usdcReceiveTask = pendingTasks.find(t => t.product === 'usdc' && t.type === 'receive');
    const usdtReceiveTask = pendingTasks.find(t => t.product === 'usdt' && t.type === 'receive');
    const usdcBridgeTask = pendingTasks.find(t => t.product === 'usdc' && t.type === 'bridge');
    const usdtBridgeTask = pendingTasks.find(t => t.product === 'usdt' && t.type === 'bridge');
    const dummyTask = pendingTasks.find(t => t.type === 'transaction');

    function rotateProxy() {
        if (allProxies.length === 0) return;
        const oldProxy = currentProxy;
        let attempts = 0;
        while (attempts < 10) {
            const nextProxy = allProxies[Math.floor(Math.random() * allProxies.length)];
            if (nextProxy !== oldProxy || allProxies.length === 1) {
                currentProxy = nextProxy;
                break;
            }
            attempts++;
        }
        log(`[PROXY ROTATION] Rotating from ${oldProxy || 'NONE'} to ${currentProxy}`);
        
        provider = createProvider(rpcUrl, currentProxy);
        wallet = new Wallet(privateKey.trim(), provider);
        
        faucet = faucet.connect(wallet) as Contract;
        cPlus = cPlus.connect(wallet) as Contract;
        tPlus = tPlus.connect(wallet) as Contract;
        scPlus = scPlus.connect(wallet) as Contract;
        stPlus = stPlus.connect(wallet) as Contract;
        usdc = usdc.connect(wallet) as Contract;
        usdt = usdt.connect(wallet) as Contract;
    }

    async function runWithProxyRetry<T>(fn: () => Promise<T>, maxRetries = 15): Promise<T> {
        let lastError: any;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                return await fn();
            } catch (err: any) {
                lastError = err;
                const errMsg = err.message || String(err);
                const isNetworkError = 
                    errMsg.includes("fetch failed") ||
                    errMsg.includes("timeout") ||
                    errMsg.includes("proxy") ||
                    errMsg.includes("socket") ||
                    errMsg.includes("hang up") ||
                    errMsg.includes("ECONN") ||
                    errMsg.includes("ETIMEDOUT") ||
                    errMsg.includes("ENOTFOUND") ||
                    errMsg.includes("status=407") ||
                    errMsg.includes("status=502") ||
                    errMsg.includes("status=503") ||
                    errMsg.includes("status=504");

                if (isNetworkError && allProxies.length > 0) {
                    log(`${C.YLW}[Attempt ${attempt}/${maxRetries}] Network/Proxy issue detected: ${errMsg.slice(0, 80)}...${C.RST}`);
                    rotateProxy();
                    await randomSleep(2000, 4000);
                } else {
                    throw err;
                }
            }
        }
        throw lastError;
    }

    async function fillTokenBalance(tokenContract: Contract, requiredAmount: bigint, label: string) {
        let currentBal = 0n;
        try {
            currentBal = await runWithProxyRetry(() => tokenContract.balanceOf(addr));
        } catch (e: any) {
            log(`${C.RED}⚠️ Failed to get initial ${label} balance: ${e.message}${C.RST}`);
            currentBal = requiredAmount; // skip faucet if we can't get balance
        }

        while (currentBal < requiredAmount) {
            log(`${C.YLW}Faucet ${label}...${C.RST}`);
            try {
                const tokenAddr = await runWithProxyRetry(() => tokenContract.getAddress());
                const tx = await runWithProxyRetry(() => faucet.mint(tokenAddr, addr, parseUnits('10000', 6)));
                await runWithProxyRetry(() => tx.wait()); txCount++;
            } catch(e: any) { 
                log(`${C.RED}⚠️ ${label} faucet error: ${e.message?.slice(0,80)}${C.RST}`);
                break; // escape loop if faucet breaks
            }
            try {
                currentBal = await runWithProxyRetry(() => tokenContract.balanceOf(addr));
            } catch (e: any) {
                log(`${C.RED}⚠️ Failed to get ${label} balance after faucet: ${e.message}${C.RST}`);
                break;
            }
            await randomSleep(2000, 4000);
        }
    }

    async function doApproveInner(token: string, spender: string, amount: bigint, label: string) {
        const c = new Contract(token, ERC20_ABI, wallet);
        const a: bigint = await runWithProxyRetry(() => c.allowance(wallet.address, spender));
        if (a >= amount) return;
        log(`${C.YLW}[${wallet.address.slice(0, 8)}] Approving ${label}...${C.RST}`);
        const tx = await runWithProxyRetry(() => c.approve(spender, MaxUint256));
        await runWithProxyRetry(() => tx.wait());
        await randomSleep(2000, 5000);
    }

    try {
        const ethBal = await runWithProxyRetry(() => provider.getBalance(addr));
        log(`ETH Balance: ${formatEther(ethBal)}`);
        if (ethBal < parseEther('0.015')) {
            log(`${C.RED}[SKIP] Insufficient ETH for gas (Balance: ${formatEther(ethBal)} ETH, minimum required: 0.015 ETH).${C.RST}`);
            return [];
        }

        // --- C+/T+ BALANCE CHECK & TOP-UP PLANNING ---
        let cPlusBal = 0n;
        let tPlusBal = 0n;
        try {
            cPlusBal = await runWithProxyRetry(() => cPlus.balanceOf(addr));
            tPlusBal = await runWithProxyRetry(() => tPlus.balanceOf(addr));
        } catch (e: any) {
            log(`${C.RED}⚠️ Failed to get initial C+/T+ balances: ${e.message}${C.RST}`);
        }

        const targetCPlus = parseUnits('5000', 18);
        const targetTPlus = parseUnits('5000', 18);

        let neededCPlusMint = 0n;
        let neededTPlusMint = 0n;

        if (cPlusBal < targetCPlus) {
            neededCPlusMint = targetCPlus - cPlusBal;
            log(`[FUND CHECK] C+ balance is ${formatEther(cPlusBal)} (Deficit: ${formatEther(neededCPlusMint)}). Scheduled for top-up to 5000+ C+.`);
        } else {
            log(`[FUND CHECK] C+ balance is ${formatEther(cPlusBal)} (OK).`);
        }

        if (tPlusBal < targetTPlus) {
            neededTPlusMint = targetTPlus - tPlusBal;
            log(`[FUND CHECK] T+ balance is ${formatEther(tPlusBal)} (Deficit: ${formatEther(neededTPlusMint)}). Scheduled for top-up to 5000+ T+.`);
        } else {
            log(`[FUND CHECK] T+ balance is ${formatEther(tPlusBal)} (OK).`);
        }

        // Calculate total USDC/USDT needed (top-up collateral + task collateral + 100 buffer)
        const usdcForTopup = neededCPlusMint / 10n**12n;
        const usdcForTasks = parseUnits(baseUsdcMint.toString(), 6);
        let totalUsdcNeeded = usdcForTopup + usdcForTasks + parseUnits('100', 6);
        if (totalUsdcNeeded < parseUnits('2000', 6)) totalUsdcNeeded = parseUnits('2000', 6);

        const usdtForTopup = neededTPlusMint / 10n**12n;
        const usdtForTasks = parseUnits(baseUsdtMint.toString(), 6);
        let totalUsdtNeeded = usdtForTopup + usdtForTasks + parseUnits('100', 6);
        if (totalUsdtNeeded < parseUnits('2000', 6)) totalUsdtNeeded = parseUnits('2000', 6);

        // Faucet USDC and USDT
        await fillTokenBalance(usdc, totalUsdcNeeded, 'USDC');
        await fillTokenBalance(usdt, totalUsdtNeeded, 'USDT');

        // Execute top-up mints if required
        if (neededCPlusMint > 0n) {
            try {
                const amtUsdc = neededCPlusMint / 10n**12n;
                await doApproveInner(ADDR.USDC, ADDR.C_PLUS, amtUsdc, 'USDC to C+ Top-up');
                log(`${C.CYN}Top-up: Minting ${formatEther(neededCPlusMint)} C+...${C.RST}`);
                const tx = await runWithProxyRetry(() => cPlus.mint([addr, addr, ADDR.USDC, amtUsdc, neededCPlusMint]));
                await runWithProxyRetry(() => tx.wait()); txCount++;
                log(`${C.GRN}✅ C+ Top-up completed${C.RST}`);
                await humanSleep(persona.minActionDelay, persona.maxActionDelay);
            } catch (e: any) {
                logError(`${C.RED}❌ C+ Top-up failed: ${e.message}${C.RST}`);
            }
        }

        if (neededTPlusMint > 0n) {
            try {
                const amtUsdt = neededTPlusMint / 10n**12n;
                await doApproveInner(ADDR.USDT, ADDR.T_PLUS, amtUsdt, 'USDT to T+ Top-up');
                log(`${C.CYN}Top-up: Minting ${formatEther(neededTPlusMint)} T+...${C.RST}`);
                const tx = await runWithProxyRetry(() => tPlus.mint([addr, addr, ADDR.USDT, amtUsdt, neededTPlusMint]));
                await runWithProxyRetry(() => tx.wait()); txCount++;
                log(`${C.GRN}✅ T+ Top-up completed${C.RST}`);
                await humanSleep(persona.minActionDelay, persona.maxActionDelay);
            } catch (e: any) {
                logError(`${C.RED}❌ T+ Top-up failed: ${e.message}${C.RST}`);
            }
        }

        // --- EXECUTION PHASE ---
        let mintSteps: Array<() => Promise<void>> = [];

        // 1. MINT ALL REQUIRED C+
        if (baseUsdcMint > 10) {
            mintSteps.push(async () => {
                try {
                    const amt = randomJitterAmount(baseUsdcMint, 5);
                    await doApproveInner(ADDR.USDC, ADDR.C_PLUS, parseUnits(amt, 6), 'USDC to C+');
                    log(`${C.CYN}Minting ${amt} C+...${C.RST}`);
                    const tx = await runWithProxyRetry(() => cPlus.mint([addr, addr, ADDR.USDC, parseUnits(amt, 6), parseUnits(amt, 18)]));
                    await runWithProxyRetry(() => tx.wait()); txCount++;
                    log(`${C.GRN}✅ C+ minted${C.RST}`);
                    if (usdcMintTask) {
                        completedThisRun.push(usdcMintTask.id);
                        if (onTaskCompleted) onTaskCompleted(usdcMintTask.id);
                    }
                    await humanSleep(persona.minActionDelay, persona.maxActionDelay);
                    await maybeTakeMicroBreak(persona, tag);
                } catch (e: any) {
                    logError(`${C.RED}❌ Error minting C+: ${e.message}${C.RST}`);
                }
            });
        }

        // 2. MINT ALL REQUIRED T+
        if (baseUsdtMint > 10) {
            mintSteps.push(async () => {
                try {
                    const amt = randomJitterAmount(baseUsdtMint, 5);
                    await doApproveInner(ADDR.USDT, ADDR.T_PLUS, parseUnits(amt, 6), 'USDT to T+');
                    log(`${C.CYN}Minting ${amt} T+...${C.RST}`);
                    const tx = await runWithProxyRetry(() => tPlus.mint([addr, addr, ADDR.USDT, parseUnits(amt, 6), parseUnits(amt, 18)]));
                    await runWithProxyRetry(() => tx.wait()); txCount++;
                    log(`${C.GRN}✅ T+ minted${C.RST}`);
                    if (usdtMintTask) {
                        completedThisRun.push(usdtMintTask.id);
                        if (onTaskCompleted) onTaskCompleted(usdtMintTask.id);
                    }
                    await humanSleep(persona.minActionDelay, persona.maxActionDelay);
                    await maybeTakeMicroBreak(persona, tag);
                } catch (e: any) {
                    logError(`${C.RED}❌ Error minting T+: ${e.message}${C.RST}`);
                }
            });
        }

        // Run Mint Steps Shuffled
        mintSteps = shuffleArray(mintSteps);
        for (const step of mintSteps) {
            await step();
        }

        let actionSteps: Array<() => Promise<void>> = [];

        // 3. STAKE C+
        if (amounts.usdc.stake > 0) {
            actionSteps.push(async () => {
                try {
                    const amt = randomJitterAmount(amounts.usdc.stake, 2);
                    const stakeAmt = parseUnits(amt, 18);
                    await doApproveInner(ADDR.C_PLUS, ADDR.SC_PLUS, stakeAmt, 'C+ to sC+');
                    log(`${C.CYN}Staking ${amt} C+...${C.RST}`);
                    const tx = await runWithProxyRetry(() => scPlus.deposit(stakeAmt, addr));
                    await runWithProxyRetry(() => tx.wait()); txCount++;
                    log(`${C.GRN}✅ C+ staked${C.RST}`);
                    if (usdcStakeTask) {
                        completedThisRun.push(usdcStakeTask.id);
                        if (onTaskCompleted) onTaskCompleted(usdcStakeTask.id);
                    }
                    await humanSleep(persona.minTaskDelay, persona.maxTaskDelay);
                    await maybeTakeMicroBreak(persona, tag);
                } catch (e: any) {
                    logError(`${C.RED}❌ Error staking C+: ${e.message}${C.RST}`);
                }
            });
        }

        // 4. STAKE T+
        if (amounts.usdt.stake > 0) {
            actionSteps.push(async () => {
                try {
                    const amt = randomJitterAmount(amounts.usdt.stake, 2);
                    const stakeAmt = parseUnits(amt, 18);
                    await doApproveInner(ADDR.T_PLUS, ADDR.ST_PLUS, stakeAmt, 'T+ to sT+');
                    log(`${C.CYN}Staking ${amt} T+...${C.RST}`);
                    const tx = await runWithProxyRetry(() => stPlus.deposit(stakeAmt, addr));
                    await runWithProxyRetry(() => tx.wait()); txCount++;
                    log(`${C.GRN}✅ T+ staked${C.RST}`);
                    if (usdtStakeTask) {
                        completedThisRun.push(usdtStakeTask.id);
                        if (onTaskCompleted) onTaskCompleted(usdtStakeTask.id);
                    }
                    await humanSleep(persona.minTaskDelay, persona.maxTaskDelay);
                    await maybeTakeMicroBreak(persona, tag);
                } catch (e: any) {
                    logError(`${C.RED}❌ Error staking T+: ${e.message}${C.RST}`);
                }
            });
        }

        // 5. SEND C+
        if (amounts.usdc.send > 0) {
            actionSteps.push(async () => {
                try {
                    const amt = randomJitterAmount(amounts.usdc.send, 1);
                    const sendAmt = parseUnits(amt, 18);
                    const randomBurnAddr = Wallet.createRandom().address;
                    log(`${C.CYN}Sending ${amt} C+ to random external address (${randomBurnAddr.slice(0,8)})...${C.RST}`);
                    const tx = await runWithProxyRetry(() => cPlus.transfer(randomBurnAddr, sendAmt));
                    await runWithProxyRetry(() => tx.wait()); txCount++;
                    log(`${C.GRN}✅ C+ sent (Sybil Graph Broken)${C.RST}`);
                    if (usdcSendTask) {
                        completedThisRun.push(usdcSendTask.id);
                        if (onTaskCompleted) onTaskCompleted(usdcSendTask.id);
                    }
                    await humanSleep(persona.minTaskDelay, persona.maxTaskDelay);
                    await maybeTakeMicroBreak(persona, tag);
                } catch (e: any) {
                    logError(`${C.RED}❌ Error sending C+: ${e.message}${C.RST}`);
                }
            });
        }

        // 6. SEND T+
        if (amounts.usdt.send > 0) {
            actionSteps.push(async () => {
                try {
                    const amt = randomJitterAmount(amounts.usdt.send, 1);
                    const sendAmt = parseUnits(amt, 18);
                    const randomBurnAddr = Wallet.createRandom().address;
                    log(`${C.CYN}Sending ${amt} T+ to random external address (${randomBurnAddr.slice(0,8)})...${C.RST}`);
                    const tx = await runWithProxyRetry(() => tPlus.transfer(randomBurnAddr, sendAmt));
                    await runWithProxyRetry(() => tx.wait()); txCount++;
                    log(`${C.GRN}✅ T+ sent (Sybil Graph Broken)${C.RST}`);
                    if (usdtSendTask) {
                        completedThisRun.push(usdtSendTask.id);
                        if (onTaskCompleted) onTaskCompleted(usdtSendTask.id);
                    }
                    await humanSleep(persona.minTaskDelay, persona.maxTaskDelay);
                    await maybeTakeMicroBreak(persona, tag);
                } catch (e: any) {
                    logError(`${C.RED}❌ Error sending T+: ${e.message}${C.RST}`);
                }
            });
        }

        // 7. RECEIVE C+ (Via Burner Wallet to avoid Self-Transfer which doesn't get indexed)
        if (amounts.usdc.receive > 0) {
            actionSteps.push(async () => {
                try {
                    const amt = randomJitterAmount(amounts.usdc.receive, 1);
                    const sendAmt = parseUnits(amt, 18);
                    
                    const burner = Wallet.createRandom().connect(provider);
                    log(`${C.CYN}Setting up burner wallet (${burner.address.slice(0,8)}) to process Receive C+...${C.RST}`);
                    
                    log(`Sending ${amt} C+ to burner...`);
                    let tx = await runWithProxyRetry(() => cPlus.transfer(burner.address, sendAmt));
                    await runWithProxyRetry(() => tx.wait()); txCount++;
                    
                    const gasAmt = parseEther("0.005");
                    log(`Sending 0.005 ETH to burner for gas...`);
                    tx = await runWithProxyRetry(() => wallet.sendTransaction({
                        to: burner.address,
                        value: gasAmt
                    }));
                    await runWithProxyRetry(() => tx.wait()); txCount++;
                    
                    await randomSleep(2000, 4000);
                    
                    const burnerCPlus = cPlus.connect(burner) as Contract;
                    log(`Transferring ${amt} C+ back from burner to main wallet to hit Receive task...`);
                    tx = await runWithProxyRetry(() => burnerCPlus.transfer(addr, sendAmt));
                    await runWithProxyRetry(() => tx.wait());
                    log(`${C.GRN}✅ C+ received from burner wallet${C.RST}`);
                    
                    try {
                        const burnerEthBal = await runWithProxyRetry(() => provider.getBalance(burner.address));
                        const feeData = await runWithProxyRetry(() => provider.getFeeData());
                        const gasPrice = (feeData.gasPrice ?? parseUnits("10", "gwei")) * 12n / 10n;
                        const gasLimit = 21000n;
                        const ethTxFee = gasPrice * gasLimit;
                        if (burnerEthBal > ethTxFee) {
                            const sendBackAmt = burnerEthBal - ethTxFee;
                            if (sendBackAmt > parseEther("0.0001")) {
                                log(`Returning ${formatEther(sendBackAmt)} leftover ETH to main wallet...`);
                                const returnTx = await runWithProxyRetry(() => burner.sendTransaction({
                                    to: addr,
                                    value: sendBackAmt,
                                    gasLimit,
                                    gasPrice
                                }));
                                await runWithProxyRetry(() => returnTx.wait());
                            }
                        }
                    } catch (ethErr: any) {
                        log(`${C.YLW}⚠️ Failed to return leftover ETH from burner: ${ethErr.message}${C.RST}`);
                    }
                    
                    if (usdcReceiveTask) {
                        completedThisRun.push(usdcReceiveTask.id);
                        if (onTaskCompleted) onTaskCompleted(usdcReceiveTask.id);
                    }
                    await humanSleep(persona.minTaskDelay, persona.maxTaskDelay);
                    await maybeTakeMicroBreak(persona, tag);
                } catch (e: any) {
                    logError(`${C.RED}❌ Error receiving C+: ${e.message}${C.RST}`);
                }
            });
        }

        // 8. RECEIVE T+ (Via Burner Wallet to avoid Self-Transfer which doesn't get indexed)
        if (amounts.usdt.receive > 0) {
            actionSteps.push(async () => {
                try {
                    const amt = randomJitterAmount(amounts.usdt.receive, 1);
                    const sendAmt = parseUnits(amt, 18);
                    
                    const burner = Wallet.createRandom().connect(provider);
                    log(`${C.CYN}Setting up burner wallet (${burner.address.slice(0,8)}) to process Receive T+...${C.RST}`);
                    
                    log(`Sending ${amt} T+ to burner...`);
                    let tx = await runWithProxyRetry(() => tPlus.transfer(burner.address, sendAmt));
                    await runWithProxyRetry(() => tx.wait()); txCount++;
                    
                    const gasAmt = parseEther("0.005");
                    log(`Sending 0.005 ETH to burner for gas...`);
                    tx = await runWithProxyRetry(() => wallet.sendTransaction({
                        to: burner.address,
                        value: gasAmt
                    }));
                    await runWithProxyRetry(() => tx.wait()); txCount++;
                    
                    await randomSleep(2000, 4000);
                    
                    const burnerTPlus = tPlus.connect(burner) as Contract;
                    log(`Transferring ${amt} T+ back from burner to main wallet to hit Receive task...`);
                    tx = await runWithProxyRetry(() => burnerTPlus.transfer(addr, sendAmt));
                    await runWithProxyRetry(() => tx.wait());
                    log(`${C.GRN}✅ T+ received from burner wallet${C.RST}`);
                    
                    try {
                        const burnerEthBal = await runWithProxyRetry(() => provider.getBalance(burner.address));
                        const feeData = await runWithProxyRetry(() => provider.getFeeData());
                        const gasPrice = (feeData.gasPrice ?? parseUnits("10", "gwei")) * 12n / 10n;
                        const gasLimit = 21000n;
                        const ethTxFee = gasPrice * gasLimit;
                        if (burnerEthBal > ethTxFee) {
                            const sendBackAmt = burnerEthBal - ethTxFee;
                            if (sendBackAmt > parseEther("0.0001")) {
                                log(`Returning ${formatEther(sendBackAmt)} leftover ETH to main wallet...`);
                                const returnTx = await runWithProxyRetry(() => burner.sendTransaction({
                                    to: addr,
                                    value: sendBackAmt,
                                    gasLimit,
                                    gasPrice
                                }));
                                await runWithProxyRetry(() => returnTx.wait());
                            }
                        }
                    } catch (ethErr: any) {
                        log(`${C.YLW}⚠️ Failed to return leftover ETH from burner: ${ethErr.message}${C.RST}`);
                    }
                    
                    if (usdtReceiveTask) {
                        completedThisRun.push(usdtReceiveTask.id);
                        if (onTaskCompleted) onTaskCompleted(usdtReceiveTask.id);
                    }
                    await humanSleep(persona.minTaskDelay, persona.maxTaskDelay);
                    await maybeTakeMicroBreak(persona, tag);
                } catch (e: any) {
                    logError(`${C.RED}❌ Error receiving T+: ${e.message}${C.RST}`);
                }
            });
        }

        // 9. BRIDGE C+
        if (amounts.usdc.bridge > 0) {
            actionSteps.push(async () => {
                try {
                    const amt = randomJitterAmount(amounts.usdc.bridge, 0);
                    const bridgeAmt = parseUnits(amt, 18);
                    log(`${C.CYN}Bridging ${amt} C+...${C.RST}`);
                    const oft = new Contract(ADDR.C_PLUS, OFT_ABI, wallet);
                    let needsApproval = false;
                    try { needsApproval = await runWithProxyRetry(() => oft.approvalRequired()); } catch {}
                    if (needsApproval) await doApproveInner(ADDR.C_PLUS, ADDR.C_PLUS, bridgeAmt, 'C+ Bridge');
                    
                    const toBytes32 = zeroPadValue(addr, 32);
                    const minAmount = (bridgeAmt * 99n) / 100n;
                    const sendParam = [LZ_DST_EID, toBytes32, bridgeAmt, minAmount, '0x000301001101000000000000000000000000000186a0', '0x', '0x'];
                    const fee = await runWithProxyRetry(() => oft.quoteSend(sendParam, false));
                    
                    const tx = await runWithProxyRetry(() => oft.send(sendParam, [fee.nativeFee, 0n], addr, { value: fee.nativeFee }));
                    await runWithProxyRetry(() => tx.wait()); txCount++;
                    log(`${C.GRN}✅ Bridged C+${C.RST}`);
                    if (usdcBridgeTask) {
                        completedThisRun.push(usdcBridgeTask.id);
                        if (onTaskCompleted) onTaskCompleted(usdcBridgeTask.id);
                    }
                } catch(e: any) { 
                    log(`${C.RED}⚠️ C+ Bridge failed: ${e.message?.slice(0, 100)}${C.RST}`); 
                }
                await randomSleep(2000, 5000);
            });
        }

        // 10. BRIDGE T+
        if (amounts.usdt.bridge > 0) {
            actionSteps.push(async () => {
                try {
                    const amt = randomJitterAmount(amounts.usdt.bridge, 0);
                    const bridgeAmt = parseUnits(amt, 18);
                    log(`${C.CYN}Bridging ${amt} T+...${C.RST}`);
                    const oft = new Contract(ADDR.T_PLUS, OFT_ABI, wallet);
                    let needsApproval = false;
                    try { needsApproval = await runWithProxyRetry(() => oft.approvalRequired()); } catch {}
                    if (needsApproval) await doApproveInner(ADDR.T_PLUS, ADDR.T_PLUS, bridgeAmt, 'T+ Bridge');
                    
                    const toBytes32 = zeroPadValue(addr, 32);
                    const minAmount = (bridgeAmt * 99n) / 100n;
                    const sendParam = [LZ_DST_EID, toBytes32, bridgeAmt, minAmount, '0x000301001101000000000000000000000000000186a0', '0x', '0x'];
                    const fee = await runWithProxyRetry(() => oft.quoteSend(sendParam, false));
                    
                    const tx = await runWithProxyRetry(() => oft.send(sendParam, [fee.nativeFee, 0n], addr, { value: fee.nativeFee }));
                    await runWithProxyRetry(() => tx.wait()); txCount++;
                    log(`${C.GRN}✅ Bridged T+${C.RST}`);
                    if (usdtBridgeTask) {
                        completedThisRun.push(usdtBridgeTask.id);
                        if (onTaskCompleted) onTaskCompleted(usdtBridgeTask.id);
                    }
                } catch(e: any) { 
                    log(`${C.RED}⚠️ T+ Bridge failed: ${e.message?.slice(0, 100)}${C.RST}`); 
                }
                await randomSleep(2000, 5000);
            });
        }

        // Shuffle and run action steps
        actionSteps = shuffleArray(actionSteps);
        for (const step of actionSteps) {
            await step();
        }

        // 9. EXTRA DUMMY TXS
        // Add a random 6-15 extra transactions as a safeguard to ensure target counts are hit and break fingerprints
        const safeguard = Math.floor(Math.random() * (15 - 6 + 1)) + 6;
        const remaining = totalTargetTx > 0 ? (Math.max(0, totalTargetTx - txCount) + safeguard) : 0;
        if (remaining > 0) {
            log(`${C.YLW}Need ${remaining} more transactions to hit targets (including +${safeguard} random safeguard)...${C.RST}`);
            let dummySuccess = true;
            let failures = 0;
            for (let i = 0; i < remaining; i++) {
                try {
                    const smallAmt = randomJitterAmount(1, 10);
                    const tx = await runWithProxyRetry(() => cPlus.mint([addr, addr, ADDR.USDC, parseUnits(smallAmt, 6), parseUnits(smallAmt, 18)]));
                    await runWithProxyRetry(() => tx.wait()); txCount++;
                    log(`  Dummy tx ${i+1}/${remaining} completed.`);
                    await humanSleep(persona.minActionDelay * 1.5, persona.maxActionDelay * 2);
                } catch (e: any) {
                    failures++;
                    logError(`${C.RED}⚠️ Dummy tx ${i+1} failed: ${e.message?.slice(0, 150)}${C.RST}`);
                    if (failures >= 5) {
                        logError(`${C.RED}Too many dummy tx failures (${failures}). Skipping remaining.${C.RST}`);
                        dummySuccess = false;
                        break;
                    }
                    log(`${C.YLW}Retrying dummy tx after 15s delay to let mempool clear...${C.RST}`);
                    await randomSleep(15000, 20000);
                    i--; // Decrement to retry this iteration
                }
            }
            if (dummySuccess && dummyTask) {
                completedThisRun.push(dummyTask.id);
                if (onTaskCompleted) onTaskCompleted(dummyTask.id);
            }
        }

        log(`\n${C.GRN}✅ Wallet ${addr.slice(0, 8)} tasks finished! Total txs this run: ${txCount}${C.RST}`);
        return completedThisRun;

    } catch (e: any) {
        logError(`${C.RED}❌ Error in wallet ${addr}:${C.RST}`, e.message);
        return completedThisRun;
    }
}
