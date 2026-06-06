import { InterfaceAbi } from "ethers";

export const ADDR = {
    USDC: '0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8',
    USDT: '0xaA8E23Fb1079EA71e0a56F48a2aA51851D8433D0',
    C_PLUS: '0xE815718D44694ec4637CB775C468d87f6e15B538',
    T_PLUS: '0xe20534a32f9162488a90026F268a74fBE28d272D',
    SC_PLUS: '0x753937137Eb92871A6F3517514d4f1Ee860e3FDF',
    ST_PLUS: '0x079a4Bf1Cbd0E4ce15391340cB46efA6396aBc82',
    AAVE_FAUCET: '0xC959483DBa39aa9E78757139af0e9a2EDEb3f42D',
};

export const LZ_DST_EID = 40245; // Base Sepolia EID

export const ERC20_ABI: InterfaceAbi = [
    'function approve(address spender, uint256 amount) returns (bool)',
    'function balanceOf(address account) view returns (uint256)',
    'function transfer(address recipient, uint256 amount) returns (bool)',
    'function allowance(address owner, address spender) view returns (uint256)',
];

export const MINT_ABI: InterfaceAbi = [
    'function mint(tuple(address benefactor, address beneficiary, address collateral, uint256 collateralAmount, uint256 minUsdAmount) order)',
    'function transfer(address recipient, uint256 amount) returns (bool)',
    'function balanceOf(address account) view returns (uint256)'
];

export const STAKE_ABI: InterfaceAbi = [
    'function deposit(uint256 assets, address receiver) returns (uint256)',
];

export const FAUCET_ABI: InterfaceAbi = [
    'function mint(address token, address to, uint256 value)'
];

export const OFT_ABI: InterfaceAbi = [
    'function quoteSend(tuple(uint32 dstEid, bytes32 to, uint256 amountLD, uint256 minAmountLD, bytes extraOptions, bytes composeMsg, bytes oftCmd) sendParam, bool payInLzToken) view returns (tuple(uint256 nativeFee, uint256 lzTokenFee))',
    'function send(tuple(uint32 dstEid, bytes32 to, uint256 amountLD, uint256 minAmountLD, bytes extraOptions, bytes composeMsg, bytes oftCmd) sendParam, tuple(uint256 nativeFee, uint256 lzTokenFee) fee, address refundAddress) payable returns (tuple(bytes32 guid, uint64 nonce, tuple(uint256 nativeFee, uint256 lzTokenFee) fee))',
    'function approvalRequired() view returns (bool)'
];
