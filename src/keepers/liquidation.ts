import { TransactionResponse } from '@ethersproject/abstract-provider';
import { wei } from '@synthetixio/wei';
import { BigNumber, Contract, Event, providers, utils, Wallet } from 'ethers';
import { chunk, flatten } from 'lodash';
import { Keeper } from '.';
import { getEvents, UNIT } from './helpers';
import { PerpsEvent, Position } from '../typed';

export class LiquidationKeeper extends Keeper {
  // Required for sorting position by proximity of liquidation price to current price
  private assetPrice: number = 0;

  // The index
  private positions: Record<string, Position> = {};
  private blockTipTimestamp: number = 0;

  private readonly EVENTS_OF_INTEREST: PerpsEvent[] = [
    PerpsEvent.FundingRecomputed,
    PerpsEvent.PositionLiquidated,
    PerpsEvent.PositionModified,
  ];

  constructor(
    market: Contract,
    baseAsset: string,
    signer: Wallet,
    provider: providers.BaseProvider,
    network: string
  ) {
    super('LiquidationKeeper', market, baseAsset, signer, provider, network);
  }

  async updateIndex(events: Event[], block?: providers.Block, assetPrice?: number): Promise<void> {
    if (block) {
      // Set block timestamp here in case there were no events to update the timestamp from.
      this.blockTipTimestamp = block.timestamp;
    }

    if (assetPrice) {
      // Necessary to determine if the notional value of positions is underwater.
      this.assetPrice = assetPrice;
    }

    if (!events.length) {
      return;
    }

    this.logger.info(`'${events.length}' event(s) available to index...`);
    events.forEach(({ event, args, blockNumber }) => {
      if (!args) {
        return;
      }
      switch (event) {
        case PerpsEvent.FundingRecomputed: {
          // just a sneaky way to get timestamps without making awaiting getBlock() calls
          // keeping track of time is needed for the volume metrics during the initial
          // sync so that we don't have to await getting block timestamp for each new block
          this.blockTipTimestamp = args.timestamp.toNumber();
          return;
        }
        case PerpsEvent.PositionModified: {
          const { id, account, size, margin, lastPrice } = args;
          if (margin.eq(BigNumber.from(0))) {
            // Position has been closed.
            delete this.positions[account];
            return;
          }
          this.positions[account] = {
            id,
            event,
            account,
            size: wei(size)
              .div(UNIT)
              .toNumber(),
            leverage: wei(size)
              .abs()
              .mul(lastPrice)
              .div(margin)
              .div(UNIT)
              .toNumber(),
            liqPrice: -1, // will be updated by keeper routine
            liqPriceUpdatedTimestamp: 0,
          };
          return;
        }
        case PerpsEvent.PositionLiquidated: {
          delete this.positions[args.account];
          return;
        }
        default:
          this.logger.debug(`No handler for event ${event} (${blockNumber})`);
      }
    });
  }

  async index(fromBlock: number | string): Promise<void> {
    this.positions = {};
    this.activeKeeperTasks = {};
    this.blockTipTimestamp = 0;
    this.assetPrice = 0;

    this.logger.info(`Rebuilding index from '${fromBlock}' to latest`);

    const toBlock = await this.provider.getBlockNumber();
    const events = await getEvents(this.EVENTS_OF_INTEREST, this.market, { fromBlock, toBlock });

    await this.updateIndex(events);
  }

  private liquidationGroups(
    posArr: Position[],
    priceProximityThreshold = 0.05,
    maxFarPricesToUpdate = 1, // max number of older liquidation prices to update
    farPriceRecencyCutoff = 6 * 3600 // interval during which the liquidation price is considered up to date if it's far
  ) {
    // group
    const knownLiqPrice = posArr.filter(p => p.liqPrice !== -1);
    const unknownLiqPrice = posArr.filter(p => p.liqPrice === -1);

    const liqPriceClose = knownLiqPrice.filter(
      p => Math.abs(p.liqPrice - this.assetPrice) / this.assetPrice <= priceProximityThreshold
    );
    const liqPriceFar = knownLiqPrice.filter(
      p => Math.abs(p.liqPrice - this.assetPrice) / this.assetPrice > priceProximityThreshold
    );

    // sort close prices by liquidation price and leverage
    liqPriceClose.sort(
      (p1, p2) =>
        // sort by ascending proximity of liquidation price to current price
        Math.abs(p1.liqPrice - this.assetPrice) - Math.abs(p2.liqPrice - this.assetPrice) ||
        // if liq price is the same, sort by descending leverage (which should be different)
        p2.leverage - p1.leverage // desc)
    );

    // sort unknown liq prices by leverage
    unknownLiqPrice.sort((p1, p2) => p2.leverage - p1.leverage); //desc

    const outdatedLiqPrices = liqPriceFar.filter(
      p => p.liqPriceUpdatedTimestamp < this.blockTipTimestamp - farPriceRecencyCutoff
    );
    // sort far liquidation prices by how out of date they are
    // this should constantly update old positions' liq price
    outdatedLiqPrices.sort((p1, p2) => p1.liqPriceUpdatedTimestamp - p2.liqPriceUpdatedTimestamp); //asc

    // first known close prices, then unknown prices yet
    return [
      liqPriceClose, // all close prices within threshold
      unknownLiqPrice, // all unknown liq prices (to get them updated)
      outdatedLiqPrices.slice(0, maxFarPricesToUpdate), // some max number of of outdated prices to reduce spamming the node and prevent self DOS when there are many positions
    ];
  }

  private async liquidatePosition(account: string) {
    const canLiquidateOrder = await this.market.canLiquidate(account);
    if (!canLiquidateOrder) {
      // if it's not liquidatable update it's liquidation price
      this.positions[account].liqPrice = parseFloat(
        utils.formatUnits((await this.market.liquidationPrice(account)).price)
      );
      this.positions[account].liqPriceUpdatedTimestamp = this.blockTipTimestamp;
      this.logger.info(
        `Cannot liquidate '${account}' - liqPrice=${this.positions[account].liqPrice}`
      );
      return;
    }

    this.logger.info(`Begin liquidatePosition(${account})`);
    const tx: TransactionResponse = await this.market
      .connect(this.signer)
      .liquidatePosition(account);
    this.logger.info(`Submitted liquidatePosition(${account}) [nonce=${tx.nonce}]`);

    await this.waitAndLogTx(tx);
  }

  async execute(): Promise<void> {
    // Grab all open positions.
    const openPositions = Object.values(this.positions).filter(p => Math.abs(p.size) > 0);

    // Order the position in groups of priority that shouldn't be mixed in same batches
    const positionGroups = this.liquidationGroups(openPositions);
    const positionCount = flatten(positionGroups).length;

    // No positions. Move on.
    if (positionCount === 0) {
      this.logger.info(`No positions ready... skipping`);
      return;
    }

    this.logger.info(`Found ${positionCount}/${openPositions.length} open position(s) to check`);
    for (let group of positionGroups) {
      if (!group.length) {
        continue;
      }

      // Batch the groups to maintain internal order within groups
      for (const batch of chunk(group, this.MAX_BATCH_SIZE)) {
        this.logger.info(`Running keeper batch with '${batch.length}' position(s) to keep`);
        const batches = batch.map(({ id, account }) =>
          this.execAsyncKeeperCallback(id, () => this.liquidatePosition(account))
        );
        await Promise.all(batches);
        await this.delay(this.BATCH_WAIT_TIME);
      }
    }
  }
}
