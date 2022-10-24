const { expect } = require("chai");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const { deployFixture } = require("../../utils/fixture");
const { getOracleParams } = require("../../utils/oracle");
const { printGasUsage } = require("../../utils/gas");
const { expandDecimals, decimalToFloat } = require("../../utils/math");
const { getBalanceOf } = require("../../utils/token");

describe("Guardian Exchange.Withdrawal", () => {
  const { AddressZero } = ethers.constants;
  const { provider } = ethers;
  const executionFee = "0";

  let wallet, user0, user1, user2, signers, signerIndexes;
  let depositHandler,
    withdrawalHandler,
    feeReceiver,
    reader,
    dataStore,
    keys,
    depositStore,
    withdrawalStore,
    ethUsdMarket,
    weth,
    usdc,
    exchangeRouter,
    router;
  let oracleSalt;

  beforeEach(async () => {
    const fixture = await loadFixture(deployFixture);
    ({ wallet, user0, user1, user2, signers } = fixture.accounts);
    ({
      depositHandler,
      withdrawalHandler,
      feeReceiver,
      reader,
      dataStore,
      keys,
      depositStore,
      withdrawalStore,
      ethUsdMarket,
      weth,
      usdc,
      exchangeRouter,
      router,
    } = fixture.contracts);
    ({ oracleSalt, signerIndexes } = fixture.props);
  });

  it("User cannot withdraw with hasCollateralInEth == true", async () => {
    const wethAmount = expandDecimals(10, 18);
    const usdcAmount = expandDecimals(10 * 5000, 6);

    await weth.mint(user0.address, wethAmount); // 50k
    await usdc.mint(user0.address, usdcAmount); // 50k

    await weth.connect(user0).approve(router.address, wethAmount);
    await usdc.connect(user0).approve(router.address, usdcAmount);

    let block = await provider.getBlock();

    expect(await weth.balanceOf(user0.address)).to.eq(wethAmount);

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

    expect(await weth.balanceOf(user0.address)).to.eq(0);

    const depositKeys = await depositStore.getDepositKeys(0, 1);
    let deposit = await depositStore.get(depositKeys[0]);

    expect(deposit.account).eq(user0.address);
    expect(deposit.market).eq(ethUsdMarket.marketToken);
    expect(deposit.longTokenAmount).eq(wethAmount);
    expect(deposit.shortTokenAmount).eq(usdcAmount);
    expect(deposit.minMarketTokens).eq(0);
    expect(deposit.updatedAtBlock).eq(block.number + 1);

    block = await provider.getBlock(block.number + 1);
    let oracleBlockNumber = block.number;

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

    expect(await getBalanceOf(ethUsdMarket.marketToken, user0.address)).eq(0);
    expect(await weth.balanceOf(depositStore.address)).eq(wethAmount);
    expect(await usdc.balanceOf(depositStore.address)).eq(usdcAmount);

    expect(await weth.balanceOf(ethUsdMarket.marketToken)).eq(0);
    expect(await usdc.balanceOf(ethUsdMarket.marketToken)).eq(0);

    await depositHandler.executeDeposit(depositKeys[0], oracleParams);

    block = await provider.getBlock();
    expect(await withdrawalStore.getWithdrawalCount()).eq(0);
    await exchangeRouter
      .connect(user0)
      .createWithdrawal(ethUsdMarket.marketToken, expandDecimals(50 * 1000, 18), 0, 0, 0, true, executionFee);
    expect(await withdrawalStore.getWithdrawalCount()).eq(1);
    let withdrawalKeys = await withdrawalStore.getWithdrawalKeys(0, 1);

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
    await expect(withdrawalHandler.executeWithdrawal(withdrawalKeys[0], oracleParams)).to.be.reverted;
    // Withdrawal fails and the user still holds their market tokens
    expect(await getBalanceOf(ethUsdMarket.marketToken, user0.address)).gt(0);
  });

  it("User deposits both short and long token and withdrawals entire deposit in long token", async () => {
    const wethAmount = expandDecimals(10, 18);
    const usdcAmount = expandDecimals(10 * 5000, 6);

    await weth.mint(user0.address, wethAmount); // 50k
    await usdc.mint(user0.address, usdcAmount); // 50k

    await weth.connect(user0).approve(router.address, wethAmount);
    await usdc.connect(user0).approve(router.address, usdcAmount);

    let block = await provider.getBlock();

    expect(await getBalanceOf(ethUsdMarket.marketToken, user0.address)).eq(0);
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
    expect(await getBalanceOf(ethUsdMarket.marketToken, user0.address)).eq(expandDecimals(100 * 1000, 18));

    block = await provider.getBlock();
    expect(await withdrawalStore.getWithdrawalCount()).eq(0);
    await exchangeRouter
      .connect(user0)
      // Withdrawal entire deposit in long tokens
      .createWithdrawal(ethUsdMarket.marketToken, expandDecimals(100 * 1000, 18), 0, 0, 0, false, executionFee);
    expect(await withdrawalStore.getWithdrawalCount()).eq(1);
    let withdrawalKeys = await withdrawalStore.getWithdrawalKeys(0, 1);

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
    expect(withdrawalHandler.executeWithdrawal(withdrawalKeys[0], oracleParams)).to.be.revertedWith(
      "Error: VM Exception while processing transaction: reverted with panic code 0x11 (Arithmetic operation underflowed or overflowed outside of an unchecked block)"
    );
    // Withdrawal fails and no market tokens are withdrawn
    expect(await getBalanceOf(ethUsdMarket.marketToken, user0.address)).eq(expandDecimals(100 * 1000, 18));
  });

  it("User deposits both short and long token and withdrawals both short and long token", async () => {
    const wethAmount = expandDecimals(10, 18);
    const usdcAmount = expandDecimals(10 * 5000, 6);

    await weth.mint(user0.address, wethAmount); // 50k
    await usdc.mint(user0.address, usdcAmount); // 50k

    await weth.connect(user0).approve(router.address, wethAmount);
    await usdc.connect(user0).approve(router.address, usdcAmount);

    let block = await provider.getBlock();

    expect(await getBalanceOf(ethUsdMarket.marketToken, user0.address)).eq(0);
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
    expect(await getBalanceOf(ethUsdMarket.marketToken, user0.address)).eq(expandDecimals(100 * 1000, 18));

    block = await provider.getBlock();
    expect(await withdrawalStore.getWithdrawalCount()).eq(0);
    await exchangeRouter
      .connect(user0)
      .createWithdrawal(
        ethUsdMarket.marketToken,
        expandDecimals(50 * 1000, 18),
        expandDecimals(50 * 1000, 18),
        0,
        0,
        false,
        executionFee
      );
    expect(await withdrawalStore.getWithdrawalCount()).eq(1);
    let withdrawalKeys = await withdrawalStore.getWithdrawalKeys(0, 1);

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
    await withdrawalHandler.executeWithdrawal(withdrawalKeys[0], oracleParams);
    // Withdrawal executes successfully and all market tokens are withdrawn
    expect(await getBalanceOf(ethUsdMarket.marketToken, user0.address)).eq(0);
  });

  it("User deposits long token and immediately withdraws the short token", async () => {
    const wethAmount = expandDecimals(10, 18);

    await weth.mint(user0.address, wethAmount); // 50k

    await weth.connect(user0).approve(router.address, wethAmount);

    let block = await provider.getBlock();

    expect(await getBalanceOf(ethUsdMarket.marketToken, user0.address)).eq(0);
    expect(await depositStore.getDepositCount()).eq(0);
    await exchangeRouter
      .connect(user0)
      .createDeposit(ethUsdMarket.marketToken, weth.address, usdc.address, wethAmount, 0, 0, false, executionFee);
    expect(await depositStore.getDepositCount()).eq(1);

    const depositKeys = await depositStore.getDepositKeys(0, 1);

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
    expect(await getBalanceOf(ethUsdMarket.marketToken, user0.address)).eq(expandDecimals(50 * 1000, 18));

    block = await provider.getBlock();
    expect(await withdrawalStore.getWithdrawalCount()).eq(0);
    await exchangeRouter
      .connect(user0)
      .createWithdrawal(ethUsdMarket.marketToken, 0, expandDecimals(50 * 1000, 18), 0, 0, false, executionFee);
    expect(await withdrawalStore.getWithdrawalCount()).eq(1);
    let withdrawalKeys = await withdrawalStore.getWithdrawalKeys(0, 1);

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
    expect(withdrawalHandler.executeWithdrawal(withdrawalKeys[0], oracleParams)).to.be.revertedWith(
      "Error: VM Exception while processing transaction: reverted with panic code 0x11 (Arithmetic operation underflowed or overflowed outside of an unchecked block)"
    );
    // Withdrawal fails and no market tokens are withdrawn
    expect(await getBalanceOf(ethUsdMarket.marketToken, user0.address)).eq(expandDecimals(50 * 1000, 18));
  });

  it("User deposits short token and immediately withdraws the long token", async () => {
    const usdcAmount = expandDecimals(10 * 5000, 6);

    await usdc.mint(user0.address, usdcAmount); // 50k

    await usdc.connect(user0).approve(router.address, usdcAmount);

    let block = await provider.getBlock();

    expect(await getBalanceOf(ethUsdMarket.marketToken, user0.address)).eq(0);
    expect(await depositStore.getDepositCount()).eq(0);
    await exchangeRouter
      .connect(user0)
      .createDeposit(ethUsdMarket.marketToken, weth.address, usdc.address, 0, usdcAmount, 0, false, executionFee);
    expect(await depositStore.getDepositCount()).eq(1);

    const depositKeys = await depositStore.getDepositKeys(0, 1);

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
    expect(await getBalanceOf(ethUsdMarket.marketToken, user0.address)).eq(expandDecimals(50 * 1000, 18));

    block = await provider.getBlock();
    expect(await withdrawalStore.getWithdrawalCount()).eq(0);
    await exchangeRouter
      .connect(user0)
      .createWithdrawal(ethUsdMarket.marketToken, expandDecimals(50 * 1000, 18), 0, 0, 0, false, executionFee);
    expect(await withdrawalStore.getWithdrawalCount()).eq(1);
    let withdrawalKeys = await withdrawalStore.getWithdrawalKeys(0, 1);

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
    expect(withdrawalHandler.executeWithdrawal(withdrawalKeys[0], oracleParams)).to.be.revertedWith(
      "Error: VM Exception while processing transaction: reverted with panic code 0x11 (Arithmetic operation underflowed or overflowed outside of an unchecked block)"
    );
    // Withdrawal fails and no market tokens are withdrawn
    expect(await getBalanceOf(ethUsdMarket.marketToken, user0.address)).eq(expandDecimals(50 * 1000, 18));
  });

  it("Three users deposit, two withdrawl, ensure that pool balance is correct for remaining user", async () => {
    const wethAmount1 = expandDecimals(10, 18);
    const usdcAmount1 = expandDecimals(10 * 5000, 6);
    const wethAmount2 = expandDecimals(4, 18);
    const usdcAmount2 = expandDecimals(4 * 5000, 6);
    const wethAmount3 = expandDecimals(6, 18);
    const usdcAmount3 = expandDecimals(6 * 5000, 6);

    await weth.mint(user0.address, wethAmount1); // 50k
    await usdc.mint(user0.address, usdcAmount1); // 50k
    await weth.mint(user1.address, wethAmount2); // 20k
    await usdc.mint(user1.address, usdcAmount2); // 20k
    await weth.mint(user2.address, wethAmount3); // 30k
    await usdc.mint(user2.address, usdcAmount3); // 30k

    await weth.connect(user0).approve(router.address, wethAmount1);
    await usdc.connect(user0).approve(router.address, usdcAmount1);
    await weth.connect(user1).approve(router.address, wethAmount2);
    await usdc.connect(user1).approve(router.address, usdcAmount2);
    await weth.connect(user2).approve(router.address, wethAmount3);
    await usdc.connect(user2).approve(router.address, usdcAmount3);

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

    block = await provider.getBlock();
    await exchangeRouter
      .connect(user2)
      .createDeposit(
        ethUsdMarket.marketToken,
        weth.address,
        usdc.address,
        wethAmount3,
        usdcAmount3,
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

    // Withdrawal 1
    block = await provider.getBlock();
    expect(await withdrawalStore.getWithdrawalCount()).eq(0);
    await exchangeRouter
      .connect(user0)
      .createWithdrawal(
        ethUsdMarket.marketToken,
        expandDecimals(50 * 1000, 18),
        expandDecimals(50 * 1000, 18),
        0,
        0,
        false,
        executionFee
      );
    expect(await withdrawalStore.getWithdrawalCount()).eq(1);
    let withdrawalKeys = await withdrawalStore.getWithdrawalKeys(0, 1);

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
    await withdrawalHandler.executeWithdrawal(withdrawalKeys[0], oracleParams);
    expect(await getBalanceOf(ethUsdMarket.marketToken, user0.address)).eq(0);
    expect(await reader.getPoolAmount(dataStore.address, ethUsdMarket.marketToken, weth.address)).eq(
      expandDecimals(10, 18) // Weth left in pool is equal to the summation of the other 2 deposits
    );
    expect(await reader.getPoolAmount(dataStore.address, ethUsdMarket.marketToken, usdc.address)).eq(
      expandDecimals(10 * 5000, 6) // Weth left in pool is equal to the summation of the other 2 deposits
    );

    // Withdrawal 2
    block = await provider.getBlock();
    expect(await withdrawalStore.getWithdrawalCount()).eq(0);
    await exchangeRouter
      .connect(user1)
      .createWithdrawal(
        ethUsdMarket.marketToken,
        expandDecimals(20 * 1000, 18),
        expandDecimals(20 * 1000, 18),
        0,
        0,
        false,
        executionFee
      );
    expect(await withdrawalStore.getWithdrawalCount()).eq(1);
    withdrawalKeys = await withdrawalStore.getWithdrawalKeys(0, 1);

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
    await withdrawalHandler.executeWithdrawal(withdrawalKeys[0], oracleParams);
    expect(await reader.getPoolAmount(dataStore.address, ethUsdMarket.marketToken, weth.address)).eq(
      wethAmount3 // Weth deposits 1 and 2 have been been withdrawn, leaving just the third deposit amount
    );
    expect(await reader.getPoolAmount(dataStore.address, ethUsdMarket.marketToken, usdc.address)).eq(
      usdcAmount3 // Usdc deposits 1 and 2 have been been withdrawn, leaving just the third deposit amount
    );

    // Check balances now that withdrawals are complete

    // User0 full deposit was withdrawn
    expect(await weth.balanceOf(user0.address)).eq(wethAmount1);
    expect(await usdc.balanceOf(user0.address)).eq(usdcAmount1);

    // User 1 full deposit was withdrawn
    expect(await weth.balanceOf(user1.address)).eq(wethAmount2);
    expect(await usdc.balanceOf(user1.address)).eq(usdcAmount2);

    // User 2 no withdrawal of deposited funds
    expect(await weth.balanceOf(user2.address)).eq(0);
    expect(await usdc.balanceOf(user2.address)).eq(0);
  });
});
