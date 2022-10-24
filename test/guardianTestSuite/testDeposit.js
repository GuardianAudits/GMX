const { expect } = require("chai");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const { deployFixture } = require("../../utils/fixture");
const { getOracleParams } = require("../../utils/oracle");
const { printGasUsage } = require("../../utils/gas");
const { expandDecimals, decimalToFloat } = require("../../utils/math");
const { getBalanceOf } = require("../../utils/token");

describe("Guardian Exchange.Deposit", () => {
  const { AddressZero } = ethers.constants;
  const { provider } = ethers;
  const executionFee = "0";

  let wallet, user0, user1, user2, signers, signerIndexes;
  let depositHandler,
    feeReceiver,
    reader,
    dataStore,
    keys,
    depositStore,
    ethUsdMarket,
    weth,
    usdc,
    wbtc,
    router,
    exchangeRouter;
  let oracleSalt;

  beforeEach(async () => {
    const fixture = await loadFixture(deployFixture);
    ({ wallet, user0, user1, user2, signers } = fixture.accounts);
    ({
      router,
      exchangeRouter,
      depositHandler,
      feeReceiver,
      reader,
      dataStore,
      keys,
      depositStore,
      ethUsdMarket,
      weth,
      usdc,
      wbtc,
    } = fixture.contracts);
    ({ oracleSalt, signerIndexes } = fixture.props);
  });

  it("User deposits the long and short token for a market", async () => {
    const wethAmount = expandDecimals(10, 18);
    const usdcAmount = expandDecimals(10 * 5000, 6);

    await weth.mint(user0.address, wethAmount); // 50k
    await usdc.mint(user0.address, usdcAmount); // 50k

    await weth.connect(user0).approve(router.address, wethAmount);
    await usdc.connect(user0).approve(router.address, usdcAmount);

    let block = await provider.getBlock();

    expect(await depositStore.getDepositCount()).eq(0);
    await exchangeRouter
      .connect(user0)
      .createDeposit(
        ethUsdMarket.marketToken,
        weth.address,
        usdc.address,
        wethAmount,
        usdcAmount,
        0,
        false,
        executionFee
      );
    expect(await depositStore.getDepositCount()).eq(1);

    const depositKeys = await depositStore.getDepositKeys(0, 1);
    let deposit = await depositStore.get(depositKeys[0]);

    expect(deposit.account).eq(user0.address);
    expect(deposit.market).eq(ethUsdMarket.marketToken);
    expect(deposit.longTokenAmount).eq(wethAmount);
    expect(deposit.shortTokenAmount).eq(usdcAmount);
    expect(deposit.minMarketTokens).eq(0);
    expect(deposit.updatedAtBlock).eq(block.number + 1);

    block = await provider.getBlock(block.number + 1);
    const oracleBlockNumber = block.number;

    const oracleParams = await getOracleParams({
      oracleSalt,
      oracleBlockNumbers: [oracleBlockNumber, oracleBlockNumber],
      blockHashes: [block.hash, block.hash],
      signerIndexes,
      tokens: [weth.address, usdc.address],
      prices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
      signers,
      priceFeedTokens: [],
    });

    expect(await getBalanceOf(ethUsdMarket.marketToken, user0.address)).eq(0);
    expect(await weth.balanceOf(depositStore.address)).eq(wethAmount);
    expect(await usdc.balanceOf(depositStore.address)).eq(usdcAmount);

    expect(await weth.balanceOf(ethUsdMarket.marketToken)).eq(0);
    expect(await usdc.balanceOf(ethUsdMarket.marketToken)).eq(0);

    await depositHandler.executeDeposit(depositKeys[0], oracleParams);

    expect(await getBalanceOf(ethUsdMarket.marketToken, user0.address)).eq(expandDecimals(100 * 1000, 18)); // We should have 100,000 market tokens
    expect(await weth.balanceOf(depositStore.address)).eq(0);
    expect(await usdc.balanceOf(depositStore.address)).eq(0);

    expect(await weth.balanceOf(ethUsdMarket.marketToken)).eq(wethAmount);
    expect(await usdc.balanceOf(ethUsdMarket.marketToken)).eq(usdcAmount);

    deposit = await depositStore.get(depositKeys[0]);
    expect(deposit.account).eq(AddressZero);
    expect(deposit.market).eq(AddressZero);
    expect(deposit.longTokenAmount).eq(0);
    expect(deposit.shortTokenAmount).eq(0);
    expect(deposit.minMarketTokens).eq(0);
    expect(deposit.updatedAtBlock).eq(0);
  });

  it("User deposits 0 value", async () => {
    let block = await provider.getBlock();
    expect(await depositStore.getDepositCount()).eq(0);
    await exchangeRouter
      .connect(user0)
      .createDeposit(ethUsdMarket.marketToken, weth.address, usdc.address, 0, 0, 0, false, executionFee);
    expect(await depositStore.getDepositCount()).eq(1);

    const depositKeys = await depositStore.getDepositKeys(0, 1);
    let deposit = await depositStore.get(depositKeys[0]);

    expect(deposit.account).eq(user0.address);
    expect(deposit.market).eq(ethUsdMarket.marketToken);
    expect(deposit.longTokenAmount).eq(0);
    expect(deposit.shortTokenAmount).eq(0);
    expect(deposit.minMarketTokens).eq(0);
    expect(deposit.updatedAtBlock).eq(block.number + 1);

    block = await provider.getBlock(block.number + 1);
    const oracleBlockNumber = block.number;

    const oracleParams = await getOracleParams({
      oracleSalt,
      oracleBlockNumbers: [oracleBlockNumber, oracleBlockNumber],
      blockHashes: [block.hash, block.hash],
      signerIndexes,
      tokens: [weth.address, usdc.address],
      prices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
      signers,
      priceFeedTokens: [],
    });

    expect(await getBalanceOf(ethUsdMarket.marketToken, user0.address)).eq(0);
    expect(await weth.balanceOf(depositStore.address)).eq(0);
    expect(await usdc.balanceOf(depositStore.address)).eq(0);

    expect(await weth.balanceOf(ethUsdMarket.marketToken)).eq(0);
    expect(await usdc.balanceOf(ethUsdMarket.marketToken)).eq(0);

    await depositHandler.executeDeposit(depositKeys[0], oracleParams);

    expect(await getBalanceOf(ethUsdMarket.marketToken, user0.address)).eq(0); // We should have 0 market tokens
    expect(await weth.balanceOf(depositStore.address)).eq(0);
    expect(await usdc.balanceOf(depositStore.address)).eq(0);

    expect(await weth.balanceOf(ethUsdMarket.marketToken)).eq(0);
    expect(await usdc.balanceOf(ethUsdMarket.marketToken)).eq(0);

    deposit = await depositStore.get(depositKeys[0]);
    expect(deposit.account).eq(AddressZero);
    expect(deposit.market).eq(AddressZero);
    expect(deposit.longTokenAmount).eq(0);
    expect(deposit.shortTokenAmount).eq(0);
    expect(deposit.minMarketTokens).eq(0);
    expect(deposit.updatedAtBlock).eq(0);
  });

  it("User deposits wrong token", async () => {
    const wbtcAmount = expandDecimals(10, 18);
    const usdcAmount = expandDecimals(10 * 5000, 6);

    await wbtc.mint(user0.address, wbtcAmount); // 50k
    await usdc.mint(user0.address, usdcAmount); // 50k

    await wbtc.connect(user0).approve(router.address, wbtcAmount);
    await usdc.connect(user0).approve(router.address, usdcAmount);

    let block = await provider.getBlock();

    expect(await depositStore.getDepositCount()).eq(0);
    await exchangeRouter
      .connect(user0)
      .createDeposit(
        ethUsdMarket.marketToken,
        wbtc.address,
        usdc.address,
        wbtcAmount,
        usdcAmount,
        0,
        false,
        executionFee
      );
    expect(await depositStore.getDepositCount()).eq(1);

    const depositKeys = await depositStore.getDepositKeys(0, 1);
    let deposit = await depositStore.get(depositKeys[0]);

    expect(deposit.account).eq(user0.address);
    expect(deposit.market).eq(ethUsdMarket.marketToken);
    expect(deposit.longTokenAmount).eq(0);
    expect(deposit.shortTokenAmount).eq(usdcAmount);
    expect(deposit.minMarketTokens).eq(0);
    expect(deposit.updatedAtBlock).eq(block.number + 1);

    block = await provider.getBlock(block.number + 1);
    const oracleBlockNumber = block.number;

    const oracleParams = await getOracleParams({
      oracleSalt,
      oracleBlockNumbers: [oracleBlockNumber, oracleBlockNumber],
      blockHashes: [block.hash, block.hash],
      signerIndexes,
      tokens: [weth.address, usdc.address],
      prices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
      signers,
      priceFeedTokens: [],
    });

    expect(await getBalanceOf(ethUsdMarket.marketToken, user0.address)).eq(0);
    expect(await wbtc.balanceOf(depositStore.address)).eq(wbtcAmount);
    expect(await usdc.balanceOf(depositStore.address)).eq(usdcAmount);
    expect(await weth.balanceOf(depositStore.address)).eq(0);

    expect(await wbtc.balanceOf(ethUsdMarket.marketToken)).eq(0);
    expect(await usdc.balanceOf(ethUsdMarket.marketToken)).eq(0);

    await depositHandler.executeDeposit(depositKeys[0], oracleParams);

    expect(await getBalanceOf(ethUsdMarket.marketToken, user0.address)).eq(expandDecimals(50 * 1000, 18)); // We should have 100,000 market tokens
    expect(await weth.balanceOf(depositStore.address)).eq(0);
    expect(await usdc.balanceOf(depositStore.address)).eq(0);

    expect(await wbtc.balanceOf(ethUsdMarket.marketToken)).eq(0);
    expect(await weth.balanceOf(ethUsdMarket.marketToken)).eq(0);
    expect(await usdc.balanceOf(ethUsdMarket.marketToken)).eq(usdcAmount);

    deposit = await depositStore.get(depositKeys[0]);
    expect(deposit.account).eq(AddressZero);
    expect(deposit.market).eq(AddressZero);
    expect(deposit.longTokenAmount).eq(0);
    expect(deposit.shortTokenAmount).eq(0);
    expect(deposit.minMarketTokens).eq(0);
    expect(deposit.updatedAtBlock).eq(0);

    expect(await wbtc.balanceOf(depositStore.address)).eq(wbtcAmount);
  });

  it("Several users deposit and receive correct amount of market tokens", async () => {
    const wethAmount1 = expandDecimals(10, 18);
    const usdcAmount1 = expandDecimals(10 * 5000, 6);
    const wethAmount2 = expandDecimals(4, 18);
    const usdcAmount2 = expandDecimals(4 * 5000, 6);

    await weth.mint(user0.address, wethAmount1); // 50k
    await usdc.mint(user0.address, usdcAmount1); // 50k
    await weth.mint(user1.address, wethAmount2); // 20k
    await usdc.mint(user1.address, usdcAmount2); // 20k

    await weth.connect(user0).approve(router.address, wethAmount1);
    await usdc.connect(user0).approve(router.address, usdcAmount1);
    await weth.connect(user1).approve(router.address, wethAmount2);
    await usdc.connect(user1).approve(router.address, usdcAmount2);

    let block = await provider.getBlock();
    await exchangeRouter
      .connect(user0)
      .createDeposit(
        ethUsdMarket.marketToken,
        weth.address,
        usdc.address,
        wethAmount1,
        usdcAmount1,
        0,
        false,
        executionFee
      );
    expect(await depositStore.getDepositCount()).eq(1);
    let depositKeys = await depositStore.getDepositKeys(0, 1);
    block = await provider.getBlock(block.number + 1);
    let oracleBlockNumber = block.number;

    let oracleParams = await getOracleParams({
      oracleSalt,
      oracleBlockNumbers: [oracleBlockNumber, oracleBlockNumber],
      blockHashes: [block.hash, block.hash],
      signerIndexes,
      tokens: [weth.address, usdc.address],
      prices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
      signers,
      priceFeedTokens: [],
    });

    await depositHandler.executeDeposit(depositKeys[0], oracleParams);

    block = await provider.getBlock();
    await exchangeRouter
      .connect(user1)
      .createDeposit(
        ethUsdMarket.marketToken,
        weth.address,
        usdc.address,
        wethAmount2,
        usdcAmount2,
        0,
        false,
        executionFee
      );
    expect(await depositStore.getDepositCount()).eq(1);
    depositKeys = await depositStore.getDepositKeys(0, 1);
    block = await provider.getBlock(block.number + 1);
    oracleBlockNumber = block.number;

    oracleParams = await getOracleParams({
      oracleSalt,
      oracleBlockNumbers: [oracleBlockNumber, oracleBlockNumber],
      blockHashes: [block.hash, block.hash],
      signerIndexes,
      tokens: [weth.address, usdc.address],
      prices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
      signers,
      priceFeedTokens: [],
    });
    await depositHandler.executeDeposit(depositKeys[0], oracleParams);

    expect(await getBalanceOf(ethUsdMarket.marketToken, user0.address)).eq(expandDecimals(100 * 1000, 18)); // We should have 100,000 market tokens
    expect(await weth.balanceOf(depositStore.address)).eq(0);
    expect(await usdc.balanceOf(depositStore.address)).eq(0);

    expect(await getBalanceOf(ethUsdMarket.marketToken, user1.address)).eq(expandDecimals(40 * 1000, 18)); // We should have 40,000 market tokens
    expect(await weth.balanceOf(depositStore.address)).eq(0);
    expect(await usdc.balanceOf(depositStore.address)).eq(0);

    expect(await weth.balanceOf(ethUsdMarket.marketToken)).eq(expandDecimals(14, 18));
    expect(await usdc.balanceOf(ethUsdMarket.marketToken)).eq(expandDecimals(70 * 1000, 6));
  });
});
