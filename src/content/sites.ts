import type { SiteId } from '../shared/types';
import type { MainBridge } from './bridge';
import type { AdapterListener, SiteAdapter } from './adapters/base';
import { NetflixAdapter } from './adapters/netflix';
import { YouTubeAdapter } from './adapters/youtube';
import { GenericAdapter } from './adapters/generic';

export function detectSite(loc: Location): SiteId {
  if (__TEST__) {
    const forced = new URLSearchParams(loc.search).get('vidioma_site');
    if (forced) return forced as SiteId;
  }
  const h = loc.hostname;
  if (/(^|\.)netflix\.com$/.test(h)) return 'netflix';
  if (/(^|\.)youtube\.com$/.test(h)) return 'youtube';
  return 'generic';
}

export function createAdapter(site: SiteId, bridge: MainBridge, listener: AdapterListener): SiteAdapter {
  switch (site) {
    case 'netflix':
      return new NetflixAdapter(bridge, listener);
    case 'youtube':
      return new YouTubeAdapter(bridge, listener);
    default:
      return new GenericAdapter(bridge, listener);
  }
}
