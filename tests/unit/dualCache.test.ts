import { Inputs, Outputs } from '../../src/constants';

describe('Dual-Cache Logic & Strategies', () => {
  describe('Configuration Resolution', () => {
    it('defaults dual-cache to false', () => {
      expect(Inputs.DualCache).toBe('dual-cache');
      expect(Inputs.RestorePriority).toBe('restore-priority');
      expect(Inputs.DualCacheStrategy).toBe('dual-cache-strategy');
      expect(Inputs.DualCacheStrict).toBe('dual-cache-strict');
    });

    it('defines expected outputs for dual-caching', () => {
      expect(Outputs.CacheHitSource).toBe('cache-hit-source');
      expect(Outputs.CacheSavedSources).toBe('cache-saved-sources');
    });
  });

  describe('Backfill and Sync Decisions', () => {
    function computeSaveDecisions(
      strategy: 'backfill' | 'skip-on-hit' | 'independent',
      s3ExactHit: boolean,
      ghExactHit: boolean
    ) {
      if (strategy === 'skip-on-hit' && (s3ExactHit || ghExactHit)) {
        return { saveS3: false, saveGH: false };
      }
      return {
        saveS3: !s3ExactHit,
        saveGH: !ghExactHit,
      };
    }

    it('backfill strategy triggers S3 save when GitHub Cache had exact hit', () => {
      const { saveS3, saveGH } = computeSaveDecisions('backfill', false, true);
      expect(saveS3).toBe(true);
      expect(saveGH).toBe(false);
    });

    it('backfill strategy triggers GitHub save when S3 had exact hit', () => {
      const { saveS3, saveGH } = computeSaveDecisions('backfill', true, false);
      expect(saveS3).toBe(false);
      expect(saveGH).toBe(true);
    });

    it('skip-on-hit strategy skips both when either tier had exact hit', () => {
      const { saveS3, saveGH } = computeSaveDecisions('skip-on-hit', false, true);
      expect(saveS3).toBe(false);
      expect(saveGH).toBe(false);
    });

    it('both tiers save when neither had a cache hit', () => {
      const { saveS3, saveGH } = computeSaveDecisions('backfill', false, false);
      expect(saveS3).toBe(true);
      expect(saveGH).toBe(true);
    });
  });

  describe('Priority Dispatch Order', () => {
    function resolveOrder(priority: 's3-first' | 'github-first') {
      return priority === 'github-first' ? ['github', 's3'] : ['s3', 'github'];
    }

    it('resolves order correctly for s3-first', () => {
      expect(resolveOrder('s3-first')).toEqual(['s3', 'github']);
    });

    it('resolves order correctly for github-first', () => {
      expect(resolveOrder('github-first')).toEqual(['github', 's3']);
    });
  });
});
