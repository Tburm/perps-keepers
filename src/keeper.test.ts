import { BigNumber, utils } from "ethers";
import { wei } from "@synthetixio/wei";
import Keeper from "./keeper";

const getMockPositions = () => ({
  ___ACCOUNT1__: {
    id: "1",
    event: "__OLD_EVENT__",
    account: "___ACCOUNT1__",
    size: 10,
    leverage: 1,
  },
  ___ACCOUNT2__: {
    id: "1",
    event: "__OLD_EVENT__",
    account: "___ACCOUNT2__",
    size: 10,
    leverage: 1,
  },
  ___ACCOUNT3__: {
    id: "1",
    event: "__OLD_EVENT__",
    account: "___ACCOUNT3__",
    size: 10,
    leverage: 1,
  },
});
const sBTCBytes32 =
  "0x7342544300000000000000000000000000000000000000000000000000000000";
const baseAssetMock = jest.fn().mockReturnValue(sBTCBytes32);
describe("keeper", () => {
  test("create works", async () => {
    const args = {
      futuresMarket: { baseAsset: baseAssetMock },
      signerPool: "__SIGNER_POOL__",
      provider: "__PROVIDER__",
      network: "kovan",
    } as any;

    const result = await Keeper.create(args);

    expect(baseAssetMock).toBeCalledTimes(1);
    expect(result).toBeInstanceOf(Keeper);
  });
  test("run", async () => {
    const PositionLiquidatedMock = jest
      .fn()
      .mockReturnValue("__PositionLiquidated_EVENT_FILTER__");
    const PositionModifiedMock = jest
      .fn()
      .mockReturnValue("__PositionModified_EVENT_FILTER__");
    const FundingRecomputedMock = jest
      .fn()
      .mockReturnValue("__FundingRecomputed_EVENT_FILTER__");
    const event = "__EVENT__";
    const arg = {
      baseAsset: "sBTC",
      futuresMarket: {
        filters: {
          PositionLiquidated: PositionLiquidatedMock,
          PositionModified: PositionModifiedMock,
          FundingRecomputed: FundingRecomputedMock,
        },
        queryFilter: jest.fn().mockResolvedValue([event]),
        assetPrice: jest
          .fn()
          .mockResolvedValue({ price: BigNumber.from(100), invalid: false }),
      },
      signerPool: jest.fn(),
      provider: { on: jest.fn() },
    } as any;
    const keeper = new Keeper(arg);
    const updateIndexSpy = jest.spyOn(keeper, "updateIndex");
    const runKeepersSpy = jest.spyOn(keeper, "runKeepers");
    const startProcessNewBlockConsumerSpy = jest
      .spyOn(keeper, "startProcessNewBlockConsumer")
      .mockImplementation(); // avoid starting while(1)
    await keeper.run({ fromBlock: 0 });
    expect(arg.futuresMarket.queryFilter).toBeCalledTimes(3);
    expect(arg.futuresMarket.queryFilter).toHaveBeenNthCalledWith(
      1,
      "__PositionLiquidated_EVENT_FILTER__",
      0,
      "latest"
    );
    expect(arg.futuresMarket.queryFilter).toHaveBeenNthCalledWith(
      2,
      "__PositionModified_EVENT_FILTER__",
      0,
      "latest"
    );
    expect(arg.futuresMarket.queryFilter).toHaveBeenNthCalledWith(
      3,
      "__FundingRecomputed_EVENT_FILTER__",
      0,
      "latest"
    );
    expect(updateIndexSpy).toBeCalledTimes(1);
    expect(updateIndexSpy).toHaveBeenCalledWith([event, event, event]);
    expect(runKeepersSpy).toBeCalledTimes(1);
    expect(arg.provider.on).toBeCalledTimes(1);
    expect(arg.provider.on).toHaveBeenCalledWith("block", expect.any(Function));
    expect(startProcessNewBlockConsumerSpy).toBeCalledTimes(1);
  });
  test("updateIndex", async () => {
    const price = wei(40000).toBN();
    const arg = {
      baseAsset: "sBTC",
      futuresMarket: {
        assetPrice: jest
          .fn()
          .mockResolvedValue({ price: price, invalid: false }),
      },
      signerPool: jest.fn(),
      provider: jest.fn(),
    } as any;

    const deps = {
      totalLiquidationsMetric: { inc: jest.fn() },
      marketSizeMetric: { set: jest.fn() },
      marketSkewMetric: { set: jest.fn() },
      recentVolumeMetric: { set: jest.fn() },
    } as any;

    const keeper = new Keeper(arg);
    keeper.positions = getMockPositions();
    /**
     * PositionModified
     */
    await keeper.updateIndex(
      [
        {
          event: "PositionModified",
          args: {
            id: "1",
            account: "___ACCOUNT1__",
            size: wei(1).toBN(),
            lastPrice: price,
            margin: wei(20000).toBN(),
          },
        },
      ] as any,
      deps
    );
    expect(keeper.positions["___ACCOUNT1__"]).toEqual({
      account: "___ACCOUNT1__",
      event: "PositionModified",
      id: "1",
      size: 1,
      leverage: 2,
    });

    const expectedSize = wei(1)
      .toBN()
      .add(utils.parseEther("20")); // old positions minus ___ACCOUNT1__
    const expectedSizeUSD = parseFloat(
      utils.formatEther(price.mul(expectedSize).div(utils.parseEther("1")))
    );
    // size
    expect(deps.marketSizeMetric.set).toBeCalledTimes(1);
    expect(deps.marketSizeMetric.set).toBeCalledWith(
      { market: arg.baseAsset },
      expectedSizeUSD
    );
    // skew
    expect(deps.marketSkewMetric.set).toBeCalledTimes(1);
    expect(deps.marketSkewMetric.set).toBeCalledWith(
      { market: arg.baseAsset },
      expectedSizeUSD
    );
    // volume is called
    expect(deps.recentVolumeMetric.set).toBeCalledTimes(1);

    /**
     * PositionModified to 0
     */
    await keeper.updateIndex(
      [
        {
          event: "PositionModified",
          args: { id: "1", account: "___ACCOUNT1__", size: BigNumber.from(0) },
        },
      ] as any,
      deps
    );
    expect(keeper.positions["___ACCOUNT1__"]).toEqual(undefined);

    /**
     * PositionLiquidated
     */
    await keeper.updateIndex(
      [
        {
          event: "PositionLiquidated",
          args: { account: "___ACCOUNT2__" },
        },
      ] as any,
      deps
    );
    expect(keeper.positions["___ACCOUNT2__"]).toEqual(undefined);
    expect(deps.totalLiquidationsMetric.inc).toBeCalledTimes(1);

    // After these event we only expect ___ACCOUNT3__ to have a position
    expect(keeper.positions).toEqual({
      ___ACCOUNT3__: {
        id: "1",
        event: "__OLD_EVENT__",
        account: "___ACCOUNT3__",
        size: 10,
        leverage: 1,
      },
    });
  });
  test("pushTradeToVolumeQueue", async () => {
    const price = wei(40000).toBN();
    const size = wei(40000).toBN();
    const arg = {
      baseAsset: "sBTC",
      futuresMarket: {},
    } as any;
    const keeper = new Keeper(arg);

    // push some values
    keeper.blockTipTimestamp = 1;
    keeper.pushTradeToVolumeQueue(size, price);
    keeper.pushTradeToVolumeQueue(size.mul(BigNumber.from("-1")), price);

    const expectedVolume = price.mul(size.add(size));
    const expectedVolumeUSD = parseFloat(
      utils.formatEther(expectedVolume.div(utils.parseEther("1")))
    );
    expect(keeper.recentVolume).toEqual(expectedVolumeUSD);
  });
  test("updateVolumeMetrics", async () => {
    const price = wei(40000).toBN();
    const size = wei(40000).toBN();
    const arg = {
      baseAsset: "sBTC",
      futuresMarket: {},
    } as any;

    const keeper = new Keeper(arg);

    // push some old values
    keeper.blockTipTimestamp = 1;
    keeper.pushTradeToVolumeQueue(size, price);
    keeper.pushTradeToVolumeQueue(size, price);

    // push some newer values
    keeper.blockTipTimestamp = 10000000;
    keeper.pushTradeToVolumeQueue(size, price);
    keeper.pushTradeToVolumeQueue(size, price);
    keeper.pushTradeToVolumeQueue(size, price);

    const deps = {
      recentVolumeMetric: { set: jest.fn() },
    } as any;

    keeper.updateVolumeMetrics(deps);

    const expectedVolume = price.mul(size.add(size).add(size)); // only 3 trades
    const expectedVolumeUSD = parseFloat(
      utils.formatEther(expectedVolume.div(utils.parseEther("1")))
    );
    expect(keeper.recentVolume).toEqual(expectedVolumeUSD);
    expect(deps.recentVolumeMetric.set).toBeCalledWith(
      { market: arg.baseAsset },
      expectedVolumeUSD
    );
  });
  test("processNewBlock", async () => {
    const PositionLiquidatedMock = jest
      .fn()
      .mockReturnValue("__PositionLiquidated_EVENT_FILTER__");
    const PositionModifiedMock = jest
      .fn()
      .mockReturnValue("__PositionModified_EVENT_FILTER__");
    const FundingRecomputedMock = jest
      .fn()
      .mockReturnValue("__FundingRecomputed_EVENT_FILTER__");
    const event = { event: "FundingRecomputed", args: { timestamp: wei(100000) } };
    const arg = {
      baseAsset: "sUSD",
      futuresMarket: {
        queryFilter: jest.fn().mockReturnValue([event]),
        filters: {
          PositionLiquidated: PositionLiquidatedMock,
          PositionModified: PositionModifiedMock,
          FundingRecomputed: FundingRecomputedMock,
        },
        assetPrice: jest
          .fn()
          .mockResolvedValue({ price: BigNumber.from(100), invalid: false }),
      },
      signerPool: jest.fn(),
    } as any;
    const keeper = new Keeper(arg);
    const updateIndexSpy = jest.spyOn(keeper, "updateIndex");
    const runKeepersSpy = jest.spyOn(keeper, "runKeepers");
    await keeper.processNewBlock("1");
    expect(arg.futuresMarket.queryFilter).toBeCalledTimes(3);
    expect(arg.futuresMarket.queryFilter).toHaveBeenNthCalledWith(
      1,
      "__PositionLiquidated_EVENT_FILTER__",
      "1",
      "1"
    );
    expect(arg.futuresMarket.queryFilter).toHaveBeenNthCalledWith(
      2,
      "__PositionModified_EVENT_FILTER__",
      "1",
      "1"
    );
    expect(arg.futuresMarket.queryFilter).toHaveBeenNthCalledWith(
      3,
      "__FundingRecomputed_EVENT_FILTER__",
      "1",
      "1"
    );
    expect(updateIndexSpy).toBeCalledTimes(1);
    expect(updateIndexSpy).toBeCalledWith([event, event, event]);
    expect(runKeepersSpy).toBeCalledTimes(1);
    expect(keeper.blockTipTimestamp).toEqual(100000);
  });
  test("runKeepers", async () => {
    const arg = {
      baseAsset: "sUSD",
      futuresMarket: jest.fn(),
      signerPool: jest.fn(),
      provider: jest.fn(),
    } as any;
    const keeper = new Keeper(arg);
    const mockPosition = {
      ...getMockPositions(),
      ___ACCOUNT4__: {
        id: "4",
        event: "__OLD_EVENT__",
        account: "___ACCOUNT4__",
        size: 10,
        leverage: 2,
      },
    };
    keeper.positions = mockPosition;
    const runKeeperTaskSpy = jest.spyOn(keeper, "runKeeperTask");
    const liquidateOrderSpy = jest
      .spyOn(keeper, "liquidateOrder")
      .mockImplementation();
    const futuresOpenPositionsSetMock = jest.fn();

    await keeper.runKeepers({
      BATCH_SIZE: 1,
      WAIT: 1,
      metrics: {
        futuresOpenPositions: { set: futuresOpenPositionsSetMock },
      } as any,
    });

    expect(futuresOpenPositionsSetMock).toBeCalledTimes(1);
    expect(futuresOpenPositionsSetMock).toHaveBeenCalledWith(
      { market: "sUSD" },
      4
    );
    expect(runKeeperTaskSpy).toBeCalledTimes(4);
    expect(runKeeperTaskSpy).toHaveBeenNthCalledWith(
      1,
      mockPosition["___ACCOUNT4__"].id,
      "liquidation",
      expect.any(Function)
    );
    expect(runKeeperTaskSpy).toHaveBeenNthCalledWith(
      2,
      mockPosition["___ACCOUNT1__"].id,
      "liquidation",
      expect.any(Function)
    );
    expect(runKeeperTaskSpy).toHaveBeenNthCalledWith(
      3,
      mockPosition["___ACCOUNT2__"].id,
      "liquidation",
      expect.any(Function)
    );
    expect(runKeeperTaskSpy).toHaveBeenNthCalledWith(
      4,
      mockPosition["___ACCOUNT3__"].id,
      "liquidation",
      expect.any(Function)
    );
    expect(liquidateOrderSpy).toBeCalledTimes(4);
    expect(liquidateOrderSpy).toHaveBeenNthCalledWith(
      1,
      mockPosition["___ACCOUNT4__"].id,
      "___ACCOUNT4__"
    );
    expect(liquidateOrderSpy).toHaveBeenNthCalledWith(
      2,
      mockPosition["___ACCOUNT1__"].id,
      "___ACCOUNT1__"
    );
    expect(liquidateOrderSpy).toHaveBeenNthCalledWith(
      3,
      mockPosition["___ACCOUNT2__"].id,
      "___ACCOUNT2__"
    );
    expect(liquidateOrderSpy).toHaveBeenNthCalledWith(
      4,
      mockPosition["___ACCOUNT3__"].id,
      "___ACCOUNT3__"
    );
  });

  test("liquidateOrder bails when it cant liquidate", async () => {
    const arg = {
      baseAsset: "sUSD",
      futuresMarket: {
        canLiquidate: jest.fn().mockResolvedValue(false),
        assetPrice: jest.fn().mockResolvedValue({ price: 100, invalid: false }),
      },
      signerPool: { withSigner: jest.fn() },
      provider: jest.fn(),
    } as any;
    const keeper = new Keeper(arg);
    await keeper.liquidateOrder("1", "__ACCOUNT__");
    expect(arg.futuresMarket.canLiquidate).toBeCalledTimes(1);
    expect(arg.futuresMarket.canLiquidate).toHaveBeenCalledWith("__ACCOUNT__");
    expect(arg.signerPool.withSigner).not.toHaveBeenCalled();
  });

  test("liquidateOrder works", async () => {
    const waitMock = jest.fn();
    const liquidatePositionMock = jest.fn().mockReturnValue({ wait: waitMock });
    const arg = {
      baseAsset: "sUSD",
      futuresMarket: {
        canLiquidate: jest.fn().mockResolvedValue(true),
        assetPrice: jest.fn().mockResolvedValue({ price: 100, invalid: false }),
        connect: jest.fn().mockReturnValue({
          liquidatePosition: liquidatePositionMock,
        }),
      },
      signerPool: { withSigner: (cb: any) => cb("__SIGNER__") },
      provider: jest.fn(),
    } as any;
    const keeper = new Keeper(arg);
    const deps = { metricFuturesLiquidations: { inc: jest.fn() } } as any;

    await keeper.liquidateOrder("1", "__ACCOUNT__", deps);

    expect(arg.futuresMarket.canLiquidate).toBeCalledTimes(1);
    expect(arg.futuresMarket.canLiquidate).toHaveBeenCalledWith("__ACCOUNT__");
    expect(arg.futuresMarket.connect).toBeCalledTimes(1);
    expect(arg.futuresMarket.connect).toHaveBeenCalledWith("__SIGNER__");
    expect(liquidatePositionMock).toBeCalledTimes(1);
    expect(liquidatePositionMock).toHaveBeenCalledWith("__ACCOUNT__");
    expect(waitMock).toBeCalledTimes(1);
    expect(waitMock).toHaveBeenCalledWith(1);
    expect(deps.metricFuturesLiquidations.inc).toBeCalledTimes(1);
    expect(deps.metricFuturesLiquidations.inc).toHaveBeenCalledWith(
      { market: "sUSD" },
      1
    );
  });
});
