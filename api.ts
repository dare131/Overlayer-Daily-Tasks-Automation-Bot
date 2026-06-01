import { FetchRequest } from 'ethers';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { getRandomUserAgent } from './sybil';

const API_BASE = 'https://api.overlayer.fi';

export interface DailyTask {
    id: string;
    title: string;
    type: string;
    product: string;
    chain: string;
    amount: number;
    points: number;
    active: boolean;
    startDate: string;
    description: string;
    completed: boolean;
}

function createFetchRequest(url: string, proxyUrl?: string): FetchRequest {
    const req = new FetchRequest(url);
    req.setHeader('User-Agent', getRandomUserAgent());
    req.timeout = 15000;
    if (proxyUrl) {
        const uri = proxyUrl.startsWith('http') ? proxyUrl : `http://${proxyUrl}`;
        req.getUrlFunc = FetchRequest.createGetUrlFunc({ agent: new HttpsProxyAgent(uri) });
    }
    return req;
}

export async function fetchDailyTasks(address: string, token: string, proxyUrl?: string): Promise<DailyTask[]> {
    const d = new Date();
    const todayStr = d.toISOString().split('T')[0];
    const req = createFetchRequest(`${API_BASE}/api-s/socials/onchain-tasks?address=${address}&startDate=${todayStr}&endDate=${todayStr}`, proxyUrl);
    req.setHeader('Authorization', `Bearer ${token}`);
    req.setHeader('Origin', 'https://testnet.overlayer.fi');
    const res = await req.send();
    res.assertOk();
    const data = res.bodyJson as { tasks: DailyTask[] };
    
    // Extra safety: manually filter out any tasks that do not match today's date
    const tasks = data.tasks || [];
    return tasks.filter(t => t.startDate === todayStr);
}

export async function fetchNonce(address: string, proxyUrl?: string): Promise<string> {
    const req = createFetchRequest(`${API_BASE}/api-s/auth/nonce/${address}`, proxyUrl);
    req.setHeader('Origin', 'https://testnet.overlayer.fi');
    const res = await req.send();
    res.assertOk();
    const data = res.bodyJson as { success: boolean; nonce: string };
    if (!data.success || !data.nonce) throw new Error('Failed to fetch nonce');
    return data.nonce;
}

export async function verifyAuth(address: string, message: string, signature: string, proxyUrl?: string): Promise<{ token: string; expiresAt: string }> {
    const req = createFetchRequest(`${API_BASE}/api-s/auth/verify/${address}`, proxyUrl);
    req.method = 'POST';
    req.setHeader('Content-Type', 'application/json');
    req.setHeader('Origin', 'https://testnet.overlayer.fi');
    req.body = Buffer.from(JSON.stringify({ message, signature }));
    const res = await req.send();
    res.assertOk();
    const data = res.bodyJson as { success: boolean; token: string; expiresAt: string };
    if (!data.success || !data.token) throw new Error('Auth verify returned no token');
    return { token: data.token, expiresAt: data.expiresAt || '' };
}

export async function getPoints(address: string, proxyUrl?: string): Promise<number> {
    try {
        const req = createFetchRequest(`${API_BASE}/api-s/socials/onchain-tasks/points/${address}`, proxyUrl);
        const res = await req.send();
        if (res.statusCode !== 200) return 0;
        const data = res.bodyJson as { totalPoints: number };
        return data.totalPoints || 0;
    } catch (e) {
        return 0;
    }
}

export async function submitGdprConsent(address: string, proxyUrl?: string, token?: string): Promise<boolean> {
    const req = createFetchRequest(`${API_BASE}/api-s/gdpr-consent/${address}`, proxyUrl);
    req.method = 'POST';
    req.setHeader('Content-Type', 'application/json');
    req.setHeader('Origin', 'https://testnet.overlayer.fi');
    if (token) req.setHeader('Authorization', `Bearer ${token}`);
    req.body = Buffer.from('{}');
    const res = await req.send();
    return res.statusCode === 200 || res.statusCode === 201;
}

export async function requestOgMint(address: string, signature: string, message: string, proxyUrl?: string): Promise<any> {
    const req = createFetchRequest(`${API_BASE}/api-s/socials/og/mint/${address}`, proxyUrl);
    req.method = 'POST';
    req.setHeader('Content-Type', 'application/json');
    req.body = Buffer.from(JSON.stringify({ message, signature }));
    const res = await req.send();
    return res.bodyJson;
}
