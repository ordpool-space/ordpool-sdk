import { AnnotatedFundingUtxo } from './funding-safety.js';
import type { FundingBlockedCoin } from './funding-blocked-error.js';

/** One annotated candidate as plain JSON, with its asset arrays copied. */
export function toFundingCoinJson(c: AnnotatedFundingUtxo): FundingBlockedCoin {
  return {
    txid: c.txid,
    vout: c.vout,
    value: c.value,
    bucket: c.bucket,
    assets: c.assets
      ? {
          inscriptionIds: [...c.assets.inscriptionIds],
          runeNames: [...c.assets.runeNames],
          catIds: [...c.assets.catIds],
          cats: c.assets.cats.map((cat) => ({ id: cat.id, number: cat.number })),
          catSat: c.assets.catSat,
          rareSat: c.assets.rareSat ? { ...c.assets.rareSat } : null,
        }
      : null,
  };
}
