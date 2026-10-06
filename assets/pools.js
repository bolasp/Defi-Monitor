/*
 * Universo monitorado: pools de stablecoins em dólar (par estável/estável) nos
 * protocolos Uniswap v3, Uniswap v4 e Orca Whirlpools, nas redes Ethereum,
 * Polygon e Solana. Os candidatos foram levantados em 04/10/2026 a partir do
 * DefiLlama/GeckoTerminal; a chave de cada pool (tokens, fee, tick spacing,
 * hooks) foi conferida on-chain. O ranking por TVL é recalculado ao vivo, no
 * navegador, a cada leitura on-chain.
 *
 * Ficaram de fora tokens com rendimento embutido (syrupUSDC, USDY, USD0++,
 * apyUSD), pares cambiais (EUR, SGD, JPY) e pools com TVL reportado incoerente.
 */
(function () {
  const CHAINS = {
    ethereum: {
      name: 'Ethereum',
      kind: 'evm',
      rpcs: ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org', 'https://1rpc.io/eth'],
      explorer: 'https://etherscan.io',
      uniswapSlug: 'ethereum',
      gt: 'eth',
      multicall: '0xcA11bde05977b3631167028862bE2a173976CA11',
      stateView: '0x7ffe42c4a5deea5b0fec41c94c136cf115597227',
      poolManager: '0x000000000004444c5dc75cB358380D2e3dE08A90',
    },
    polygon: {
      name: 'Polygon',
      kind: 'evm',
      rpcs: ['https://polygon-bor-rpc.publicnode.com', 'https://polygon.drpc.org', 'https://1rpc.io/matic'],
      explorer: 'https://polygonscan.com',
      uniswapSlug: 'polygon',
      gt: 'polygon_pos',
      multicall: '0xcA11bde05977b3631167028862bE2a173976CA11',
      stateView: '0x5ea1bd7974c8a611cbab0bdcafcb1d9cc9b3ba5a',
      poolManager: '0x67366782805870060151383f4bbff9dab53e5cd6',
    },
    solana: {
      name: 'Solana',
      kind: 'svm',
      rpcs: ['https://solana-rpc.publicnode.com', 'https://solana-mainnet.gateway.tatum.io'],
      explorer: 'https://solscan.io',
      gt: 'solana',
      whirlpoolProgram: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
    },
  };

  const TOKENS = {
    ethereum: {
      USDC: ['0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', 6],
      USDT: ['0xdac17f958d2ee523a2206206994597c13d831ec7', 6],
      USDS: ['0xdc035d45d973e3ec169d2276ddab16f1e407384f', 18],
      PYUSD: ['0x6c3ea9036406852006290770bedfcaba0e23a0e8', 6],
      RLUSD: ['0x8292bb45bf1ee4d140127049757c2e0ff06317ed', 18],
      AUSD: ['0x00000000efe302beaa2b3e6e1b18d08d69a9012a', 6],
      USDM: ['0xbbaec992fc2d637151daf40451f160bf85f3c8c1', 6],
      USDf: ['0xfa2b947eec368f42195f24f36d2af29f7c24cec2', 18],
      apxUSD: ['0x98a878b1cd98131b271883b390f68d2c90674665', 18],
      USDG: ['0xe343167631d89b6ffc58b88d6b7fb0228795491d', 6],
      BOLD: ['0x6440f144b7e50d6a8439336510312d2f54beb01d', 18],
      GHO: ['0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f', 18],
      DAI: ['0x6b175474e89094c44da98b954eedeac495271d0f', 18],
    },
    polygon: {
      USDC: ['0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', 6],
      'USDC.e': ['0x2791bca1f2de4661ed88a30c99a7a9449aa84174', 6],
      USDT0: ['0xc2132d05d31c914a87c6611c10748aeb04b58e8f', 6],
      DAI: ['0x8f3cf7ad23cd3cadbd9735aff958023239c6a063', 18],
      eUSD: ['0x14913815bcfde78baead2111f463d038ac9c2949', 6],
    },
    solana: {
      USDC: ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 6],
      USDT: ['Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', 6],
      USX: ['6FrrzDk5mQARGc1TDYoyVnSyRdds1t4PbtohCD6p3tgG', 6],
      USDG: ['2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH', 6],
      PYUSD: ['2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo', 6],
      OUSD: ['ousd2mJsPEckLHcSCDxyKD7NDGARZcfLbDZkKiatYHB', 6],
      CASH: ['CASHx9KJUStyftLFWGvEVf59SGeG9sh5FfcnZMVPCASH', 6],
      JupUSD: ['JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD', 6],
      USDu: ['9ckR7pPPvyPadACDTzLwK2ZAEeUJ3qGSnzPs8bVaHrSy', 6],
      hyUSD: ['5YMkXAYccHSGnHn9nob9xEvv6Pvka9DZWH7nTbotTu9E', 6],
      USDe: ['DEkqHyPN7GMRJ5cArtQFAWefqbZb33Hyf6s5iCwjEonT', 9],
    },
  };

  // Quanto menor, mais "âncora": o token âncora vira a moeda de cotação (quote).
  const ANCHOR = { USDC: 1, 'USDC.e': 1.5, USDT: 2, USDT0: 2, USDS: 3, DAI: 4, PYUSD: 5, USDG: 6, USX: 7, USDe: 8 };

  const DYNAMIC_FEE = 0x800000;
  const ZERO = '0x0000000000000000000000000000000000000000';
  const HOOK_DYN = '0x0000113dcf4add69999fad8f20f2b63f979bfcc0';

  // [chain, protocolo, endereço ou poolId, token0, token1, fee (milionésimos), tickSpacing, hooks]
  const RAW = [
    // Ethereum · Uniswap v4 (poolId via StateView)
    ['ethereum', 'v4', '0xe63e32b2ae40601662f760d6bf5d771057324fbd97784fe1d3717069f7b75d45', 'PYUSD', 'USDS', 5, 1, ZERO],
    ['ethereum', 'v4', '0x3b1b1f2e775a6db1664f8e7d59ad568605ea2406312c11aef03146c0cf89d5b9', 'USDT', 'USDS', 5, 1, ZERO],
    ['ethereum', 'v4', '0x9035721b23481db3888fd201b9c2b26dbc3af60258bca65e669f2ed98dc8eb4f', 'RLUSD', 'USDS', 5, 1, ZERO],
    ['ethereum', 'v4', '0x9f2d9491277a9f2551c1f7533c1789aa6023bba0c5e9397e8a019cac5c10fe7f', 'apxUSD', 'USDC', 500, 10, ZERO],
    ['ethereum', 'v4', '0x8aa4e11cbdf30eedc92100f4c8a31ff748e201d44712cc8c90d189edaa8e4e47', 'USDC', 'USDT', 10, 1, ZERO],
    ['ethereum', 'v4', '0x2b21c65d9a7dc6926ee330a1c6e5a8037fd81774f3dc066536f800128e39f634', 'USDC', 'USDT', DYNAMIC_FEE, 1, HOOK_DYN],
    ['ethereum', 'v4', '0xeda62d2906d0edf26d40c793d581609552a44a87f618a98ff76ebe8dde4b7edb', 'USDC', 'USDG', DYNAMIC_FEE, 1, HOOK_DYN],
    ['ethereum', 'v4', '0x395f91b34aa34a477ce3bc6505639a821b286a62b1a164fc1887fa3a5ef713a5', 'USDC', 'USDT', 8, 1, ZERO],
    ['ethereum', 'v4', '0x0fb0e40cec3bb23e13abc585958a93c796fbea56955e19a23727a716a0423239', 'USDC', 'USDT', 7, 1, ZERO],
    ['ethereum', 'v4', '0x5d0ed52610c76d7bf729130ce7ddc0488b2f4bd0a0db1f12adbe6a32deaff893', 'BOLD', 'USDC', 500, 10, ZERO],
    ['ethereum', 'v4', '0xb3ec039dd452a0c23404fec0bcaf6a6e4e1111469f2bfe7b7b5f41a0e366c03c', 'GHO', 'USDC', 500, 10, ZERO],
    // Ethereum · Uniswap v3
    ['ethereum', 'v3', '0x3416cf6c708da44db2624d63ea0aaef7113527c6', 'USDC', 'USDT', 100, 1],
    ['ethereum', 'v3', '0xbafead7c60ea473758ed6c6021505e8bbd7e8e5d', 'AUSD', 'USDC', 100, 1],
    ['ethereum', 'v3', '0x4a25dbdf9629b1782c3e2c7de3bdce41f1c7f801', 'USDM', 'USDT', 500, 10],
    ['ethereum', 'v3', '0xc275a7390966e4bcbf331b837cd7316c4a3efa83', 'USDT', 'USDf', 100, 1],
    ['ethereum', 'v3', '0xcc6d2f26d363836f85a42d249e145ec0320d3e55', 'RLUSD', 'USDC', 100, 1],
    ['ethereum', 'v3', '0x48da0965ab2d2cbf1c17c09cfb5cbe67ad5b1406', 'DAI', 'USDT', 100, 1],
    // Polygon · Uniswap v4
    ['polygon', 'v4', '0xe3f907c3512aea11d4cf0c2990970016b5ee5b1f83368c388287001f419052a4', 'USDC.e', 'USDC', 13, 1, ZERO],
    ['polygon', 'v4', '0xc618f0252d0919520a9a0f0087b2886e10eb70cd271b51b3ed529790cb473e52', 'eUSD', 'USDC', 0, 1, ZERO],
    ['polygon', 'v4', '0xe1882ad75ae55f11733eb6a8b969fceabf23def0dd9fc8242395ef03f3fd49ff', 'DAI', 'USDT0', 20, 1, ZERO],
    ['polygon', 'v4', '0xa37d3e6da98dfeb7dc8103a6614f586916a6e04d41ea0a929bc19a029de1a399', 'USDC', 'USDT0', 8, 1, ZERO],
    ['polygon', 'v4', '0x6da799cefb9ea6ceb8e45b37585c4cd7844b3aec34aa999c266beff925af1829', 'USDC', 'DAI', 50, 1, ZERO],
    ['polygon', 'v4', '0x0babfcba4097bc612025341a5951718f484487e6aeeeab69b8263116f68dcc90', 'USDC.e', 'USDC', 19, 1, ZERO],
    ['polygon', 'v4', '0xd94926480e4db41cb61b009c592cacfb7fa17dd872885217bedcbe7495c0a750', 'USDC.e', 'USDT0', 100, 1, ZERO],
    // Polygon · Uniswap v3
    ['polygon', 'v3', '0x31083a78e11b18e450fd139f9abea98cd53181b7', 'USDC', 'USDT0', 100, 1],
    ['polygon', 'v3', '0xdac8a8e6dbf8c690ec6815e0ff03491b2770255d', 'USDC.e', 'USDT0', 100, 1],
    ['polygon', 'v3', '0xd36ec33c8bed5a9f7b6630855f1533455b98a418', 'USDC.e', 'USDC', 100, 1],
    ['polygon', 'v3', '0x254aa3a898071d6a2da0db11da73b02b4646078f', 'DAI', 'USDT0', 100, 1],
    ['polygon', 'v3', '0x5645dcb64c059aa11212707fbf4e7f984440a8cf', 'USDC.e', 'DAI', 100, 1],
    // Solana · Orca Whirlpools (token A = token0, token B = token1)
    ['solana', 'orca', '2e3WeM4WwdEqwTtRnWN3gJSbhNg1P6Aj2y7kEdfrYbix', 'USX', 'USDC', 100, 1],
    ['solana', 'orca', '9RqDTfwCx2SgxsvKpspQHc38HUo3B6hRd3oR9JR966Ps', 'USDG', 'USDC', 100, 1],
    ['solana', 'orca', '9tXiuRRw7kbejLhZXtxDxYs2REe43uH2e7k1kocgdM9B', 'PYUSD', 'USDC', 100, 1],
    ['solana', 'orca', 'BqCfmajD8Z67KrVE8i4XN43vyPS9hppFAt5dPZFFaMfu', 'OUSD', 'USDC', 100, 1],
    ['solana', 'orca', '3wijQvPKm6jHQrAkfPpok5o8WjCWPm1DGG17NmeW8q1w', 'CASH', 'USDC', 100, 1],
    ['solana', 'orca', 'GsKfZZEhrp6KHe3DLLbrD1pft22B6BDB3cxzAbPXZjq9', 'PYUSD', 'USDG', 100, 1],
    ['solana', 'orca', '4tgA77vUnDaTADqGJYhJYT1Qf8nnukxFGohoXR3tzPau', 'JupUSD', 'USDC', 100, 1],
    ['solana', 'orca', '94BpFoyri4uTT55NFSHKYNFyUMtoWXEisMA4LK7nTKPU', 'USDu', 'USDC', 100, 1],
    ['solana', 'orca', 'J6h5bf3iohBXtsRNRFAqFc5FeBCh3yAjxXGuiE1sTc5Q', 'USDG', 'USX', 100, 1],
    ['solana', 'orca', '4tJW2axbTxtT6nKbjB5pZwePtW84cB7E1B6tdCCLGfrC', 'hyUSD', 'USDC', 100, 1],
    ['solana', 'orca', 'FXPopoKVLHeXonysHMEonZZJ4nsUdFqr4RpFuAvLUvFB', 'PYUSD', 'USDe', 100, 1],
    ['solana', 'orca', '5p58XYzEUuvceAb4momaQ943rTPLgigdBXtJNdnZTDJ9', 'USDG', 'USDe', 100, 1],
    ['solana', 'orca', '4fuUiYxTQ6QCrdSq9ouBYcTM7bqSwYTSyLueGZLTy4T4', 'USDC', 'USDT', 100, 1],
  ];

  const PROTOCOLS = {
    v3: { key: 'v3', name: 'Uniswap v3' },
    v4: { key: 'v4', name: 'Uniswap v4' },
    orca: { key: 'orca', name: 'Orca Whirlpools' },
  };

  const POOLS = RAW.map(([chain, proto, address, s0, s1, fee, tickSpacing, hooks]) => {
    const t0 = TOKENS[chain][s0];
    const t1 = TOKENS[chain][s1];
    const a0 = ANCHOR[s0] ?? 99;
    const a1 = ANCHOR[s1] ?? 99;
    const quote = a1 <= a0 ? 1 : 0;
    return {
      key: `${chain}:${address}`,
      chain,
      proto,
      address,
      token0: { sym: s0, addr: t0[0], dec: t0[1] },
      token1: { sym: s1, addr: t1[0], dec: t1[1] },
      fee,
      dynamicFee: proto === 'v4' && fee === DYNAMIC_FEE,
      tickSpacing,
      hooks: hooks || null,
      quote,
      base: 1 - quote,
    };
  });

  window.RADAR_CONFIG = { CHAINS, TOKENS, POOLS, PROTOCOLS, DYNAMIC_FEE };
})();
