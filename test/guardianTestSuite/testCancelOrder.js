const { expect } = require("chai");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const { deployFixture } = require("../../utils/fixture");
const { getOracleParams } = require("../../utils/oracle");
const { bigNumberify, expandDecimals, expandFloatDecimals } = require("../../utils/math");
const { OrderType } = require("../../utils/order");
const { ethers } = require("hardhat");
const hre = require("hardhat");

describe("Guardian Exchange.CancelOrder", () => {
  const executionFee = "1000000000000000";
  const { AddressZero, HashZero } = ethers.constants;
  const { provider } = ethers;

  let wallet, user0, user1, user2, signers, signerIndexes;
  let orderHandler,
    depositHandler,
    depositStore,
    feeReceiver,
    reader,
    dataStore,
    keys,
    orderStore,
    positionStore,
    ethUsdMarket,
    weth,
    usdc;
  let oracleSalt;

  beforeEach(async () => {
    const fixture = await loadFixture(deployFixture);
    ({ wallet, user0, user1, user2, signers } = fixture.accounts);
    ({
      orderHandler,
      depositHandler,
      depositStore,
      feeReceiver,
      reader,
      dataStore,
      keys,
      orderStore,
      positionStore,
      ethUsdMarket,
      weth,
      usdc,
      wbtc,
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

  it("Cancelled order cannot be executed", async () => {
    await usdc.mint(orderStore.address, expandDecimals(50000, 6));

    let block = await provider.getBlock();

    expect(await weth.balanceOf(user0.address)).eq(0);

    expect(await orderStore.getOrderCount()).eq(0);
    const params = {
      market: ethUsdMarket.marketToken,
      initialCollateralToken: usdc.address,
      swapPath: [],
      sizeDeltaUsd: expandFloatDecimals(100 * 1000),
      acceptablePrice: expandDecimals(1000, 12),
      acceptableUsdAdjustment: expandDecimals(-5, 12),
      executionFee: expandDecimals(0, 15),
      minOutputAmount: 0,
      orderType: OrderType.LimitIncrease,
      isLong: true,
      hasCollateralInETH: false,
    };
    await orderHandler.connect(wallet).createOrder(user0.address, params);

    let orderKeys = await orderStore.getOrderKeys(0, 1);

    let order = await orderStore.get(orderKeys[0]);

    let oracleBlockNumber = order.numbers.updatedAtBlock;
    block = await provider.getBlock(oracleBlockNumber.toNumber());

    oracleParams = await getOracleParams({
      oracleSalt,
      oracleBlockNumbers: [oracleBlockNumber, oracleBlockNumber],
      blockHashes: [block.hash, block.hash],
      signerIndexes,
      tokens: [weth.address, usdc.address],
      prices: [expandDecimals(1000, 4), expandDecimals(1, 6)],
      signers,
      priceFeedTokens: [],
    });

    await orderHandler.connect(user0).cancelOrder(orderKeys[0]);

    expect(await orderStore.getOrderCount()).eq(0);

    await expect(orderHandler.executeOrder(orderKeys[0], oracleParams)).to.be.reverted;
  });
});
