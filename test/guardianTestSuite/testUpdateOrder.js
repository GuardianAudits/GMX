const { expect } = require("chai");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const { deployFixture } = require("../../utils/fixture");
const { getOracleParams } = require("../../utils/oracle");
const { printGasUsage } = require("../../utils/gas");
const { bigNumberify, expandDecimals, expandFloatDecimals } = require("../../utils/math");
const { getBalanceOf } = require("../../utils/token");
const { OrderType } = require("../../utils/order");

describe("Guardian Exchange.UpdateOrder", () => {
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
    usdc,
    wbtc;
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

  it("order updated properly", async () => {
    await usdc.mint(orderStore.address, expandDecimals(50000, 6));

    let block = await provider.getBlock();

    expect(await orderStore.getOrderCount()).eq(0);
    const params = {
      market: ethUsdMarket.marketToken,
      initialCollateralToken: usdc.address,
      swapPath: [ethUsdMarket.marketToken], // swap USDC for WETH
      sizeDeltaUsd: expandFloatDecimals(200 * 1000),
      acceptablePrice: expandDecimals(5000, 12),
      acceptableUsdAdjustment: expandDecimals(-5, 12),
      executionFee: expandDecimals(0, 15),
      minOutputAmount: expandDecimals(11, 18),
      orderType: OrderType.LimitIncrease,
      isLong: true,
      hasCollateralInETH: false,
    };
    await orderHandler.connect(wallet).createOrder(user0.address, params);

    expect(await orderStore.getOrderCount()).eq(1);

    let orderKeys = await orderStore.getOrderKeys(0, 1);
    let order = await orderStore.get(orderKeys[0]);

    let oracleBlockNumber = order.numbers.updatedAtBlock;
    block = await provider.getBlock(oracleBlockNumber.toNumber());

    await orderHandler
      .connect(user0)
      .updateOrder(orderKeys[0], expandFloatDecimals(100 * 1000), expandDecimals(4500, 12), expandDecimals(-4, 12));

    orderKeys = await orderStore.getOrderKeys(0, 1);
    order = await orderStore.get(orderKeys[0]);

    expect(order.numbers.sizeDeltaUsd).to.eq(expandFloatDecimals(100 * 1000));
    expect(order.numbers.acceptablePrice).to.eq(expandDecimals(4500, 12));
    expect(order.numbers.acceptableUsdAdjustment).to.eq(expandDecimals(-4, 12));
    expect(order.numbers.updatedAtBlock).to.gt(oracleBlockNumber);

    oracleBlockNumber = order.numbers.updatedAtBlock;
    block = await provider.getBlock(oracleBlockNumber.toNumber());

    let oracleParams = await getOracleParams({
      oracleSalt,
      oracleBlockNumbers: [oracleBlockNumber, oracleBlockNumber],
      blockHashes: [block.hash, block.hash],
      signerIndexes,
      tokens: [weth.address, usdc.address],
      prices: [expandDecimals(4000, 4), expandDecimals(1, 6)],
      signers,
      priceFeedTokens: [],
    });

    const tx0 = await orderHandler.executeOrder(orderKeys[0], oracleParams);
  });
});
