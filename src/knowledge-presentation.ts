import type { Envelope } from './model.js';
import { icon } from './ui-icons.js';
export function confidenceView(confidence?: Envelope['attribution_confidence'], compact = false) {
  const node = document.createElement('span'); node.className = 'knowledge-confidence';
  if (!confidence) { node.append(icon('circleQuestionMark', 12), compact ? 'Confidence not recorded' : 'Attribution confidence not recorded'); return node; }
  node.title = confidence.basis;
  const bars = document.createElement('span'); bars.className = 'knowledge-confidence-bars'; bars.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 3; i++) { const bar = document.createElement('i'); bar.dataset.filled = String(i < ({ low: 1, medium: 2, high: 3 })[confidence.level]); bars.append(bar); }
  node.append(bars, `${confidence.level[0].toUpperCase()}${confidence.level.slice(1)}${compact ? '' : ' attribution confidence'}`); return node;
}
export function identityTag(status?: string) {
  const node = document.createElement('span'); node.className = 'knowledge-identity-tag';
  if (status === 'partial') { node.append(icon('shieldQuestion', 12), 'Identity unresolved'); } else node.hidden = true;
  return node;
}
export function assertionOrigin(value?: string, attribution?: string) {
  return value === 'source' ? 'From source' : value === 'user_belief' ? attribution ? `Statement by ${attribution}` : 'Statement by an unidentified user' : value === 'agent_inference' ? 'Molty inferred' : 'Origin not recorded';
}
