/**
 * HTML card template for PNG generation via workers-og.
 * Uses inline styles (workers-og parses HTML and renders via satori+resvg).
 * Must use only CSS properties supported by satori (flexbox, no grid).
 */
import { formatTokens, formatCost, getTitle, formatEfficiency } from './utils';
import type { CardData } from './card';

function getRankAccent(rank: number): { color: string; label: string } {
  if (rank === 1) return { color: '#eab308', label: '#1' };
  if (rank === 2) return { color: '#9ca3af', label: '#2' };
  if (rank === 3) return { color: '#b45309', label: '#3' };
  return { color: '#7c3aed', label: `#${rank}` };
}

export function generateCardHtml(data: CardData, mode: 'simple' | 'full'): string {
  const title = getTitle(data.totalTokens);
  const rankInfo = getRankAccent(data.rank);
  const displayName = data.displayName.length > 20
    ? data.displayName.slice(0, 18) + '...'
    : data.displayName;

  let favToolsHtml = '';
  if (mode === 'full' && data.favTools && data.favTools.length > 0) {
    const pills = data.favTools.map(tool => {
      const label = tool.length > 20 ? tool.slice(0, 18) + '...' : tool;
      return `<div style="display: flex; font-size: 14px; color: #c4b5fd; background: rgba(139, 92, 246, 0.15); border: 1px solid rgba(139, 92, 246, 0.3); border-radius: 9999px; padding: 4px 14px;">${label}</div>`;
    }).join('');
    favToolsHtml = `
      <div style="display: flex; align-items: center; gap: 12px; margin-bottom: ${data.lastActive ? '16px' : '0'};">
        <div style="display: flex; font-size: 16px; color: #9ca3af;">Fav tools:</div>
        ${pills}
      </div>`;
  }

  let lastActiveHtml = '';
  if (mode === 'full' && data.lastActive) {
    lastActiveHtml = `<div style="display: flex; font-size: 18px; color: #6b7280;">Last active: ${data.lastActive}</div>`;
  }

  return `<div style="display: flex; flex-direction: column; justify-content: center; width: 1200px; height: 630px; padding: 48px; background: linear-gradient(135deg, #111827 0%, #1e1b4b 50%, #111827 100%); font-family: 'Inter', sans-serif; position: relative;">
    <div style="display: flex; position: absolute; top: 0; left: 0; right: 0; height: 6px; background: linear-gradient(90deg, ${rankInfo.color}, #7c3aed);"></div>

    <div style="display: flex; align-items: center; gap: 24px; margin-bottom: 32px;">
      <div style="display: flex; font-size: 48px; font-weight: 700; color: ${rankInfo.color};">${rankInfo.label}</div>
      ${data.avatarUrl
        ? `<img src="${data.avatarUrl}" width="72" height="72" style="border-radius: 50%; border: 3px solid ${rankInfo.color};" />`
        : `<div style="display: flex; align-items: center; justify-content: center; width: 72px; height: 72px; border-radius: 50%; background: #7c3aed; border: 3px solid ${rankInfo.color}; font-size: 32px; font-weight: 700; color: white;">${data.displayName.charAt(0)}</div>`}
      <div style="display: flex; flex-direction: column;">
        <div style="display: flex; font-size: 36px; font-weight: 700; color: #f3f4f6;">${displayName}</div>
        <div style="display: flex; font-size: 20px; color: ${title.color}; font-weight: 600;">${title.label}</div>
      </div>
    </div>

    <div style="display: flex; align-items: baseline; gap: 12px; margin-bottom: 24px;">
      <div style="display: flex; font-size: 72px; font-weight: 700; color: #22d3ee;">${formatTokens(data.totalTokens)}</div>
      <div style="display: flex; font-size: 24px; color: #9ca3af;">total tokens</div>
    </div>

    <div style="display: flex; gap: 40px; margin-bottom: ${mode === 'full' ? '24px' : '0'};">
      <div style="display: flex; flex-direction: column;">
        <div style="display: flex; font-size: 32px; font-weight: 700; color: #e5e7eb;">${formatCost(data.totalCost)}</div>
        <div style="display: flex; font-size: 16px; color: #9ca3af;">Estimated Cost</div>
      </div>
      <div style="display: flex; flex-direction: column;">
        <div style="display: flex; font-size: 32px; font-weight: 700; color: #e5e7eb;">${formatTokens(data.totalOutputTokens)}</div>
        <div style="display: flex; font-size: 16px; color: #9ca3af;">Output</div>
      </div>
      <div style="display: flex; flex-direction: column;">
        <div style="display: flex; font-size: 32px; font-weight: 700; color: #e5e7eb;">${data.daysActive}</div>
        <div style="display: flex; font-size: 16px; color: #9ca3af;">Days Active</div>
      </div>
    </div>

    ${data.outputPerDollar ? `<div style="display: flex; align-items: baseline; gap: 8px; margin-bottom: 16px;">
      <div style="display: flex; font-size: 28px; font-weight: 700; color: #34d399;">${formatEfficiency(data.outputPerDollar)} tokens/$</div>
      <div style="display: flex; font-size: 16px; color: #9ca3af;">efficiency</div>
    </div>` : ''}

    ${favToolsHtml}
    ${lastActiveHtml}

    <div style="display: flex; position: absolute; bottom: 32px; left: 48px; right: 48px; align-items: center; justify-content: space-between;">
      <div style="display: flex; align-items: center; gap: 10px;">
        <div style="display: flex; font-size: 18px; color: #a78bfa; font-weight: 600;">See where you rank</div>
        <div style="display: flex; font-size: 18px; color: #6b7280;">ccrank.dev</div>
      </div>
    </div>
  </div>`;
}
