import { describe, expect, it, jest } from '@jest/globals';

import { twoPassFeeSimulation } from './fee-simulation.helper';

describe('twoPassFeeSimulation', () => {

  it('calls simulate exactly twice', () => {
    const simulate = jest.fn<(feeSats: number) => { vsize: number }>().mockReturnValue({ vsize: 110 });

    twoPassFeeSimulation({ simulate, feeRatePerVbyte: 5 });

    expect(simulate).toHaveBeenCalledTimes(2);
  });

  it('uses placeholderFeeSats (default 1000) on the first pass', () => {
    const simulate = jest.fn<(feeSats: number) => { vsize: number }>().mockReturnValue({ vsize: 100 });

    twoPassFeeSimulation({ simulate, feeRatePerVbyte: 5 });

    expect(simulate.mock.calls[0][0]).toBe(1000);
  });

  it('honours a custom placeholderFeeSats', () => {
    const simulate = jest.fn<(feeSats: number) => { vsize: number }>().mockReturnValue({ vsize: 100 });

    twoPassFeeSimulation({ simulate, feeRatePerVbyte: 5, placeholderFeeSats: 7777 });

    expect(simulate.mock.calls[0][0]).toBe(7777);
  });

  it('feeds pass-2 with ceil(pass-1 vsize × feeRate)', () => {
    const sizes = [110, 105];
    const simulate = jest.fn<(feeSats: number) => { vsize: number }>().mockImplementation(() => ({ vsize: sizes.shift()! }));

    twoPassFeeSimulation({ simulate, feeRatePerVbyte: 5 });

    expect(simulate.mock.calls[1][0]).toBe(Math.ceil(110 * 5));
  });

  it('returns final fee = ceil(pass-2 vsize × feeRate) and final vsize from pass 2', () => {
    const sizes = [120, 109];
    const simulate = jest.fn<(feeSats: number) => { vsize: number }>().mockImplementation(() => ({ vsize: sizes.shift()! }));

    const result = twoPassFeeSimulation({ simulate, feeRatePerVbyte: 7 });

    expect(result.vsize).toBe(109);
    expect(result.finalFeeSats).toBe(Math.ceil(109 * 7));
  });

  it('rejects non-positive feeRatePerVbyte', () => {
    const simulate = jest.fn<(feeSats: number) => { vsize: number }>();

    expect(() => twoPassFeeSimulation({ simulate, feeRatePerVbyte: 0 })).toThrow(/positive/);
    expect(() => twoPassFeeSimulation({ simulate, feeRatePerVbyte: -1 })).toThrow(/positive/);
    expect(simulate).not.toHaveBeenCalled();
  });

  it('rounds the fee up — never under-pays the miner', () => {
    // vsize 111 × feeRate 1.3 = 144.3 → ceil 145
    const simulate = jest.fn<(feeSats: number) => { vsize: number }>().mockReturnValue({ vsize: 111 });

    const { finalFeeSats } = twoPassFeeSimulation({ simulate, feeRatePerVbyte: 1.3 });

    expect(finalFeeSats).toBe(145);
  });
});
