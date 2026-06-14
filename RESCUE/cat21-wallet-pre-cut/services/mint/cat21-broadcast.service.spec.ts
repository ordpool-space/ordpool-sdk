import { describe, expect, it, vi } from 'vitest';

import type { SlipstreamApiClient } from '../infrastructure/api/slipstream/slipstream-api.client';
import {
  Cat21BroadcastService,
  STANDARD_TX_WEIGHT_LIMIT,
} from './cat21-broadcast.service';

describe(Cat21BroadcastService.name, () => {
  const mockSlipstream = {
    submitTransaction: vi.fn().mockResolvedValue({ txid: 'slipstream-txid' }),
  } as unknown as SlipstreamApiClient;

  const service = new Cat21BroadcastService(mockSlipstream);

  describe('decideChannel', () => {
    it('picks mempool for standard-weight mints', () => {
      const decision = service.decideChannel({ hex: 'deadbeef', weight: 600 });
      expect(decision.channel).toBe('mempool');
    });

    it('picks slipstream when weight exceeds standard ceiling', () => {
      const decision = service.decideChannel({
        hex: 'deadbeef',
        weight: STANDARD_TX_WEIGHT_LIMIT + 1,
      });
      expect(decision.channel).toBe('slipstream');
    });

    it('respects explicit forceChannel even for standard-weight tx', () => {
      const decision = service.decideChannel(
        { hex: 'deadbeef', weight: 600 },
        { forceChannel: 'slipstream' }
      );
      expect(decision.channel).toBe('slipstream');
      expect(decision.reason).toContain('forced');
    });
  });

  describe('broadcast', () => {
    it('calls the mempool callback for standard-weight tx', async () => {
      const mempoolBroadcast = vi.fn().mockResolvedValue('mempool-txid');
      const result = await service.broadcast(
        { hex: 'deadbeef', weight: 600 },
        mempoolBroadcast
      );
      expect(mempoolBroadcast).toHaveBeenCalledWith('deadbeef');
      expect(result).toEqual({ txid: 'mempool-txid', channel: 'mempool' });
    });

    it('routes to Slipstream when weight exceeds ceiling', async () => {
      const mempoolBroadcast = vi.fn();
      const result = await service.broadcast(
        { hex: 'cafebabe', weight: STANDARD_TX_WEIGHT_LIMIT + 1 },
        mempoolBroadcast
      );
      expect(mempoolBroadcast).not.toHaveBeenCalled();
      expect(mockSlipstream.submitTransaction).toHaveBeenCalledWith('cafebabe', {
        signal: undefined,
      });
      expect(result).toEqual({ txid: 'slipstream-txid', channel: 'slipstream' });
    });
  });
});
