// THE FRONG POOL — page configuration. Everything address-shaped for the pool
// lives here and ONLY here; pool.js is generic (any ERC20, any OfficePool) and
// reads nothing from the URL. `pool` empty = the page says the pool has not
// opened and does nothing else. index.html loads this too, for the hero line.
window.POOL_CFG = {
  pool: "0x16f2D383e1C09d48568c882CD1B323B99f592842",        // OfficePool for FRONG — deployed 2026-09-06, block 55666061 (SeedBox 0x3A4e…F612)
  token: "0x6245e67affA44a23077f0Ea7f981a8DC743a0c47",        // FRONG (verified: symbol FRONG, 18 decimals, supply 1e27)
  symbol: "FRONG",
  decimals: 18,                                               // asserted against decimals() on the chain; a mismatch disables the desk
  name: "The Frong Pool",
  chainHex: "0x1237", chainName: "Robinhood Chain",           // 4663
  rpc: ["https://rpc.mainnet.chain.robinhood.com", "https://robinhood-rpc.publicnode.com"],
  explorer: "https://robinhoodchain.blockscout.com",
  boost: false,                                               // no NFT boost: pure deposit-weighted odds; the broker desk is not built
  bell: "4 PM New York",
  buyUrl: "https://pools.trade/token/0x6245e67affA44a23077f0Ea7f981a8DC743a0c47", // where FRONG launched; the ONE buy link the page ever shows
  tg: "",                                                     // the community chat, optional (shown in the footer when set)
  presets: [1000, 2500, 5000, 10000, 25000],                  // whole tokens
  // USD per token, optional: the ledger's live DexScreener price (app.js keeps it in S.livePrice).
  price: () => (typeof S === "object" && S && S.livePrice) || null,
  copy: {
    connect: "CONNECT WALLET",
    post: "i'm in the frong pool: {jackpot} FRONG jackpot today. one takes it, one gets their money back. chip in before the 4 PM New York bell.\n\n{link}",
    rulesHref: "/methodology#pool",
  },
};
