const { expandDecimals } = require("./math");
const { grantRole } = require("./role");
const { deployContract } = require("./deploy");
const { decimalToFloat, expandFloatDecimals } = require("./math");

async function deployFixture() {
  const chainId = 31337; // hardhat chain id
  const [
    wallet,
    user0,
    user1,
    user2,
    user3,
    user4,
    user5,
    user6,
    user7,
    user8,
    signer0,
    signer1,
    signer2,
    signer3,
    signer4,
    signer5,
    signer6,
    signer7,
    signer8,
    signer9,
  ] = await ethers.getSigners();

  const keys = await deployContract("Keys", []);
  const reader = await deployContract("Reader", []);

  const roleStore = await deployContract("RoleStore", []);
  await grantRole(roleStore, wallet.address, "CONTROLLER");
  await grantRole(roleStore, wallet.address, "ORDER_KEEPER");

  const dataStore = await deployContract("DataStore", [roleStore.address]);
  await dataStore.setUint(await keys.MIN_ORACLE_BLOCK_CONFIRMATIONS(), 100);
  await dataStore.setUint(await keys.MAX_ORACLE_BLOCK_AGE(), 200);
  await dataStore.setUint(await keys.MAX_LEVERAGE(), expandFloatDecimals(100));

  const oracleStore = await deployContract("OracleStore", [roleStore.address]);

  await oracleStore.addSigner(signer0.address);
  await oracleStore.addSigner(signer1.address);
  await oracleStore.addSigner(signer2.address);
  await oracleStore.addSigner(signer3.address);
  await oracleStore.addSigner(signer4.address);
  await oracleStore.addSigner(signer5.address);
  await oracleStore.addSigner(signer6.address);
  await oracleStore.addSigner(signer7.address);
  await oracleStore.addSigner(signer8.address);
  await oracleStore.addSigner(signer9.address);

  const oracle = await deployContract("Oracle", [roleStore.address, oracleStore.address]);

  const weth = await deployContract("WETH", []);
  await weth.deposit({ value: expandDecimals(10, 18) });

  const wbtc = await deployContract("MintableToken", []);
  const usdc = await deployContract("MintableToken", []);

  await dataStore.setAddress(await keys.WETH(), weth.address);
  await dataStore.setUint(await reader.oraclePrecisionKey(weth.address), expandDecimals(1, 8));
  await dataStore.setUint(await reader.oraclePrecisionKey(wbtc.address), expandDecimals(1, 20));
  await dataStore.setUint(await reader.oraclePrecisionKey(usdc.address), expandDecimals(1, 18));

  const oracleSalt = ethers.utils.solidityKeccak256(["uint256", "string"], [chainId, "xget-oracle-v1"]);

  const depositStore = await deployContract("DepositStore", [roleStore.address]);
  const withdrawalStore = await deployContract("WithdrawalStore", [roleStore.address]);
  const orderStore = await deployContract("OrderStore", [roleStore.address]);
  const positionStore = await deployContract("PositionStore", [roleStore.address]);
  const marketStore = await deployContract("MarketStore", [roleStore.address]);

  const marketFactory = await deployContract("MarketFactory", [roleStore.address, marketStore.address]);
  await grantRole(roleStore, marketFactory.address, "CONTROLLER");

  await marketFactory.createMarket(weth.address, weth.address, usdc.address);
  let marketKeys = await marketStore.getMarketKeys(0, 1);
  const ethUsdMarket = await marketStore.get(marketKeys[0]);

  await marketFactory.createMarket(wbtc.address, wbtc.address, usdc.address);
  marketKeys = await marketStore.getMarketKeys(0, 2);
  const btcUsdMarket = await marketStore.get(marketKeys[1]);

  await dataStore.setUint(await reader.reserveFactorKey(ethUsdMarket.marketToken, true), decimalToFloat(5, 1));
  await dataStore.setUint(await reader.reserveFactorKey(ethUsdMarket.marketToken, false), decimalToFloat(5, 1));

  const feeReceiver = await deployContract("FeeReceiver", []);

  const gasUtils = await deployContract("GasUtils", []);
  const pricingUtils = await deployContract("PricingUtils", []);

  const marketUtils = await deployContract("MarketUtils", []);

  const depositUtils = await deployContract("DepositUtils", []);
  const withdrawalUtils = await deployContract("WithdrawalUtils", []);
  const swapUtils = await deployContract("SwapUtils", [], {
    libraries: {
      PricingUtils: pricingUtils.address,
    },
  });

  const orderUtils = await deployContract("OrderUtils", [], {
    libraries: {
      GasUtils: gasUtils.address,
    },
  });

  const increaseOrderUtils = await deployContract("IncreaseOrderUtils", [], {
    libraries: {
      SwapUtils: swapUtils.address,
      PricingUtils: pricingUtils.address,
      MarketUtils: marketUtils.address,
    },
  });

  const decreasePositionUtils = await deployContract("DecreasePositionUtils", [], {
    libraries: {
      PricingUtils: pricingUtils.address,
      MarketUtils: marketUtils.address,
    },
  });

  const decreaseOrderUtils = await deployContract("DecreaseOrderUtils", [], {
    libraries: {
      SwapUtils: swapUtils.address,
      DecreasePositionUtils: decreasePositionUtils.address,
    },
  });

  const swapOrderUtils = await deployContract("SwapOrderUtils", [], {
    libraries: {
      SwapUtils: swapUtils.address,
    },
  });

  const liquidationUtils = await deployContract("LiquidationUtils", [], {
    libraries: {
      OrderUtils: orderUtils.address,
      DecreaseOrderUtils: decreaseOrderUtils.address,
      PricingUtils: pricingUtils.address,
    },
  });

  const depositHandler = await deployContract(
    "DepositHandler",
    [
      roleStore.address,
      dataStore.address,
      depositStore.address,
      marketStore.address,
      oracle.address,
      feeReceiver.address,
    ],
    {
      libraries: {
        GasUtils: gasUtils.address,
        DepositUtils: depositUtils.address,
        PricingUtils: pricingUtils.address,
        MarketUtils: marketUtils.address,
      },
    }
  );

  const withdrawalHandler = await deployContract(
    "WithdrawalHandler",
    [
      roleStore.address,
      dataStore.address,
      withdrawalStore.address,
      marketStore.address,
      oracle.address,
      feeReceiver.address,
    ],
    {
      libraries: {
        GasUtils: gasUtils.address,
        WithdrawalUtils: withdrawalUtils.address,
        PricingUtils: pricingUtils.address,
        MarketUtils: marketUtils.address,
      },
    }
  );

  const orderHandler = await deployContract(
    "OrderHandler",
    [
      roleStore.address,
      dataStore.address,
      marketStore.address,
      orderStore.address,
      positionStore.address,
      oracle.address,
      feeReceiver.address,
    ],
    {
      libraries: {
        GasUtils: gasUtils.address,
        IncreaseOrderUtils: increaseOrderUtils.address,
        DecreaseOrderUtils: decreaseOrderUtils.address,
        SwapOrderUtils: swapOrderUtils.address,
        OrderUtils: orderUtils.address,
      },
    }
  );

  const liquidationHandler = await deployContract(
    "LiquidationHandler",
    [
      roleStore.address,
      dataStore.address,
      marketStore.address,
      positionStore.address,
      orderStore.address,
      oracle.address,
      feeReceiver.address,
    ],
    {
      libraries: {
        LiquidationUtils: liquidationUtils.address,
      },
    }
  );

  const router = await deployContract("Router", [roleStore.address]);

  const exchangeRouter = await deployContract("ExchangeRouter",
    [
      router.address,
      dataStore.address,
      depositHandler.address,
      withdrawalHandler.address,
      orderHandler.address,
      depositStore.address,
      withdrawalStore.address,
      orderStore.address,
    ]
  )

  await grantRole(roleStore, exchangeRouter.address, "CONTROLLER");
  await grantRole(roleStore, exchangeRouter.address, "ROUTER_PLUGIN");
  await grantRole(roleStore, depositHandler.address, "CONTROLLER");
  await grantRole(roleStore, withdrawalHandler.address, "CONTROLLER");
  await grantRole(roleStore, orderHandler.address, "CONTROLLER");
  await grantRole(roleStore, liquidationHandler.address, "CONTROLLER");

  return {
    accounts: {
      wallet,
      user0,
      user1,
      user2,
      user3,
      user4,
      user5,
      user6,
      user7,
      user8,
      signer0,
      signer1,
      signer2,
      signer3,
      signer4,
      signer5,
      signer6,
      signer7,
      signer8,
      signer9,
      signers: [signer0, signer1, signer2, signer3, signer4, signer5, signer6],
    },
    contracts: {
      keys,
      reader,
      roleStore,
      dataStore,
      depositStore,
      withdrawalStore,
      oracleStore,
      orderStore,
      positionStore,
      marketStore,
      marketFactory,
      depositHandler,
      withdrawalHandler,
      orderHandler,
      liquidationHandler,
      feeReceiver,
      oracle,
      weth,
      wbtc,
      usdc,
      ethUsdMarket,
      marketUtils,
      exchangeRouter,
      router,
      gasUtils,
      btcUsdMarket,
      increaseOrderUtils,
      decreaseOrderUtils,
    },
    props: { oracleSalt, signerIndexes: [0, 1, 2, 3, 4, 5, 6] },
  };
}

module.exports = {
  deployFixture,
};
