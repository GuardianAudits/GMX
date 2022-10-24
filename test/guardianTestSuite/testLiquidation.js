const { expect } = require("chai");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const { deployFixture } = require("../../utils/fixture");
const { getOracleParams } = require("../../utils/oracle");
const { printGasUsage } = require("../../utils/gas");
const { bigNumberify, expandDecimals, expandFloatDecimals } = require("../../utils/math");
const { getBalanceOf, getSupplyOf } = require("../../utils/token");
const { OrderType } = require("../../utils/order");
const hre = require("hardhat");
const { network, ethers } = require("hardhat");
const { grantRole } = require("./../../utils/role");

describe("Guardian Exchange.Liquidate", () => {
  const executionFee = "0";
  const { AddressZero, HashZero } = ethers.constants;
  const { provider } = ethers;

  let wallet, user0, user1, user2, signers, signerIndexes;
  let orderHandler,
    depositHandler,
    withdrawalHandler,
    liquidationHandler,
    depositStore,
    withdrawalStore,
    roleStore,
    feeReceiver,
    reader,
    dataStore,
    keys,
    orderStore,
    positionStore,
    ethUsdMarket,
    weth,
    usdc,
    exchangeRouter,
    wbtc;
  let oracleSalt;
  let marketUtils;

  beforeEach(async () => {
    const fixture = await loadFixture(deployFixture);
    ({ wallet, user0, user1, user2, signers } = fixture.accounts);
    ({
      orderHandler,
      depositHandler,
      liquidationHandler,
      withdrawalHandler,
      depositStore,
      roleStore,
      feeReceiver,
      reader,
      dataStore,
      keys,
      orderStore,
      positionStore,
      withdrawalStore,
      ethUsdMarket,
      weth,
      usdc,
      wbtc,
      marketUtils,
      exchangeRouter,
    } = fixture.contracts);
    ({ oracleSalt, signerIndexes } = fixture.props);

    await weth.mint(depositStore.address, expandDecimals(1000, 18));
    await depositHandler
      .connect(wallet)
      .createDeposit(user0.address, ethUsdMarket.marketToken, 100, false, executionFee);
    const depositKeys = await depositStore.getDepositKeys(0, 1);
    const deposit = await depositStore.get(depositKeys[0]);

    let block = await provider.getBlock(deposit.updatedAtBlock.toNumber());

    let oracleParams = await getOracleParams({
      oracleSalt,
      oracleBlockNumbers: [block.number, block.number],
      blockHashes: [block.hash, block.hash],
      signerIndexes,
      tokens: [weth.address, usdc.address],
      prices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
      signers,
      priceFeedTokens: [],
    });

    await depositHandler.executeDeposit(depositKeys[0], oracleParams);
  });

  it("liquidate from MIN_COLLATERAL violation", async () => {
    const initialCollateral = expandDecimals(50000, 6);
    expect(await usdc.balanceOf(user0.address)).to.eq(0);
    await usdc.mint(orderStore.address, initialCollateral); // 50k collateral

    let block = await provider.getBlock();

    expect(await weth.balanceOf(user0.address)).eq(0);

    expect(await orderStore.getOrderCount()).eq(0);
    const params = {
      market: ethUsdMarket.marketToken,
      initialCollateralToken: usdc.address,
      swapPath: [],
      sizeDeltaUsd: expandFloatDecimals(100 * 1000), // 2x leverage
      acceptablePrice: expandDecimals(1000, 12),
      acceptableUsdAdjustment: expandDecimals(-5, 12),
      executionFee: expandDecimals(0, 15),
      minOutputAmount: 0,
      orderType: OrderType.MarketIncrease,
      isLong: true,
      hasCollateralInETH: false,
    };
    await orderHandler.connect(wallet).createOrder(user0.address, params);

    let orderKeys = await orderStore.getOrderKeys(0, 1);

    let order = await orderStore.get(orderKeys[0]);

    let oracleBlockNumber = order.numbers.updatedAtBlock;
    block = await provider.getBlock(oracleBlockNumber.toNumber());

    let oracleParams = await getOracleParams({
      oracleSalt,
      oracleBlockNumbers: [oracleBlockNumber, oracleBlockNumber],
      blockHashes: [block.hash, block.hash],
      signerIndexes,
      tokens: [weth.address, usdc.address],
      prices: [expandDecimals(1000, 4), expandDecimals(1, 6)],
      signers,
      priceFeedTokens: [],
    });

    // Create our position
    await expect(orderHandler.executeOrder(orderKeys[0], oracleParams));

    // Make our position liquidateable via min collateral
    await dataStore.setUint(await keys.MAX_LEVERAGE(), expandFloatDecimals(10000));
    await dataStore.setUint(await keys.MIN_COLLATERAL_USD(), expandFloatDecimals(100 * 1000));

    block = await provider.getBlock();

    let liquidationOracleParams = await getOracleParams({
      oracleSalt,
      oracleBlockNumbers: [block.number, block.number],
      blockHashes: [block.hash, block.hash],
      signerIndexes,
      tokens: [weth.address, usdc.address],
      prices: [expandDecimals(750, 4), expandDecimals(1, 6)],
      signers,
      priceFeedTokens: [],
    });
    await grantRole(roleStore, wallet.address, "LIQUIDATION_KEEPER");

    const poolBalanceBefore = await usdc.balanceOf(ethUsdMarket.marketToken);

    // Liquidate our position
    await liquidationHandler
      .connect(wallet)
      .liquidatePosition(user0.address, ethUsdMarket.marketToken, usdc.address, true, liquidationOracleParams);

    const poolBalanceAfter = await usdc.balanceOf(ethUsdMarket.marketToken);

    expect(poolBalanceAfter).to.eq(poolBalanceBefore.div(2));
    expect(await positionStore.getPositionCount()).eq(0);
    expect(await weth.balanceOf(user0.address)).eq(0);
    expect(await usdc.balanceOf(user0.address)).eq(initialCollateral.div(2));
  });

  it("liquidatePosition reverts for non-liquidatable position", async () => {
    expect(await usdc.balanceOf(user0.address)).to.eq(0);
    await usdc.mint(orderStore.address, expandDecimals(50000, 6));

    let block = await provider.getBlock();

    expect(await weth.balanceOf(user0.address)).eq(0);

    expect(await orderStore.getOrderCount()).eq(0);
    const params = {
      market: ethUsdMarket.marketToken,
      initialCollateralToken: usdc.address,
      swapPath: [],
      sizeDeltaUsd: expandFloatDecimals(100 * 1000), // 2x leverage
      acceptablePrice: expandDecimals(1000, 12),
      acceptableUsdAdjustment: expandDecimals(-5, 12),
      executionFee: expandDecimals(0, 15),
      minOutputAmount: 0,
      orderType: OrderType.MarketIncrease,
      isLong: true,
      hasCollateralInETH: false,
    };
    await orderHandler.connect(wallet).createOrder(user0.address, params);

    let orderKeys = await orderStore.getOrderKeys(0, 1);

    let order = await orderStore.get(orderKeys[0]);

    let oracleBlockNumber = order.numbers.updatedAtBlock;
    block = await provider.getBlock(oracleBlockNumber.toNumber());

    let oracleParams = await getOracleParams({
      oracleSalt,
      oracleBlockNumbers: [oracleBlockNumber, oracleBlockNumber],
      blockHashes: [block.hash, block.hash],
      signerIndexes,
      tokens: [weth.address, usdc.address],
      prices: [expandDecimals(1000, 4), expandDecimals(1, 6)],
      signers,
      priceFeedTokens: [],
    });

    await expect(orderHandler.executeOrder(orderKeys[0], oracleParams));

    await hre.network.provider.send("hardhat_mine", []);
    await hre.network.provider.send("hardhat_mine", []);

    block = await provider.getBlock();

    let liquidationOracleParams = await getOracleParams({
      oracleSalt,
      oracleBlockNumbers: [block.number, block.number],
      blockHashes: [block.hash, block.hash],
      signerIndexes,
      tokens: [weth.address, usdc.address],
      prices: [expandDecimals(1000, 4), expandDecimals(1, 6)],
      signers,
      priceFeedTokens: [],
    });
    await grantRole(roleStore, wallet.address, "LIQUIDATION_KEEPER");

    const poolBalanceBefore = await usdc.balanceOf(ethUsdMarket.marketToken);

    await expect(
      liquidationHandler
        .connect(wallet)
        .liquidatePosition(user0.address, ethUsdMarket.marketToken, usdc.address, true, liquidationOracleParams)
    ).to.be.reverted;

    const poolBalanceAfter = await usdc.balanceOf(ethUsdMarket.marketToken);
    expect(poolBalanceAfter).to.eq(poolBalanceBefore);

    // Position not closed
    expect(await positionStore.getPositionCount()).eq(1);
  });
});
