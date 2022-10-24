const { expect } = require("chai");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const { deployFixture } = require("../../utils/fixture");
const { getOracleParams } = require("../../utils/oracle");
const { printGasUsage } = require("../../utils/gas");
const { bigNumberify, expandDecimals, expandFloatDecimals } = require("../../utils/math");
const { getBalanceOf } = require("../../utils/token");
const { OrderType } = require("../../utils/order");
const { ethers } = require("hardhat");
const hre = require("hardhat");

describe("Guardian Exchange.ExecuteOrder", () => {
  const executionFee = "1000000000000000";
  const { AddressZero, HashZero } = ethers.constants;
  const { provider } = ethers;

  let wallet, user0, user1, user2, signers, signerIndexes;
  let orderHandler,
    depositHandler,
    withdrawalHandler,
    depositStore,
    withdrawalStore,
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
      withdrawalHandler,
      depositStore,
      withdrawalStore,
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

  it("Can retry market increase order", async () => {
    await usdc.mint(orderStore.address, expandDecimals(50000, 6));

    expect(await orderStore.getOrderCount()).eq(0);
    const params = {
      market: ethUsdMarket.marketToken,
      initialCollateralToken: usdc.address,
      swapPath: [ethUsdMarket.marketToken],
      sizeDeltaUsd: expandFloatDecimals(200 * 1000),
      acceptablePrice: expandDecimals(5000, 12),
      acceptableUsdAdjustment: expandDecimals(-5, 12),
      executionFee: expandDecimals(0, 15),
      minOutputAmount: expandDecimals(11, 18),
      orderType: OrderType.MarketIncrease,
      isLong: true,
      hasCollateralInETH: false,
    };
    await orderHandler.connect(wallet).createOrder(user0.address, params);

    expect(await orderStore.getOrderCount()).eq(1);

    let orderKeys = await orderStore.getOrderKeys(0, 1);
    let order = await orderStore.get(orderKeys[0]);

    let oracleBlockNumber = order.numbers.updatedAtBlock;
    let block = await provider.getBlock(oracleBlockNumber.toNumber());

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

    await expect(orderHandler.executeOrder(orderKeys[0], oracleParams)).to.be.revertedWith(
      "INSUFFICIENT_SWAP_OUTPUT_AMOUNT_ERROR"
    );

    oracleParams = await getOracleParams({
      oracleSalt,
      oracleBlockNumbers: [oracleBlockNumber, oracleBlockNumber],
      blockHashes: [block.hash, block.hash],
      signerIndexes,
      tokens: [weth.address, usdc.address],
      prices: [expandDecimals(4000, 4), expandDecimals(1, 6)],
      signers,
      priceFeedTokens: [],
    });
    // Min swap amount should now be reached
    expect(await orderStore.getOrderCount()).eq(1);
  });

  it("collateral token not in market cancels order", async () => {
    await wbtc.mint(orderStore.address, expandDecimals(2, 6));

    expect(await orderStore.getOrderCount()).eq(0);
    const params = {
      market: ethUsdMarket.marketToken,
      initialCollateralToken: wbtc.address,
      swapPath: [],
      sizeDeltaUsd: expandFloatDecimals(200 * 1000),
      acceptablePrice: expandDecimals(5000, 12),
      acceptableUsdAdjustment: expandDecimals(-5, 12),
      executionFee: expandDecimals(0, 15),
      minOutputAmount: expandDecimals(0, 18),
      orderType: OrderType.MarketIncrease,
      isLong: true,
      hasCollateralInETH: false,
    };
    await orderHandler.connect(wallet).createOrder(user0.address, params);

    expect(await orderStore.getOrderCount()).eq(1);

    let orderKeys = await orderStore.getOrderKeys(0, 1);
    let order = await orderStore.get(orderKeys[0]);

    let oracleBlockNumber = order.numbers.updatedAtBlock;
    let block = await provider.getBlock(oracleBlockNumber.toNumber());

    let oracleParams = await getOracleParams({
      oracleSalt,
      oracleBlockNumbers: [oracleBlockNumber, oracleBlockNumber, oracleBlockNumber],
      blockHashes: [block.hash, block.hash, block.hash],
      signerIndexes,
      tokens: [weth.address, usdc.address, wbtc.address],
      prices: [expandDecimals(4500, 4), expandDecimals(1, 6), expandDecimals(50000, 2)],
      signers,
      priceFeedTokens: [],
    });

    await orderHandler.executeOrder(orderKeys[0], oracleParams);
    expect(await orderStore.getOrderCount()).eq(0);
    expect(await positionStore.getPositionCount()).to.eq(0);
  });

  it("surpass pool amount long reverts", async () => {
    await weth.mint(orderStore.address, expandDecimals(10, 18));

    expect(await orderStore.getOrderCount()).eq(0);
    const params = {
      market: ethUsdMarket.marketToken,
      initialCollateralToken: weth.address,
      swapPath: [],
      sizeDeltaUsd: expandFloatDecimals(5000 * 1000),
      acceptablePrice: expandDecimals(5001, 12),
      acceptableUsdAdjustment: expandDecimals(-5, 12),
      executionFee: expandDecimals(1, 15),
      minOutputAmount: expandDecimals(50000, 6),
      orderType: OrderType.MarketIncrease,
      isLong: true,
      hasCollateralInETH: false,
    };
    await orderHandler.connect(wallet).createOrder(user0.address, params);

    expect(await orderStore.getOrderCount()).eq(1);

    let orderKeys = await orderStore.getOrderKeys(0, 1);
    let order = await orderStore.get(orderKeys[0]);

    let oracleBlockNumber = order.numbers.updatedAtBlock;
    let block = await provider.getBlock(oracleBlockNumber.toNumber());

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

    await expect(orderHandler.executeOrder(orderKeys[0], oracleParams)).to.be.reverted;
  });

  it("surpass pool amount short reverts", async () => {
    await weth.mint(orderStore.address, expandDecimals(10, 18));

    expect(await orderStore.getOrderCount()).eq(0);
    const params = {
      market: ethUsdMarket.marketToken,
      initialCollateralToken: weth.address,
      swapPath: [],
      sizeDeltaUsd: expandFloatDecimals(5000 * 1000),
      acceptablePrice: expandDecimals(5001, 12),
      acceptableUsdAdjustment: expandDecimals(-5, 12),
      executionFee: expandDecimals(1, 15),
      minOutputAmount: expandDecimals(50000, 6),
      orderType: OrderType.MarketIncrease,
      isLong: false,
      hasCollateralInETH: false,
    };
    await orderHandler.connect(wallet).createOrder(user0.address, params);

    expect(await orderStore.getOrderCount()).eq(1);

    let orderKeys = await orderStore.getOrderKeys(0, 1);
    let order = await orderStore.get(orderKeys[0]);

    let oracleBlockNumber = order.numbers.updatedAtBlock;
    let block = await provider.getBlock(oracleBlockNumber.toNumber());

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

    await expect(orderHandler.executeOrder(orderKeys[0], oracleParams)).to.be.reverted;
  });

  it("Executes a market increase, decrease position by half, decrease to 0, close position", async () => {
    await usdc.mint(orderStore.address, expandDecimals(50000, 6));

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
      orderType: OrderType.MarketIncrease,
      isLong: true,
      hasCollateralInETH: false,
    };
    await orderHandler.connect(wallet).createOrder(user0.address, params);

    let orderKeys = await orderStore.getOrderKeys(0, 1);

    let order = await orderStore.get(orderKeys[0]);

    let oracleBlockNumber = order.numbers.updatedAtBlock;
    let block = await provider.getBlock(oracleBlockNumber.toNumber());

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

    // Open initial position
    await orderHandler.executeOrder(orderKeys[0], oracleParams);

    let posKeys = await positionStore.getPositionKeys(0, 1);
    let pos = await positionStore.get(posKeys[0]);
    expect(pos.sizeInUsd).to.eq(expandFloatDecimals(100 * 1000));

    const firstDecreaseParams = {
      market: ethUsdMarket.marketToken,
      initialCollateralToken: usdc.address,
      swapPath: [],
      sizeDeltaUsd: expandFloatDecimals(50 * 1000),
      acceptablePrice: expandDecimals(1000, 12),
      acceptableUsdAdjustment: expandDecimals(-5, 12),
      executionFee: expandDecimals(0, 15),
      minOutputAmount: 0,
      orderType: OrderType.MarketDecrease,
      isLong: true,
      hasCollateralInETH: false,
    };

    await orderHandler.connect(wallet).createOrder(user0.address, firstDecreaseParams);

    orderKeys = await orderStore.getOrderKeys(0, 1);

    order = await orderStore.get(orderKeys[0]);

    let firstDecreaseOracleBlockNumber = order.numbers.updatedAtBlock;
    let firstDecreaseBlock = await provider.getBlock(firstDecreaseOracleBlockNumber.toNumber());

    let firstDecreaseOracleParams = await getOracleParams({
      oracleSalt,
      oracleBlockNumbers: [firstDecreaseOracleBlockNumber, firstDecreaseOracleBlockNumber],
      blockHashes: [firstDecreaseBlock.hash, firstDecreaseBlock.hash],
      signerIndexes,
      tokens: [weth.address, usdc.address],
      prices: [expandDecimals(1000, 4), expandDecimals(1, 6)],
      signers,
      priceFeedTokens: [],
    });

    // Decrease position by half
    await orderHandler.executeOrder(orderKeys[0], firstDecreaseOracleParams);
    posKeys = await positionStore.getPositionKeys(0, 1);
    pos = await positionStore.get(posKeys[0]);
    expect(pos.sizeInUsd).to.eq(expandFloatDecimals(50 * 1000));

    const secondDecreaseParams = {
      market: ethUsdMarket.marketToken,
      initialCollateralToken: usdc.address,
      swapPath: [],
      sizeDeltaUsd: expandFloatDecimals(50 * 1000),
      acceptablePrice: expandDecimals(1000, 12),
      acceptableUsdAdjustment: expandDecimals(-5, 12),
      executionFee: expandDecimals(0, 15),
      minOutputAmount: 0,
      orderType: OrderType.MarketDecrease,
      isLong: true,
      hasCollateralInETH: false,
    };

    await orderHandler.connect(wallet).createOrder(user0.address, secondDecreaseParams);

    orderKeys = await orderStore.getOrderKeys(0, 1);

    order = await orderStore.get(orderKeys[0]);

    let secondDecreaseOracleBlockNumber = order.numbers.updatedAtBlock;
    let secondDecreaseBlock = await provider.getBlock(secondDecreaseOracleBlockNumber.toNumber());

    let secondDecreaseOracleParams = await getOracleParams({
      oracleSalt,
      oracleBlockNumbers: [secondDecreaseOracleBlockNumber, secondDecreaseOracleBlockNumber],
      blockHashes: [secondDecreaseBlock.hash, secondDecreaseBlock.hash],
      signerIndexes,
      tokens: [weth.address, usdc.address],
      prices: [expandDecimals(1000, 4), expandDecimals(1, 6)],
      signers,
      priceFeedTokens: [],
    });

    // Decrease remainder of position
    await orderHandler.executeOrder(orderKeys[0], secondDecreaseOracleParams);
    // Verify position is closed
    expect(await positionStore.getPositionCount()).to.eq(0);
  });

  it("Executes a limit increase, decrease position by half, decrease to 0, close position", async () => {
    await usdc.mint(orderStore.address, expandDecimals(50000, 6));

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
    let block = await provider.getBlock(oracleBlockNumber.toNumber());

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

    // Open initial position
    await orderHandler.executeOrder(orderKeys[0], oracleParams);

    let posKeys = await positionStore.getPositionKeys(0, 1);
    let pos = await positionStore.get(posKeys[0]);
    expect(pos.sizeInUsd).to.eq(expandFloatDecimals(100 * 1000));

    const firstDecreaseParams = {
      market: ethUsdMarket.marketToken,
      initialCollateralToken: usdc.address,
      swapPath: [],
      sizeDeltaUsd: expandFloatDecimals(50 * 1000),
      acceptablePrice: expandDecimals(1000, 12),
      acceptableUsdAdjustment: expandDecimals(-5, 12),
      executionFee: expandDecimals(0, 15),
      minOutputAmount: 0,
      orderType: OrderType.LimitDecrease,
      isLong: true,
      hasCollateralInETH: false,
    };

    await orderHandler.connect(wallet).createOrder(user0.address, firstDecreaseParams);

    orderKeys = await orderStore.getOrderKeys(0, 1);

    order = await orderStore.get(orderKeys[0]);

    await hre.network.provider.send("hardhat_mine", []);

    block = await provider.getBlock();

    let firstDecreaseOracleParams = await getOracleParams({
      oracleSalt,
      oracleBlockNumbers: [block.number, block.number],
      blockHashes: [block.hash, block.hash],
      signerIndexes,
      tokens: [weth.address, usdc.address],
      prices: [expandDecimals(1000, 4), expandDecimals(1, 6)],
      signers,
      priceFeedTokens: [],
    });

    // Decrease position by half
    await orderHandler.executeOrder(orderKeys[0], firstDecreaseOracleParams);
    posKeys = await positionStore.getPositionKeys(0, 1);
    pos = await positionStore.get(posKeys[0]);
    expect(pos.sizeInUsd).to.eq(expandFloatDecimals(50 * 1000));

    const secondDecreaseParams = {
      market: ethUsdMarket.marketToken,
      initialCollateralToken: usdc.address,
      swapPath: [],
      sizeDeltaUsd: expandFloatDecimals(50 * 1000),
      acceptablePrice: expandDecimals(1000, 12),
      acceptableUsdAdjustment: expandDecimals(-5, 12),
      executionFee: expandDecimals(0, 15),
      minOutputAmount: 0,
      orderType: OrderType.LimitDecrease,
      isLong: true,
      hasCollateralInETH: false,
    };

    await orderHandler.connect(wallet).createOrder(user0.address, secondDecreaseParams);

    orderKeys = await orderStore.getOrderKeys(0, 1);

    order = await orderStore.get(orderKeys[0]);

    await hre.network.provider.send("hardhat_mine", []);

    block = await provider.getBlock();

    let secondDecreaseOracleParams = await getOracleParams({
      oracleSalt,
      oracleBlockNumbers: [block.number, block.number],
      blockHashes: [block.hash, block.hash],
      signerIndexes,
      tokens: [weth.address, usdc.address],
      prices: [expandDecimals(1000, 4), expandDecimals(1, 6)],
      signers,
      priceFeedTokens: [],
    });

    // Decrease remainder of position
    await orderHandler.executeOrder(orderKeys[0], secondDecreaseOracleParams);
    // Verify position is closed
    expect(await positionStore.getPositionCount()).to.eq(0);
  });

  it("Executes limit swap order", async () => {
    await usdc.mint(orderStore.address, expandDecimals(50000, 6));

    expect(await weth.balanceOf(user0.address)).eq(0);

    expect(await orderStore.getOrderCount()).eq(0);
    const params = {
      market: ethers.constants.AddressZero,
      initialCollateralToken: usdc.address,
      swapPath: [ethUsdMarket.marketToken],
      sizeDeltaUsd: 0,
      acceptablePrice: expandDecimals(1000, 12),
      acceptableUsdAdjustment: expandDecimals(-5, 12),
      executionFee: expandDecimals(0, 15),
      minOutputAmount: 0,
      orderType: OrderType.LimitSwap,
      isLong: true,
      hasCollateralInETH: false,
    };
    await orderHandler.connect(wallet).createOrder(user0.address, params);

    let orderKeys = await orderStore.getOrderKeys(0, 1);

    await hre.network.provider.send("hardhat_mine", []);

    let block = await provider.getBlock();

    oracleParams = await getOracleParams({
      oracleSalt,
      oracleBlockNumbers: [block.number, block.number],
      blockHashes: [block.hash, block.hash],
      signerIndexes,
      tokens: [weth.address, usdc.address],
      prices: [expandDecimals(1000, 4), expandDecimals(1, 6)],
      signers,
      priceFeedTokens: [],
    });

    await orderHandler.executeOrder(orderKeys[0], oracleParams);

    expect(await weth.balanceOf(user0.address)).eq(expandDecimals(50, 18));
  });

  it("Executes a market swap order", async () => {
    await usdc.mint(orderStore.address, expandDecimals(50000, 6));

    expect(await weth.balanceOf(user0.address)).eq(0);

    expect(await orderStore.getOrderCount()).eq(0);
    const params = {
      market: ethers.constants.AddressZero,
      initialCollateralToken: usdc.address,
      swapPath: [ethUsdMarket.marketToken],
      sizeDeltaUsd: 0,
      acceptablePrice: 0,
      acceptableUsdAdjustment: expandDecimals(-5, 12),
      executionFee: expandDecimals(0, 15),
      minOutputAmount: 0,
      orderType: OrderType.MarketSwap,
      isLong: true,
      hasCollateralInETH: false,
    };
    await orderHandler.connect(wallet).createOrder(user0.address, params);

    let orderKeys = await orderStore.getOrderKeys(0, 1);

    let order = await orderStore.get(orderKeys[0]);

    let oracleBlockNumber = order.numbers.updatedAtBlock;
    let block = await provider.getBlock(oracleBlockNumber.toNumber());

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

    await orderHandler.executeOrder(orderKeys[0], oracleParams);

    expect(await weth.balanceOf(user0.address)).eq(expandDecimals(50, 18));
  });

  it("Execute stop-loss on long position", async () => {
    await weth.mint(orderStore.address, expandDecimals(10, 18));
    expect(await weth.balanceOf(user0.address)).eq(0);
    expect(await orderStore.getOrderCount()).eq(0);

    const params = {
      market: ethUsdMarket.marketToken,
      initialCollateralToken: weth.address,
      swapPath: [],
      sizeDeltaUsd: expandFloatDecimals(50000),
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
    let block = await provider.getBlock(oracleBlockNumber.toNumber());

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

    // Open initial position
    await orderHandler.executeOrder(orderKeys[0], oracleParams);

    let posKeys = await positionStore.getPositionKeys(0, 1);
    let pos = await positionStore.get(posKeys[0]);
    expect(pos.sizeInUsd).to.eq(expandFloatDecimals(50 * 1000));

    const firstDecreaseParams = {
      market: ethUsdMarket.marketToken,
      initialCollateralToken: weth.address,
      swapPath: [],
      sizeDeltaUsd: expandFloatDecimals(50000),
      acceptablePrice: expandDecimals(4000, 12),
      acceptableUsdAdjustment: expandDecimals(-5, 12),
      executionFee: expandDecimals(0, 15),
      minOutputAmount: 0,
      orderType: OrderType.StopLossDecrease,
      isLong: true,
      hasCollateralInETH: false,
    };

    await orderHandler.connect(wallet).createOrder(user0.address, firstDecreaseParams);
    orderKeys = await orderStore.getOrderKeys(0, 1);
    order = await orderStore.get(orderKeys[0]);

    let firstDecreaseOracleBlockNumber = order.numbers.updatedAtBlock.add(1);
    await hre.network.provider.send("hardhat_mine", ["0x14"]); // move forward 20 blocks
    let firstDecreaseBlock = await provider.getBlock(firstDecreaseOracleBlockNumber.toNumber());

    let firstDecreaseOracleParams = await getOracleParams({
      oracleSalt,
      oracleBlockNumbers: [
        firstDecreaseOracleBlockNumber,
        firstDecreaseOracleBlockNumber,
        firstDecreaseOracleBlockNumber,
      ],
      blockHashes: [firstDecreaseBlock.hash, firstDecreaseBlock.hash, firstDecreaseBlock.hash],
      signerIndexes,
      tokens: [weth.address, weth.address, usdc.address],
      prices: [expandDecimals(4001, 4), expandDecimals(3999, 4), expandDecimals(1, 6)],
      signers,
      priceFeedTokens: [],
    });

    let wethBalanceBefore = await weth.balanceOf(user0.address);
    await orderHandler.executeOrder(orderKeys[0], firstDecreaseOracleParams);
    posKeys = await positionStore.getPositionKeys(0, 1);
    expect(posKeys.length).to.eq(0);
    let wethBalanceAfter = await weth.balanceOf(user0.address);
    // Lost about 2.5 ETH
    expect(Number(ethers.utils.formatUnits(wethBalanceAfter.sub(wethBalanceBefore), 18))).to.gt(7.5);
    expect(Number(ethers.utils.formatUnits(wethBalanceAfter.sub(wethBalanceBefore), 18))).to.lt(7.6);
  });

  it("Execute stop-loss on short position", async () => {
    // Have enough USDC to back shorts
    await usdc.mint(depositStore.address, expandDecimals(100000000, 6));
    await depositHandler.connect(wallet).createDeposit(user1.address, ethUsdMarket.marketToken, 100, false, 0);
    const depositKeys = await depositStore.getDepositKeys(0, 1);
    const deposit = await depositStore.get(depositKeys[0]);

    let depositBlock = await provider.getBlock(deposit.updatedAtBlock.toNumber());

    let depositOracleParams = await getOracleParams({
      oracleSalt,
      oracleBlockNumbers: [depositBlock.number, depositBlock.number],
      blockHashes: [depositBlock.hash, depositBlock.hash],
      signerIndexes,
      tokens: [weth.address, usdc.address],
      prices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
      signers,
      priceFeedTokens: [],
    });

    await depositHandler.executeDeposit(depositKeys[0], depositOracleParams);
    //********************************************************************* */

    await weth.mint(orderStore.address, expandDecimals(10, 18));
    let block = await provider.getBlock();
    expect(await weth.balanceOf(user0.address)).eq(0);
    expect(await orderStore.getOrderCount()).eq(0);

    const params = {
      market: ethUsdMarket.marketToken,
      initialCollateralToken: weth.address,
      swapPath: [],
      sizeDeltaUsd: expandFloatDecimals(50000),
      acceptablePrice: expandDecimals(1000, 12),
      acceptableUsdAdjustment: expandDecimals(-5, 12),
      executionFee: expandDecimals(0, 15),
      minOutputAmount: 0,
      orderType: OrderType.MarketIncrease,
      isLong: false,
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
      prices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
      signers,
      priceFeedTokens: [],
    });

    expect(await reader.getPoolAmount(dataStore.address, ethUsdMarket.marketToken, usdc.address)).eq(
      expandDecimals(100000000, 6)
    );

    // Open initial position
    await orderHandler.executeOrder(orderKeys[0], oracleParams);

    let posKeys = await positionStore.getPositionKeys(0, 1);
    let pos = await positionStore.get(posKeys[0]);
    expect(pos.sizeInUsd).to.eq(expandFloatDecimals(50 * 1000));

    const firstDecreaseParams = {
      market: ethUsdMarket.marketToken,
      initialCollateralToken: weth.address,
      swapPath: [],
      sizeDeltaUsd: expandFloatDecimals(50000),
      acceptablePrice: expandDecimals(6000, 12),
      acceptableUsdAdjustment: expandDecimals(-5, 12),
      executionFee: expandDecimals(0, 15),
      minOutputAmount: 0,
      orderType: OrderType.StopLossDecrease,
      isLong: false,
      hasCollateralInETH: false,
    };

    await orderHandler.connect(wallet).createOrder(user0.address, firstDecreaseParams);
    orderKeys = await orderStore.getOrderKeys(0, 1);
    order = await orderStore.get(orderKeys[0]);

    let firstDecreaseOracleBlockNumber = order.numbers.updatedAtBlock.add(1);
    await hre.network.provider.send("hardhat_mine", ["0x14"]); // move forward 20 blocks
    let firstDecreaseBlock = await provider.getBlock(firstDecreaseOracleBlockNumber.toNumber());

    let firstDecreaseOracleParams = await getOracleParams({
      oracleSalt,
      oracleBlockNumbers: [
        firstDecreaseOracleBlockNumber,
        firstDecreaseOracleBlockNumber,
        firstDecreaseOracleBlockNumber,
      ],
      blockHashes: [firstDecreaseBlock.hash, firstDecreaseBlock.hash, firstDecreaseBlock.hash],
      signerIndexes,
      tokens: [weth.address, weth.address, usdc.address],
      prices: [expandDecimals(5999, 4), expandDecimals(6001, 4), expandDecimals(1, 6)],
      signers,
      priceFeedTokens: [],
    });

    let wethBalanceBefore = await weth.balanceOf(user0.address);
    await orderHandler.executeOrder(orderKeys[0], firstDecreaseOracleParams);
    posKeys = await positionStore.getPositionKeys(0, 1);
    expect(posKeys.length).to.eq(0);
    let wethBalanceAfter = await weth.balanceOf(user0.address);
    // Lost about 1.67 ETH
    expect(Number(ethers.utils.formatUnits(wethBalanceAfter.sub(wethBalanceBefore), 18))).to.gt(8.3);
    expect(Number(ethers.utils.formatUnits(wethBalanceAfter.sub(wethBalanceBefore), 18))).to.lt(8.4);
  });

  it("Decrease overcollaterlized position", async () => {
    await weth.mint(depositStore.address, expandDecimals(10000, 18));
    await usdc.mint(depositStore.address, expandDecimals(10000000000, 6));
    await depositHandler.connect(wallet).createDeposit(user1.address, ethUsdMarket.marketToken, 100, false, 0);
    const depositKeys = await depositStore.getDepositKeys(0, 1);
    const deposit = await depositStore.get(depositKeys[0]);

    let depositBlock = await provider.getBlock(deposit.updatedAtBlock.toNumber());

    let depositOracleParams = await getOracleParams({
      oracleSalt,
      oracleBlockNumbers: [depositBlock.number, depositBlock.number],
      blockHashes: [depositBlock.hash, depositBlock.hash],
      signerIndexes,
      tokens: [weth.address, usdc.address],
      prices: [expandDecimals(2000, 4), expandDecimals(1, 6)],
      signers,
      priceFeedTokens: [],
    });

    await depositHandler.executeDeposit(depositKeys[0], depositOracleParams);
    //************************************************************** */

    expect(await usdc.balanceOf(user0.address)).to.eq(0);
    await usdc.mint(orderStore.address, expandDecimals(50000, 6));

    let block = await provider.getBlock();

    expect(await weth.balanceOf(user0.address)).eq(0);

    expect(await orderStore.getOrderCount()).eq(0);
    const params = {
      market: ethUsdMarket.marketToken,
      initialCollateralToken: usdc.address,
      swapPath: [],
      sizeDeltaUsd: expandFloatDecimals(50 * 1000),
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

    // Open initial position
    await orderHandler.executeOrder(orderKeys[0], oracleParams);

    let posKeys = await positionStore.getPositionKeys(0, 1);
    let pos = await positionStore.get(posKeys[0]);
    expect(pos.sizeInUsd).to.eq(expandFloatDecimals(50 * 1000));

    const firstDecreaseParams = {
      market: ethUsdMarket.marketToken,
      initialCollateralToken: usdc.address,
      swapPath: [],
      sizeDeltaUsd: expandFloatDecimals(49 * 1000),
      acceptablePrice: expandDecimals(1000, 12),
      acceptableUsdAdjustment: expandDecimals(-5, 12),
      executionFee: expandDecimals(0, 15),
      minOutputAmount: 0,
      orderType: OrderType.MarketDecrease,
      isLong: true,
      hasCollateralInETH: false,
    };

    await orderHandler.connect(wallet).createOrder(user0.address, firstDecreaseParams);

    orderKeys = await orderStore.getOrderKeys(0, 1);

    order = await orderStore.get(orderKeys[0]);

    let firstDecreaseOracleBlockNumber = order.numbers.updatedAtBlock;
    let firstDecreaseBlock = await provider.getBlock(firstDecreaseOracleBlockNumber.toNumber());

    let firstDecreaseOracleParams = await getOracleParams({
      oracleSalt,
      oracleBlockNumbers: [firstDecreaseOracleBlockNumber, firstDecreaseOracleBlockNumber],
      blockHashes: [firstDecreaseBlock.hash, firstDecreaseBlock.hash],
      signerIndexes,
      tokens: [weth.address, usdc.address],
      prices: [expandDecimals(1000, 4), expandDecimals(1, 6)],
      signers,
      priceFeedTokens: [],
    });

    // Decrease position by 98% (49,000/50,000)
    await orderHandler.executeOrder(orderKeys[0], firstDecreaseOracleParams);
    posKeys = await positionStore.getPositionKeys(0, 1);
    pos = await positionStore.get(posKeys[0]);
    // 50k collateral and our position is 1k
    expect(pos.collateralAmount).to.eq("50000000000"); // $50,000 USD
    expect(pos.sizeInUsd).to.eq(expandFloatDecimals(1000));

    // *************** NOW LET'S MAKE ANOTHER DECREASE ***********************

    // Verify we can't lose more collateral than intended
    const paramsDecrease = {
      market: ethUsdMarket.marketToken,
      initialCollateralToken: usdc.address,
      swapPath: [],
      sizeDeltaUsd: expandFloatDecimals(10000),
      acceptablePrice: expandDecimals(5000, 12),
      acceptableUsdAdjustment: expandDecimals(-5, 12),
      executionFee: expandDecimals(0, 15),
      minOutputAmount: expandDecimals(0, 18),
      orderType: OrderType.MarketDecrease,
      isLong: true,
      hasCollateralInETH: false,
    };
    await orderHandler.connect(wallet).createOrder(user0.address, paramsDecrease);
    expect(await orderStore.getOrderCount()).eq(1);
    orderKeys = await orderStore.getOrderKeys(0, 1);
    order = await orderStore.get(orderKeys[0]);

    oracleBlockNumber = order.numbers.updatedAtBlock;
    block = await provider.getBlock(oracleBlockNumber.toNumber());

    let decreaseOracleParams = await getOracleParams({
      oracleSalt,
      oracleBlockNumbers: [oracleBlockNumber, oracleBlockNumber],
      blockHashes: [block.hash, block.hash],
      signerIndexes,
      tokens: [weth.address, usdc.address],
      prices: [expandDecimals(1, 4), expandDecimals(1, 6)],
      signers,
      priceFeedTokens: [],
    });

    let usdcBalanceBefore = await usdc.balanceOf(user0.address);
    expect(usdcBalanceBefore).to.eq(0);
    // Execute decrease / close entire position
    await orderHandler.executeOrder(orderKeys[0], decreaseOracleParams);
    let usdcBalanceAfter = await usdc.balanceOf(user0.address);
    expect(Number(ethers.utils.formatUnits(usdcBalanceAfter.sub(usdcBalanceBefore), 6))).to.gt(49000);
  });

  it("Swap using deposit + withdraw", async () => {
    expect(await getBalanceOf(ethUsdMarket.marketToken, user1.address)).to.eq(0);

    await usdc.mint(depositStore.address, expandDecimals(50000, 6));
    await depositHandler.connect(wallet).createDeposit(user1.address, ethUsdMarket.marketToken, 100, false, 0);
    const depositKeys = await depositStore.getDepositKeys(0, 1);
    const deposit = await depositStore.get(depositKeys[0]);

    let block = await provider.getBlock(deposit.updatedAtBlock.toNumber());

    let oracleParams = await getOracleParams({
      oracleSalt,
      oracleBlockNumbers: [block.number, block.number],
      blockHashes: [block.hash, block.hash],
      signerIndexes,
      tokens: [weth.address, usdc.address],
      prices: [expandDecimals(1000, 4), expandDecimals(1, 6)],
      signers,
      priceFeedTokens: [],
    });

    await depositHandler.executeDeposit(depositKeys[0], oracleParams);

    const marketTokenBal = await getBalanceOf(ethUsdMarket.marketToken, user1.address);

    await withdrawalHandler
      .connect(wallet)
      .createWithdrawal(user0.address, ethUsdMarket.marketToken, marketTokenBal, 0, 0, 0, false, 0);
    const withdrawKeys = await withdrawalStore.getWithdrawalKeys(0, 1);
    const withdraw = await withdrawalStore.get(withdrawKeys[0]);

    block = await provider.getBlock(withdraw.updatedAtBlock.toNumber());

    oracleParams = await getOracleParams({
      oracleSalt,
      oracleBlockNumbers: [block.number, block.number],
      blockHashes: [block.hash, block.hash],
      signerIndexes,
      tokens: [weth.address, usdc.address],
      prices: [expandDecimals(1000, 4), expandDecimals(1, 6)],
      signers,
      priceFeedTokens: [],
    });

    await withdrawalHandler.executeWithdrawal(withdrawKeys[0], oracleParams);
    expect(await weth.balanceOf(user0.address)).eq(expandDecimals(50, 18));
  });
});
