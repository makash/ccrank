/**
 * HTML templates for the Claude Leaderboard application.
 * Dark themed, responsive design using Tailwind CSS via CDN.
 */

import {
  type User,
  type LeaderboardEntry,
  type ViewType,
  type DateRange,
  type SortKey,
  getTitle,
  formatTokens,
  formatCost,
  formatEfficiency,
  formatPercent,
  timeAgo,
  escapeHtml,
} from './utils';
import { IMG_RAJAN_MESSAGE, IMG_CLAUDE_BUILDING, IMG_APP_SHARED, IMG_DOMAIN_PURCHASE } from './images';
import { sparklineBars } from './analytics';

const PLATFORM_META = [
  { key: 'claude', label: 'Claude Code', shortLabel: 'Claude', dot: 'bg-purple-400', text: 'text-purple-300' },
  { key: 'codex', label: 'Codex CLI', shortLabel: 'Codex', dot: 'bg-emerald-400', text: 'text-emerald-300' },
  { key: 'kimi', label: 'Kimi Code', shortLabel: 'Kimi', dot: 'bg-sky-400', text: 'text-sky-300' },
  { key: 'grok', label: 'Grok CLI', shortLabel: 'Grok', dot: 'bg-rose-400', text: 'text-rose-300' },
  { key: 'glm', label: 'GLM (Z Code)', shortLabel: 'GLM', dot: 'bg-amber-400', text: 'text-amber-300' },
  { key: 'pi', label: 'Pi', shortLabel: 'Pi', dot: 'bg-teal-400', text: 'text-teal-300' },
  { key: 'opencode', label: 'OpenCode', shortLabel: 'OpenCode', dot: 'bg-orange-400', text: 'text-orange-300' },
] as const;

export function layout(title: string, content: string, user: User | null = null, ogOverrides?: { image?: string; description?: string }): string {
  const nav = user
    ? `<nav class="border-b border-gray-800 bg-gray-900/80 backdrop-blur-sm sticky top-0 z-50">
        <div class="max-w-6xl mx-auto px-4 h-14 flex items-center justify-between">
          <a href="/" class="text-lg font-bold bg-gradient-to-r from-purple-400 to-cyan-400 bg-clip-text text-transparent">
            ccrank.dev
          </a>
          <!-- Desktop nav -->
          <div class="hidden md:flex items-center gap-6">
            <a href="/leaderboard" class="text-sm text-gray-300 hover:text-white transition">Leaderboard</a>
            <a href="/upload" class="text-sm text-purple-300 hover:text-white transition font-medium">Install</a>
            <details class="relative group">
              <summary class="text-sm text-gray-300 hover:text-white transition cursor-pointer list-none">More</summary>
              <div class="absolute right-0 mt-2 w-44 bg-gray-900 border border-gray-800 rounded-lg shadow-lg p-2">
                <a href="/history" class="block px-3 py-2 text-sm text-gray-300 hover:text-white hover:bg-gray-800 rounded-md transition">History</a>
                <a href="/analytics" class="block px-3 py-2 text-sm text-gray-300 hover:text-white hover:bg-gray-800 rounded-md transition">Analytics</a>
                <a href="/about" class="block px-3 py-2 text-sm text-gray-300 hover:text-white hover:bg-gray-800 rounded-md transition">About</a>
                <a href="/settings" class="block px-3 py-2 text-sm text-gray-300 hover:text-white hover:bg-gray-800 rounded-md transition">Settings</a>
                ${user.is_admin ? '<a href="/admin" class="block px-3 py-2 text-sm text-yellow-400 hover:text-yellow-300 hover:bg-gray-800 rounded-md transition">Admin</a>' : ''}
              </div>
            </details>
            <div class="flex items-center gap-2">
              ${user.avatar_url ? `<img src="${escapeHtml(user.avatar_url)}" class="w-7 h-7 rounded-full" alt="">` : `<div class="w-7 h-7 rounded-full bg-purple-600 flex items-center justify-center text-xs font-bold">${escapeHtml(user.display_name.charAt(0))}</div>`}
              <span class="text-sm text-gray-300">${escapeHtml(user.display_name)}</span>
            </div>
            <a href="/auth/logout" class="text-sm text-gray-500 hover:text-gray-300 transition">Logout</a>
          </div>
          <!-- Mobile hamburger -->
          <button onclick="document.getElementById('mobile-menu').classList.toggle('hidden')" class="md:hidden text-gray-300 hover:text-white">
            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"/></svg>
          </button>
        </div>
        <!-- Mobile menu -->
        <div id="mobile-menu" class="hidden md:hidden border-t border-gray-800 px-4 py-3 space-y-2">
          <a href="/leaderboard" class="block text-sm text-gray-300 hover:text-white py-1">Leaderboard</a>
          <a href="/upload" class="block text-sm text-purple-300 hover:text-white py-1 font-medium">Install</a>
          <div class="pt-2 border-t border-gray-800/60">
            <div class="text-xs uppercase tracking-wider text-gray-500 mb-2">More</div>
            <a href="/history" class="block text-sm text-gray-300 hover:text-white py-1">History</a>
            <a href="/about" class="block text-sm text-gray-300 hover:text-white py-1">About</a>
            <a href="/settings" class="block text-sm text-gray-300 hover:text-white py-1">Settings</a>
            ${user.is_admin ? '<a href="/admin" class="block text-sm text-yellow-400 hover:text-yellow-300 py-1">Admin</a>' : ''}
          </div>
          <div class="flex items-center gap-2 py-1">
            ${user.avatar_url ? `<img src="${escapeHtml(user.avatar_url)}" class="w-7 h-7 rounded-full" alt="">` : `<div class="w-7 h-7 rounded-full bg-purple-600 flex items-center justify-center text-xs font-bold">${escapeHtml(user.display_name.charAt(0))}</div>`}
            <span class="text-sm text-gray-300">${escapeHtml(user.display_name)}</span>
          </div>
          <a href="/auth/logout" class="block text-sm text-gray-500 hover:text-gray-300 py-1">Logout</a>
        </div>
      </nav>`
    : `<nav class="border-b border-gray-800 bg-gray-900/80 backdrop-blur-sm sticky top-0 z-50">
        <div class="max-w-6xl mx-auto px-4 h-14 flex items-center justify-between">
          <a href="/" class="text-lg font-bold bg-gradient-to-r from-purple-400 to-cyan-400 bg-clip-text text-transparent">
            ccrank.dev
          </a>
          <!-- Desktop nav -->
          <div class="hidden md:flex items-center gap-6">
            <a href="/leaderboard" class="text-sm text-gray-300 hover:text-white transition">Leaderboard</a>
            <a href="/upload" class="text-sm text-purple-300 hover:text-white transition font-medium">Install</a>
            <details class="relative group">
              <summary class="text-sm text-gray-300 hover:text-white transition cursor-pointer list-none">More</summary>
              <div class="absolute right-0 mt-2 w-36 bg-gray-900 border border-gray-800 rounded-lg shadow-lg p-2">
                <a href="/history" class="block px-3 py-2 text-sm text-gray-300 hover:text-white hover:bg-gray-800 rounded-md transition">History</a>
                <a href="/analytics" class="block px-3 py-2 text-sm text-gray-300 hover:text-white hover:bg-gray-800 rounded-md transition">Analytics</a>
                <a href="/about" class="block px-3 py-2 text-sm text-gray-300 hover:text-white hover:bg-gray-800 rounded-md transition">About</a>
              </div>
            </details>
            <a href="/login" class="text-sm bg-purple-600 hover:bg-purple-500 text-white px-4 py-1.5 rounded-lg transition">Sign In</a>
          </div>
          <!-- Mobile hamburger -->
          <button onclick="document.getElementById('mobile-menu-public').classList.toggle('hidden')" class="md:hidden text-gray-300 hover:text-white">
            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"/></svg>
          </button>
        </div>
        <!-- Mobile menu -->
        <div id="mobile-menu-public" class="hidden md:hidden border-t border-gray-800 px-4 py-3 space-y-2">
          <a href="/leaderboard" class="block text-sm text-gray-300 hover:text-white py-1">Leaderboard</a>
          <a href="/upload" class="block text-sm text-purple-300 hover:text-white py-1 font-medium">Install</a>
          <div class="pt-2 border-t border-gray-800/60">
            <div class="text-xs uppercase tracking-wider text-gray-500 mb-2">More</div>
            <a href="/history" class="block text-sm text-gray-300 hover:text-white py-1">History</a>
            <a href="/about" class="block text-sm text-gray-300 hover:text-white py-1">About</a>
          </div>
          <a href="/login" class="block text-sm bg-purple-600 hover:bg-purple-500 text-white px-4 py-1.5 rounded-lg transition text-center">Sign In</a>
        </div>
      </nav>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} | ccrank.dev</title>
  <meta name="author" content="Akash Mahajan">
  <meta name="description" content="Install the ccrank CLI to track Claude Code, Codex CLI, Kimi, Grok, GLM, Pi, and OpenCode token usage and see where you rank.">
  <meta property="og:title" content="${escapeHtml(title)} | ccrank.dev">
  <meta property="og:description" content="${ogOverrides?.description ? escapeHtml(ogOverrides.description) : 'Install the ccrank CLI to track Claude Code, Codex CLI, Kimi, Grok, GLM, Pi, and OpenCode token usage and see where you rank.'}">
  <meta property="og:type" content="website">
  <meta property="og:image" content="${ogOverrides?.image || 'https://imgs.kloudle.com/kloudle-customer-logos/ccrank-dev/ccrank-open-graph-image.webp'}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:creator" content="@makash">
  <meta name="twitter:title" content="${escapeHtml(title)} | ccrank.dev">
  <meta name="twitter:description" content="${ogOverrides?.description ? escapeHtml(ogOverrides.description) : 'Install the ccrank CLI to track Claude Code, Codex CLI, Kimi, Grok, GLM, Pi, and OpenCode token usage and see where you rank.'}">
  <meta name="twitter:image" content="${ogOverrides?.image || 'https://imgs.kloudle.com/kloudle-customer-logos/ccrank-dev/ccrank-open-graph-image.webp'}">
  <meta property="og:site_name" content="ccrank.dev">
  <meta property="og:url" content="https://ccrank.dev/">
  <link rel="canonical" href="https://ccrank.dev/">
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>&#x1f3c6;</text></svg>">
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    "name": "AI Coding Token Leaderboard",
    "description": "Install the ccrank CLI to track Claude Code, Codex CLI, Kimi, Grok, GLM, Pi, and OpenCode token usage and see where you rank.",
    "url": "https://ccrank.dev/",
    "applicationCategory": "DeveloperApplication",
    "creator": {
      "@type": "Person",
      "name": "Akash Mahajan",
      "url": "https://github.com/makash",
      "sameAs": [
        "https://x.com/makash",
        "https://www.linkedin.com/in/akashm/",
        "https://www.youtube.com/@makash",
        "https://github.com/makash"
      ]
    }
  }
  </script>
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      theme: {
        extend: {
          colors: {
            dark: { 900: '#0f0f1a', 800: '#1a1a2e', 700: '#252542' }
          }
        }
      }
    }
  </script>
  <style>
    body { background: #0f0f1a; color: #e2e8f0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
    .glow { box-shadow: 0 0 20px rgba(124, 58, 237, 0.15); }
    .card-hover { transition: transform 0.2s ease, box-shadow 0.2s ease; }
    .card-hover:hover { transform: translateY(-4px); box-shadow: 0 8px 30px rgba(124, 58, 237, 0.2); }
    .rank-1 { background: linear-gradient(135deg, rgba(245,158,11,0.15), rgba(245,158,11,0.05)); border-color: rgba(245,158,11,0.3); }
    .rank-2 { background: linear-gradient(135deg, rgba(156,163,175,0.15), rgba(156,163,175,0.05)); border-color: rgba(156,163,175,0.3); }
    .rank-3 { background: linear-gradient(135deg, rgba(180,83,9,0.15), rgba(180,83,9,0.05)); border-color: rgba(180,83,9,0.3); }
    .podium-1 { border-top: 4px solid #f59e0b; border-color: rgba(245,158,11,0.5); }
    .podium-2 { border-top: 4px solid #9ca3af; border-color: rgba(156,163,175,0.4); }
    .podium-3 { border-top: 4px solid #b45309; border-color: rgba(180,83,9,0.4); }
  </style>
</head>
<body class="min-h-screen">
  ${nav}
  <main class="max-w-6xl mx-auto px-4 py-8">
    ${content}
  </main>
  <footer class="border-t border-gray-800 mt-16 py-8 text-center">
    <div class="max-w-6xl mx-auto px-4">
      <p class="text-sm text-gray-500 mb-1">
        by <a href="https://x.com/makash?utm_source=ccrank&utm_medium=web&utm_campaign=footer" target="_blank" rel="noopener" class="text-purple-400 hover:text-purple-300 transition">@makash</a>
      </p>
      <p class="text-xs text-gray-600 mb-3">
        Powered by <a href="https://github.com/ryoppippi/ccusage?utm_source=ccrank&utm_medium=web&utm_campaign=footer" target="_blank" rel="noopener" class="text-gray-500 hover:text-gray-300 transition">ccusage</a> <span class="mx-1">|</span> <a href="https://github.com/makash/claude-leaderboard-using-ccusage?utm_source=ccrank&utm_medium=web&utm_campaign=footer" target="_blank" rel="noopener" class="text-gray-500 hover:text-gray-300 transition">Open Source</a>
      </p>
      <div class="flex items-center justify-center gap-4">
        <a href="https://x.com/makash?utm_source=claude-leaderboard&utm_medium=web&utm_campaign=branding" target="_blank" rel="noopener" class="text-gray-600 hover:text-gray-300 transition" title="X / Twitter">
          <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
        </a>
        <a href="https://github.com/makash?utm_source=claude-leaderboard&utm_medium=web&utm_campaign=branding" target="_blank" rel="noopener" class="text-gray-600 hover:text-gray-300 transition" title="GitHub">
          <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"/></svg>
        </a>
        <a href="https://www.linkedin.com/in/akashm/?utm_source=claude-leaderboard&utm_medium=web&utm_campaign=branding" target="_blank" rel="noopener" class="text-gray-600 hover:text-gray-300 transition" title="LinkedIn">
          <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>
        </a>
        <a href="https://www.youtube.com/@makash?utm_source=claude-leaderboard&utm_medium=web&utm_campaign=branding" target="_blank" rel="noopener" class="text-gray-600 hover:text-gray-300 transition" title="YouTube">
          <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>
        </a>
      </div>
    </div>
  </footer>
</body>
</html>`;
}

export function landingPage(topEntries: LeaderboardEntry[]): string {
  // Build podium card for a single entry
  function podiumCard(e: LeaderboardEntry): string {
    const title = getTitle(e.total_tokens);
    const isFirst = e.rank === 1;
    const rankLabel = e.rank === 1 ? '#1' : e.rank === 2 ? '#2' : '#3';
    const rankColor = e.rank === 1 ? 'text-yellow-400' : e.rank === 2 ? 'text-gray-300' : 'text-amber-500';
    const ringColor = e.rank === 1 ? 'ring-yellow-400' : e.rank === 2 ? 'ring-gray-400' : 'ring-amber-600';
    const avatarSize = isFirst ? 'w-20 h-20' : 'w-16 h-16';
    const avatarText = isFirst ? 'text-2xl' : 'text-lg';
    const avatarRing = isFirst ? 'ring-4' : 'ring-2';
    const tokenSize = isFirst ? 'text-3xl' : 'text-2xl';
    const padding = isFirst ? 'p-8' : 'p-6';
    const rankSize = isFirst ? 'text-3xl' : 'text-2xl';

    return `<div class="bg-gray-900 border border-gray-800 rounded-xl ${padding} text-center rank-${e.rank} podium-${e.rank} card-hover glow">
      <div class="${rankSize} font-extrabold ${rankColor} mb-3">${rankLabel}</div>
      <div class="mb-3">
        ${e.avatar_url
          ? `<img src="${escapeHtml(e.avatar_url)}" class="${avatarSize} rounded-full mx-auto ${avatarRing} ${ringColor}" alt="">`
          : `<div class="${avatarSize} rounded-full bg-purple-600 flex items-center justify-center ${avatarText} font-bold mx-auto ${avatarRing} ${ringColor}">${escapeHtml(e.display_name.charAt(0))}</div>`}
      </div>
      <div class="font-semibold ${isFirst ? 'text-xl' : 'text-lg'} mb-1">${e.share_slug
        ? `<a href="/user/${escapeHtml(e.share_slug)}" class="hover:text-purple-300 transition">${escapeHtml(e.display_name)}</a>`
        : escapeHtml(e.display_name)}</div>

      <div class="text-xs mb-3" style="color:${title.color}">${title.label}</div>
      <div class="${tokenSize} font-bold text-cyan-400 mb-1">${formatTokens(e.total_tokens)} tokens</div>
      <div class="text-xs text-gray-500">${formatCost(e.total_cost)} estimated &middot; ${e.days_active}d active</div>
    </div>`;
  }

  // Arrange in 2-1-3 order for podium effect on desktop
  let podiumSection: string;
  if (topEntries.length > 0) {
    const first = topEntries.find(e => e.rank === 1);
    const second = topEntries.find(e => e.rank === 2);
    const third = topEntries.find(e => e.rank === 3);

    // Desktop: flex with items-end, 2nd - 1st - 3rd order, 1st is taller
    // Mobile: stack in natural 1-2-3 order
    podiumSection = `<div class="mb-12">
      <h2 class="text-lg font-semibold text-gray-300 text-center mb-8">Top AI Coding Users</h2>
      <!-- Mobile: natural order -->
      <div class="flex flex-col gap-4 md:hidden max-w-sm mx-auto">
        ${first ? podiumCard(first) : ''}
        ${second ? podiumCard(second) : ''}
        ${third ? podiumCard(third) : ''}
      </div>
      <!-- Desktop: podium layout 2-1-3 with stepped heights -->
      <div class="hidden md:flex items-end justify-center gap-4 max-w-3xl mx-auto">
        <div class="flex-1 translate-y-4">
          ${second ? podiumCard(second) : ''}
        </div>
        <div class="flex-1">
          ${first ? podiumCard(first) : ''}
        </div>
        <div class="flex-1 translate-y-6">
          ${third ? podiumCard(third) : ''}
        </div>
      </div>
    </div>`;
  } else {
    podiumSection = `<div class="mb-12 text-center">
      <div class="bg-gray-900 border border-gray-800 rounded-xl p-8 max-w-md mx-auto card-hover">
        <p class="text-gray-400 mb-2">No data yet</p>
        <p class="text-sm text-gray-500">Be the first to install the CLI and upload.</p>
      </div>
    </div>`;
  }

  return layout(
    'Welcome',
    `<div class="flex flex-col items-center justify-center min-h-[70vh] text-center">
      <div class="mb-12">
        <h1 class="text-6xl font-extrabold mb-4 bg-gradient-to-r from-purple-400 via-pink-400 to-cyan-400 bg-clip-text text-transparent leading-tight">
          ccrank.dev
        </h1>
        <p class="text-xl text-gray-400 max-w-lg mx-auto leading-relaxed">
          Track Claude, Codex, Kimi, Grok, GLM, Pi & OpenCode tokens. Benchmark your leverage.
        </p>
        <p class="text-xs text-gray-500 mt-2">by <a href="https://x.com/makash?utm_source=ccrank&utm_medium=web&utm_campaign=hero" target="_blank" rel="noopener" class="text-gray-400 hover:text-gray-300 transition">@makash</a></p>
      </div>

      ${podiumSection}

      <!-- Origin story snippet -->
      <div class="mb-12 max-w-lg mx-auto">
        <div class="bg-green-900/20 border border-green-800/30 rounded-xl p-5 text-left relative">
          <div class="text-xs text-green-400/70 mb-2 font-medium">WhatsApp Group</div>
          <p class="text-sm text-gray-300 leading-relaxed">
            <span class="font-semibold text-green-400">Rajan:</span>
            &ldquo;Code a Leaderboard Vivek? Let everyone submit their ccusage :)&rdquo;
          </p>
          <p class="text-xs text-gray-500 mt-2">
            Built with Claude Code on a phone. Deployed in minutes.
            <a href="/about" class="text-purple-400 hover:text-purple-300 transition ml-1">Read the full story &rarr;</a>
          </p>
        </div>
      </div>

      <div class="flex flex-col sm:flex-row items-center gap-4">
        <a href="/login" class="bg-purple-600 hover:bg-purple-500 text-white font-semibold rounded-lg px-8 py-3.5 transition text-sm shadow-lg shadow-purple-600/20">
          Sign in &amp; Install the CLI
        </a>
        <a href="/leaderboard" class="bg-gray-800 hover:bg-gray-700 text-white font-medium rounded-lg px-8 py-3.5 transition text-sm border border-gray-700">
          View Full Leaderboard &rarr;
        </a>
      </div>
    </div>`
  );
}

export function loginPage(): string {
  return layout(
    'Sign In',
    `<div class="flex flex-col items-center justify-center min-h-[60vh]">
      <div class="w-full max-w-md">
        <div class="bg-gray-900 border border-gray-800 rounded-xl p-8 glow">
          <h1 class="text-2xl font-bold mb-2 text-center">Sign in or join</h1>
          <p class="text-sm text-gray-400 text-center mb-6">Continue with Google. New accounts are created automatically.</p>
          <a
            href="/auth/google"
            class="w-full bg-white text-gray-900 font-medium rounded-lg px-4 py-2.5 text-sm hover:bg-gray-100 transition flex items-center justify-center gap-2"
          >
            <svg class="w-5 h-5" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
            Continue with Google
          </a>
        </div>
      </div>

      <a href="/" class="mt-8 text-sm text-gray-500 hover:text-gray-300 transition">&larr; Back to home</a>
    </div>`
  );
}

export function dashboardPage(user: User, stats: { total_cost: number; total_tokens: number; total_output_tokens: number; days_active: number; rank: number; upload_count: number; platformBreakdown?: Record<string, { total_cost: number; total_tokens: number; total_output_tokens: number; days_active: number }> }): string {
  const title = getTitle(stats.total_tokens);
  return layout(
    'Dashboard',
    `<div class="mb-8">
      <h1 class="text-2xl font-bold mb-1">Welcome back, ${escapeHtml(user.display_name)}</h1>
      <p class="text-gray-400">
        <span style="color:${title.color}" class="font-medium">${title.label}</span>
        &middot; Rank #${stats.rank || '—'}
      </p>
    </div>

    <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
      <div class="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <div class="text-sm text-gray-400 mb-1">Total Tokens</div>
        <div class="text-2xl font-bold text-cyan-400">${formatTokens(stats.total_tokens)}</div>
      </div>
      <div class="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <div class="text-sm text-gray-400 mb-1">Output Tokens</div>
        <div class="text-2xl font-bold text-green-400">${formatTokens(stats.total_output_tokens)}</div>
      </div>
      <div class="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <div class="text-sm text-gray-400 mb-1">Days Active</div>
        <div class="text-2xl font-bold text-yellow-400">${stats.days_active}</div>
      </div>
      <div class="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <div class="text-sm text-gray-400 mb-1">Estimated Cost</div>
        <div class="text-2xl font-bold text-purple-400">${formatCost(stats.total_cost)}</div>
      </div>
    </div>

    ${(() => {
      const pb = stats.platformBreakdown;
      if (!pb || Object.keys(pb).length <= 1) return '';
      const cards = PLATFORM_META.flatMap((platform) => {
        const usage = pb[platform.key];
        if (!usage) return [];
        return [`<div class="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <div class="flex items-center gap-2 mb-3">
            <span class="w-2 h-2 rounded-full ${platform.dot}"></span>
            <span class="text-sm font-medium ${platform.text}">${platform.label}</span>
          </div>
          <div class="flex gap-6">
            <div><div class="text-xs text-gray-500">Tokens</div><div class="text-lg font-bold text-cyan-400">${formatTokens(usage.total_tokens)}</div></div>
            <div><div class="text-xs text-gray-500">Days</div><div class="text-lg font-bold text-yellow-400">${usage.days_active}</div></div>
            <div><div class="text-xs text-gray-500">Cost</div><div class="text-lg font-bold text-purple-400">${formatCost(usage.total_cost)}</div></div>
          </div>
        </div>`];
      }).join('');
      return cards ? `<div class="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">${cards}</div>` : '';
    })()}

    <div class="flex gap-4 mb-8">
      <a href="/upload" class="bg-purple-600 hover:bg-purple-500 text-white font-medium rounded-lg px-6 py-3 transition">
        Install CLI
      </a>
      <a href="/leaderboard" class="bg-gray-800 hover:bg-gray-700 text-white font-medium rounded-lg px-6 py-3 transition">
        View Leaderboard
      </a>
    </div>

    <!-- Share card nudge -->
    ${user.sharing_enabled && user.share_slug ? `
    <div class="bg-cyan-900/20 border border-cyan-800/30 rounded-xl p-5 flex items-center justify-between mt-4">
      <div>
        <p class="text-sm font-medium text-gray-200">Share your stats card</p>
        <p class="text-xs text-gray-400 mt-1">Show off your usage stats on Twitter/LinkedIn</p>
      </div>
      <a href="/card/${escapeHtml(user.share_slug)}" class="flex-shrink-0 bg-cyan-600 hover:bg-cyan-500 text-white text-sm font-medium rounded-lg px-5 py-2.5 transition ml-4">
        View Card
      </a>
    </div>` : !user.sharing_enabled ? `
    <div class="bg-gray-800/50 border border-gray-700/30 rounded-xl p-5 flex items-center justify-between mt-4">
      <div>
        <p class="text-sm font-medium text-gray-300">Share your ranking</p>
        <p class="text-xs text-gray-500 mt-1">Create a shareable stats card for Twitter/LinkedIn</p>
      </div>
      <a href="/settings" class="flex-shrink-0 bg-gray-700 hover:bg-gray-600 text-white text-sm font-medium rounded-lg px-5 py-2.5 transition ml-4">
        Enable Sharing
      </a>
    </div>` : ''}`,
    user
  );
}

export function leaderboardPage(
  entries: LeaderboardEntry[],
  user: User | null = null,
  sort: string = 'tokens',
  view: ViewType | null = null,
  dateRange: DateRange | null = null,
  platform: string | null = null
): string {
  const isEfficiencySort = sort !== 'cost' && sort !== 'tokens';

  const rows = entries
    .map((e) => {
      const title = getTitle(e.total_tokens);
      const rankClass = e.rank >= 1 && e.rank <= 3 ? `rank-${e.rank}` : '';
      const medal = e.rank === 1 ? '<span class="text-yellow-400 text-lg mr-1">&#x1f947;</span>' : e.rank === 2 ? '<span class="text-gray-300 text-lg mr-1">&#x1f948;</span>' : e.rank === 3 ? '<span class="text-amber-600 text-lg mr-1">&#x1f949;</span>' : '';
      const dimClass = isEfficiencySort && e.rank === 0 ? 'opacity-50' : '';
      const rankDisplay = e.rank === 0 ? '—' : `${medal}${e.rank}`;
      const profileHref = e.share_slug ? `/user/${escapeHtml(e.share_slug)}` : '#';
      const clickableClass = e.share_slug ? 'cursor-pointer' : '';
      const rowClick = e.share_slug ? `onclick="window.location.href='${profileHref}'"` : '';
      return `<tr class="border-b border-gray-800/50 hover:bg-gray-800/30 transition ${rankClass} ${dimClass} ${clickableClass}" ${rowClick}>
        <td class="py-3 px-4 text-center font-mono text-sm">${rankDisplay}</td>
        <td class="py-3 px-4">
          <div class="flex items-center gap-3">
            ${e.avatar_url ? `<img src="${escapeHtml(e.avatar_url)}" class="w-8 h-8 rounded-full" alt="">` : `<div class="w-8 h-8 rounded-full bg-purple-600 flex items-center justify-center text-xs font-bold">${escapeHtml(e.display_name.charAt(0))}</div>`}
            <div>
              <div class="font-medium">${e.share_slug
                ? `<a href="${profileHref}" class="hover:text-purple-400 transition">${escapeHtml(e.display_name)}</a>`
                : escapeHtml(e.display_name)}</div>
              <div class="flex items-center gap-1.5">
                <span class="text-xs" style="color:${title.color}">${title.label}</span>
                ${PLATFORM_META.filter((p) => (e.platforms || []).includes(p.key))
                  .map((p) => `<span class="w-1.5 h-1.5 rounded-full ${p.dot}" title="${p.label}"></span>`)
                  .join('')}
              </div>
            </div>
          </div>
        </td>
        <td class="py-3 px-4 text-right font-mono text-cyan-400">${formatTokens(e.total_tokens)}</td>
        <td class="py-3 px-4 text-right font-mono text-purple-400">${formatCost(e.total_cost)}</td>
        <td class="py-3 px-4 text-right font-mono text-emerald-400">${formatEfficiency(e.output_per_dollar)} t/$</td>
        <td class="py-3 px-4 text-right font-mono text-blue-400">${formatPercent(e.cache_rate)}</td>
        <td class="py-3 px-4 text-right font-mono text-amber-400">${formatPercent(e.output_ratio)}</td>
        <td class="py-3 px-4 text-right text-sm text-gray-400">${e.days_active}</td>
        <td class="py-3 px-4 text-right text-sm text-gray-500">${timeAgo(e.last_active)}</td>
      </tr>`;
    })
    .join('');

  const sortOptions = [
    { key: 'tokens', label: 'Tokens' },
    { key: 'cost', label: 'Cost' },
    { key: 'output_per_dollar', label: 'Output/$' },
    { key: 'cache_rate', label: 'Cache Rate' },
    { key: 'output_ratio', label: 'Output Ratio' },
  ];

  // Build shared URL params
  const platformParam = platform ? `&platform=${platform}` : '';
  const viewParams = view ? `&view=${view}${dateRange ? `&date=${dateRange.startDate}` : ''}` : '';

  // Sort tabs
  const tabsHtml = sortOptions.map(s => {
    const isActive = s.key === sort;
    return `<a href="/leaderboard?sort=${s.key}${viewParams}${platformParam}" class="px-4 py-2 text-sm font-medium rounded-lg transition ${isActive ? 'bg-purple-600 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-800'}">${s.label}</a>`;
  }).join('');

  // Time filter tabs (Daily / Weekly / Monthly)
  const timeViews = (['daily', 'weekly', 'monthly'] as ViewType[]);
  const currentDateParam = dateRange ? `&date=${dateRange.startDate}` : '';
  const timeTabsHtml = [
    `<a href="/leaderboard?sort=${sort}${platformParam}" class="px-3 py-1.5 text-xs font-medium rounded-md transition ${!view ? 'bg-purple-600 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-800'}">All Time</a>`,
    ...timeViews.map(v => {
      const isActive = v === view;
      const label = v.charAt(0).toUpperCase() + v.slice(1);
      return `<a href="/leaderboard?sort=${sort}&view=${v}${currentDateParam}${platformParam}" class="px-3 py-1.5 text-xs font-medium rounded-md transition ${isActive ? 'bg-purple-600 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-800'}">${label}</a>`;
    })
  ].join('');

  // Platform filter tabs (All + one per PLATFORM_META entry)
  const platformTabsHtml = [
    { key: null, label: 'All' },
    ...PLATFORM_META.map(({ key, shortLabel }) => ({ key, label: shortLabel })),
  ].map(p => {
    const isActive = p.key === platform;
    const href = p.key ? `/leaderboard?sort=${sort}${viewParams}&platform=${p.key}` : `/leaderboard?sort=${sort}${viewParams}`;
    return `<a href="${href}" class="px-3 py-1.5 text-xs font-medium rounded-md transition ${isActive ? 'bg-emerald-600 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-800'}">${p.label}</a>`;
  }).join('');

  // Date navigation (only when a time view is active)
  let dateNavHtml = '';
  if (view && dateRange) {
    const prevHref = `/leaderboard?sort=${sort}&view=${view}&date=${dateRange.prevDate}${platformParam}`;
    const nextHref = dateRange.isCurrentPeriod ? '#' : `/leaderboard?sort=${sort}&view=${view}&date=${dateRange.nextDate}${platformParam}`;
    const nextDisabled = dateRange.isCurrentPeriod;
    dateNavHtml = `<div class="flex items-center justify-between mb-6 bg-gray-900 border border-gray-800 rounded-lg px-4 py-3">
      <a href="${prevHref}" class="text-gray-400 hover:text-white transition text-sm">&larr; Previous</a>
      <span class="text-sm font-medium text-gray-200">${escapeHtml(dateRange.label)}</span>
      ${nextDisabled
        ? '<span class="text-gray-600 text-sm cursor-not-allowed">Next &rarr;</span>'
        : `<a href="${nextHref}" class="text-gray-400 hover:text-white transition text-sm">Next &rarr;</a>`
      }
    </div>`;
  }

  const sortDescriptions: Record<string, string> = {
    tokens: 'Who\'s getting the most leverage from AI coding tools? Ranked by total token usage.',
    cost: 'Who\'s spending the most across their AI coding tools? Ranked by estimated cost.',
    output_per_dollar: 'Who gets the most code written per dollar? Masters of prompting and task scoping.',
    cache_rate: 'Who reuses context best? High cache rates mean deep, focused work on consistent projects.',
    output_ratio: 'Who gets the most output per input? Efficient prompters who let Claude do the heavy lifting.',
  };

  return layout(
    'Leaderboard',
    `<div class="mb-8">
      <div class="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 class="text-2xl font-bold mb-1">Leaderboard</h1>
          <p class="text-gray-400">${sortDescriptions[sort] || sortDescriptions.tokens}</p>
          ${isEfficiencySort ? '<p class="text-xs text-gray-600 mt-1">$100 minimum spend + 10 active days to qualify for efficiency rankings.</p>' : ''}
        </div>
        <div class="flex gap-1 flex-wrap">${tabsHtml}</div>
      </div>
    </div>

    <!-- Time filter tabs -->
    <div class="flex items-center gap-4 mb-2 flex-wrap">
      <div class="flex gap-2">${timeTabsHtml}</div>
      <div class="h-4 w-px bg-gray-700"></div>
      <div class="flex gap-2">${platformTabsHtml}</div>
    </div>
    <div class="flex items-center gap-3 mb-4 text-xs text-gray-600 flex-wrap">
      ${PLATFORM_META.map((p) => `<span class="flex items-center gap-1"><span class="w-1.5 h-1.5 rounded-full ${p.dot}"></span> ${p.shortLabel}</span>`).join('')}
    </div>

    ${dateNavHtml}

    ${entries.length === 0
      ? `<div class="text-center py-20 text-gray-500">
          <p class="text-lg mb-2">No data ${view ? 'for this period' : 'yet'}</p>
          <p class="text-sm">${view ? 'Try navigating to a different date.' : 'Be the first to upload a ccusage report!'}</p>
        </div>`
      : `<div class="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden glow">
        <div class="overflow-x-auto">
          <table class="w-full">
            <thead>
              <tr class="border-b border-gray-800 text-xs text-gray-500 uppercase tracking-wider">
                <th class="py-3 px-4 text-center w-16">Rank</th>
                <th class="py-3 px-4 text-left">User</th>
                <th class="py-3 px-4 text-right">Tokens</th>
                <th class="py-3 px-4 text-right">Cost</th>
                <th class="py-3 px-4 text-right">Output/$</th>
                <th class="py-3 px-4 text-right">Cache Rate</th>
                <th class="py-3 px-4 text-right">Output %</th>
                <th class="py-3 px-4 text-right">Days</th>
                <th class="py-3 px-4 text-right">Last Active</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>`
    }

    ${!user ? `
    <div class="mt-8 text-center">
      <p class="text-sm text-gray-500">Want to join? <a href="/login" class="text-purple-400 hover:text-purple-300 transition font-medium">Continue with Google</a></p>
    </div>` : ''}`,
    user
  );
}

export function uploadPage(user: User, message: { type: 'success' | 'error'; text: string } | null = null): string {
  const binaries = [
    {
      key: 'mac',
      label: 'macOS (Apple Silicon)',
      file: 'ccrank-git_darwin_arm64',
      download: 'https://github.com/makash/claude-leaderboard-using-ccusage/releases/latest/download/ccrank-git_darwin_arm64',
      command: 'curl -L -o ccrank-git https://github.com/makash/claude-leaderboard-using-ccusage/releases/latest/download/ccrank-git_darwin_arm64 && chmod +x ccrank-git && ./ccrank-git --url https://ccrank.dev --token YOUR_TOKEN --upload-usage',
    },
    {
      key: 'linux',
      label: 'Linux x64',
      file: 'ccrank-git_linux_amd64',
      download: 'https://github.com/makash/claude-leaderboard-using-ccusage/releases/latest/download/ccrank-git_linux_amd64',
      command: 'curl -L -o ccrank-git https://github.com/makash/claude-leaderboard-using-ccusage/releases/latest/download/ccrank-git_linux_amd64 && chmod +x ccrank-git && ./ccrank-git --url https://ccrank.dev --token YOUR_TOKEN --upload-usage',
    },
    {
      key: 'windows',
      label: 'Windows x64',
      file: 'ccrank-git_windows_amd64.exe',
      download: 'https://github.com/makash/claude-leaderboard-using-ccusage/releases/latest/download/ccrank-git_windows_amd64.exe',
      command: 'powershell -Command \"iwr -Uri https://github.com/makash/claude-leaderboard-using-ccusage/releases/latest/download/ccrank-git_windows_amd64.exe -OutFile ccrank-git.exe; .\\\\ccrank-git.exe --url https://ccrank.dev --token YOUR_TOKEN --upload-usage\"',
    },
  ];

  const cardHtml = binaries
    .map(
      (bin) => `<div class="bg-gray-900 border border-gray-800 rounded-xl p-5" data-os-card="${bin.key}">
        <button class="w-full flex items-center justify-between text-left" data-os-toggle="${bin.key}">
          <div>
            <div class="text-sm font-semibold text-gray-200">${bin.label}</div>
            <div class="text-xs text-gray-500">${bin.file}</div>
          </div>
          <span class="text-xs text-gray-400" data-os-state="${bin.key}">Show</span>
        </button>
        <div class="mt-4 hidden" data-os-panel="${bin.key}">
          <a href="${bin.download}" class="inline-flex items-center gap-2 text-sm text-purple-300 hover:text-purple-200 transition">
            Download binary
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2M7 10l5 5 5-5M12 15V3"/></svg>
          </a>
          <div class="mt-3 bg-gray-950 border border-gray-800 rounded-lg p-3">
            <div class="flex items-center justify-between mb-2">
              <span class="text-xs text-gray-500">Run</span>
              <button class="text-xs text-purple-300 hover:text-purple-200 transition" data-copy="${escapeHtml(bin.command)}">Copy</button>
            </div>
            <code class="text-xs text-gray-300 break-all">${escapeHtml(bin.command)}</code>
          </div>
        </div>
      </div>`
    )
    .join('');

  return layout(
    'Install',
    `<div class="max-w-3xl mx-auto">
      <div class="mb-8">
        <h1 class="text-3xl font-bold mb-2">Install the ccrank CLI</h1>
        <p class="text-gray-400">Your first upload should take about two minutes.</p>
      </div>

      <div class="bg-gray-900 border border-gray-800 rounded-xl p-6 mb-6">
        <h2 class="text-sm font-semibold text-gray-200 mb-2">Step 1 — Get your token</h2>
        <p class="text-sm text-gray-400 mb-4">Generate a token in Settings. You’ll only see it once.</p>
        <a href="/settings" class="inline-flex items-center gap-2 bg-purple-600 hover:bg-purple-500 text-white text-sm font-medium rounded-lg px-4 py-2.5 transition">
          Open Settings
        </a>
      </div>

      <div class="bg-gray-900 border border-gray-800 rounded-xl p-6 mb-6">
        <h2 class="text-sm font-semibold text-gray-200 mb-4">Step 2 — Download & run</h2>
        <div class="space-y-3">
          ${cardHtml}
        </div>
      </div>

      <div class="bg-gray-900 border border-gray-800 rounded-xl p-6 mb-6">
        <h2 class="text-sm font-semibold text-gray-200 mb-2">Step 3 — Add a repo</h2>
        <p class="text-sm text-gray-400 mb-3">Run this inside your project folder.</p>
        <div class="bg-gray-950 border border-gray-800 rounded-lg p-3">
          <div class="flex items-center justify-between mb-2">
            <span class="text-xs text-gray-500">Command</span>
            <button class="text-xs text-purple-300 hover:text-purple-200 transition" data-copy="ccrank-git --add-repo">Copy</button>
          </div>
          <code class="text-xs text-gray-300">ccrank-git --add-repo</code>
          <p class="text-xs text-gray-500 mt-2">Windows: <code class="bg-gray-800 px-1 rounded">ccrank-git.exe --add-repo</code></p>
        </div>
      </div>

      <div class="bg-gray-900 border border-gray-800 rounded-xl p-6 mb-6">
        <h2 class="text-sm font-semibold text-gray-200 mb-2">Multiple devices?</h2>
        <p class="text-sm text-gray-400">Add <code class="bg-gray-800 px-1 rounded">--machine laptop</code> so each device stays separate.</p>
      </div>

      <div class="bg-gray-900 border border-gray-800 rounded-xl p-6 mb-6">
        <h2 class="text-sm font-semibold text-gray-200 mb-2">Using Kimi Code, Grok CLI, GLM, Pi or OpenCode?</h2>
        <p class="text-sm text-gray-400">ccusage does not read Grok, GLM, or OpenCode, so the CLI imports those natively when you use <code class="bg-gray-800 px-1.5 py-0.5 rounded">--upload-usage</code>:</p>
        <ul class="text-sm text-gray-400 mt-2 space-y-1">
          <li>&bull; <strong class="text-gray-300">Kimi Code</strong> &mdash; <code class="bg-gray-800 px-1.5 py-0.5 rounded">~/.kimi/sessions</code> and <code class="bg-gray-800 px-1.5 py-0.5 rounded">~/.kimi-code/sessions</code>, with migrated duplicates counted once</li>
          <li>&bull; <strong class="text-gray-300">Grok CLI</strong> &mdash; <code class="bg-gray-800 px-1.5 py-0.5 rounded">~/.grok/sessions</code>, counting each completed turn once even after a rewind</li>
          <li>&bull; <strong class="text-gray-300">GLM (Z Code)</strong> &mdash; <code class="bg-gray-800 px-1.5 py-0.5 rounded">~/.zcode/cli/rollout</code>, with retries of a request counted once</li>
          <li>&bull; <strong class="text-gray-300">Pi</strong> &mdash; <code class="bg-gray-800 px-1.5 py-0.5 rounded">~/.pi/agent/sessions</code>, ranked on its own platform</li>
          <li>&bull; <strong class="text-gray-300">OpenCode</strong> &mdash; <code class="bg-gray-800 px-1.5 py-0.5 rounded">~/.local/share/opencode/opencode.db</code>, read read-only from its session database</li>
        </ul>
        <p class="text-sm text-gray-400 mt-3">A model Pi merely fronts is credited to the vendor that owns it, so a Kimi, Grok, or GLM model run through Pi lands on that platform rather than on Pi. Only aggregated usage is uploaded&mdash;never raw prompts or responses.</p>
      </div>

      <div class="bg-gray-900 border border-gray-800 rounded-xl p-6 mb-6">
        <h2 class="text-sm font-semibold text-gray-200 mb-2">Using OpenAI Codex CLI?</h2>
        <p class="text-sm text-gray-400 mb-3">ccrank also supports Codex CLI usage data. Use <code class="bg-gray-800 px-1.5 py-0.5 rounded">@ccusage/codex</code> to generate your report:</p>
        <div class="bg-gray-950 border border-gray-800 rounded-lg p-3">
          <div class="flex items-center justify-between mb-2">
            <span class="text-xs text-gray-500">Command</span>
            <button class="text-xs text-purple-300 hover:text-purple-200 transition" data-copy="npx @ccusage/codex@latest daily --json">Copy</button>
          </div>
          <code class="text-xs text-gray-300">npx @ccusage/codex@latest daily --json</code>
        </div>
        <p class="text-xs text-gray-500 mt-3">Same upload process &mdash; paste the JSON output or upload the file. Works with GPT-5, codex-mini, and all Codex models.</p>
      </div>

      <div class="bg-gray-900/60 border border-gray-800/60 rounded-xl p-6">
        <h2 class="text-sm font-semibold text-gray-200 mb-2">Troubleshooting</h2>
        <p class="text-sm text-gray-400">No Node installed? We recommend <a href="https://mise.jdx.dev" target="_blank" rel="noopener" class="text-purple-300 hover:text-purple-200 transition">mise</a>. Then run:</p>
        <div class="bg-gray-950 border border-gray-800 rounded-lg p-3 mt-3">
          <div class="flex items-center justify-between mb-2">
            <span class="text-xs text-gray-500">Claude Code</span>
            <button class="text-xs text-purple-300 hover:text-purple-200 transition" data-copy="npx ccusage@latest daily --json">Copy</button>
          </div>
          <code class="text-xs text-gray-300">npx ccusage@latest daily --json</code>
        </div>
        <div class="bg-gray-950 border border-gray-800 rounded-lg p-3 mt-2">
          <div class="flex items-center justify-between mb-2">
            <span class="text-xs text-gray-500">Codex CLI</span>
            <button class="text-xs text-purple-300 hover:text-purple-200 transition" data-copy="npx @ccusage/codex@latest daily --json">Copy</button>
          </div>
          <code class="text-xs text-gray-300">npx @ccusage/codex@latest daily --json</code>
        </div>
      </div>
    </div>

    <script>
      (function() {
        const ua = navigator.userAgent.toLowerCase();
        let detected = 'mac';
        if (ua.includes('windows')) detected = 'windows';
        else if (ua.includes('linux')) detected = 'linux';

        const expand = (key) => {
          document.querySelectorAll('[data-os-panel]').forEach((el) => el.classList.add('hidden'));
          document.querySelectorAll('[data-os-state]').forEach((el) => (el.textContent = 'Show'));
          const panel = document.querySelector('[data-os-panel=\"' + key + '\"]');
          const state = document.querySelector('[data-os-state=\"' + key + '\"]');
          if (panel) panel.classList.remove('hidden');
          if (state) state.textContent = 'Hide';
        };

        expand(detected);

        document.querySelectorAll('[data-os-toggle]').forEach((btn) => {
          btn.addEventListener('click', () => {
            const key = btn.getAttribute('data-os-toggle');
            if (key) expand(key);
          });
        });

        document.querySelectorAll('[data-copy]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            const text = btn.getAttribute('data-copy');
            if (!text) return;
            try {
              await navigator.clipboard.writeText(text);
              const original = btn.textContent;
              btn.textContent = 'Copied';
              setTimeout(() => { btn.textContent = original; }, 1200);
            } catch {
              btn.textContent = 'Copy failed';
            }
          });
        });
      })();
    </script>`,
    user
  );
}

export function invitesPage(user: User, codes: { code: string; used_by: string | null; use_count: number; max_uses: number }[]): string {
  const rows = codes
    .map(
      (c) => `<tr class="border-b border-gray-800/50">
        <td class="py-2 px-4 font-mono text-sm tracking-wider">${escapeHtml(c.code)}</td>
        <td class="py-2 px-4 text-sm text-gray-400">${c.use_count} / ${c.max_uses}</td>
        <td class="py-2 px-4 text-sm">${c.use_count >= c.max_uses ? '<span class="text-gray-500">Used</span>' : '<span class="text-green-400">Available</span>'}</td>
      </tr>`
    )
    .join('');

  return layout(
    'Invites',
    `<div class="max-w-2xl mx-auto">
      <div class="mb-8">
        <h1 class="text-2xl font-bold mb-1">Your Invite Codes</h1>
        <p class="text-gray-400">Share these with friends to let them join. You have ${user.invites_remaining} invite(s) remaining.</p>
      </div>

      ${user.invites_remaining > 0
        ? `<form method="POST" action="/api/invites/create" class="mb-6">
            <button type="submit" class="bg-purple-600 hover:bg-purple-500 text-white font-medium rounded-lg px-6 py-2.5 text-sm transition" id="gen-btn">
              Generate Invite Code
            </button>
          </form>
          <script>
            document.querySelector('form').addEventListener('submit', async (e) => {
              e.preventDefault();
              const btn = document.getElementById('gen-btn');
              btn.disabled = true;
              btn.textContent = 'Generating...';
              const res = await fetch('/api/invites/create', { method: 'POST' });
              if (res.ok) window.location.reload();
              else { alert('Failed to generate invite'); btn.disabled = false; btn.textContent = 'Generate Invite Code'; }
            });
          </script>`
        : '<p class="mb-6 text-sm text-gray-500">You have no invites remaining.</p>'
      }

      ${codes.length > 0
        ? `<div class="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
            <table class="w-full">
              <thead>
                <tr class="border-b border-gray-800 text-xs text-gray-500 uppercase tracking-wider">
                  <th class="py-2 px-4 text-left">Code</th>
                  <th class="py-2 px-4 text-left">Uses</th>
                  <th class="py-2 px-4 text-left">Status</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>`
        : '<p class="text-gray-500 text-sm">No invite codes generated yet.</p>'
      }
    </div>`,
    user
  );
}

export function adminPage(
  user: User,
  stats: { total_users: number; total_uploads: number; total_invites: number },
  codes: { code: string; use_count: number; max_uses: number; created_by_name: string | null }[]
): string {
  const rows = codes
    .map(
      (c) => `<tr class="border-b border-gray-800/50">
        <td class="py-2 px-4 font-mono text-sm tracking-wider">${escapeHtml(c.code)}</td>
        <td class="py-2 px-4 text-sm text-gray-400">${c.use_count} / ${c.max_uses}</td>
        <td class="py-2 px-4 text-sm text-gray-400">${c.created_by_name ? escapeHtml(c.created_by_name) : 'System'}</td>
      </tr>`
    )
    .join('');

  return layout(
    'Admin',
    `<div class="max-w-4xl mx-auto">
      <div class="mb-8">
        <h1 class="text-2xl font-bold mb-1 text-yellow-400">Admin Panel</h1>
      </div>

      <div class="grid grid-cols-3 gap-4 mb-8">
        <div class="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <div class="text-sm text-gray-400 mb-1">Total Users</div>
          <div class="text-2xl font-bold">${stats.total_users}</div>
        </div>
        <div class="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <div class="text-sm text-gray-400 mb-1">Total Uploads</div>
          <div class="text-2xl font-bold">${stats.total_uploads}</div>
        </div>
        <div class="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <div class="text-sm text-gray-400 mb-1">Invite Codes</div>
          <div class="text-2xl font-bold">${stats.total_invites}</div>
        </div>
      </div>

      <div class="mb-6">
        <h2 class="text-lg font-semibold mb-4">Generate Bulk Invite Codes</h2>
        <form class="flex gap-3" id="admin-invite-form">
          <input type="number" id="invite-count" value="5" min="1" max="50" class="w-24 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-purple-500">
          <input type="number" id="invite-max-uses" value="1" min="1" max="100" placeholder="Max uses" class="w-24 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-purple-500">
          <button type="submit" class="bg-yellow-600 hover:bg-yellow-500 text-white font-medium rounded-lg px-6 py-2 text-sm transition" id="admin-gen-btn">
            Generate
          </button>
        </form>
        <script>
          document.getElementById('admin-invite-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const btn = document.getElementById('admin-gen-btn');
            const count = document.getElementById('invite-count').value;
            const maxUses = document.getElementById('invite-max-uses').value;
            btn.disabled = true;
            btn.textContent = 'Generating...';
            const res = await fetch('/api/admin/invites', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ count: parseInt(count), maxUses: parseInt(maxUses) }),
            });
            if (res.ok) window.location.reload();
            else { alert('Failed'); btn.disabled = false; btn.textContent = 'Generate'; }
          });
        </script>
      </div>

      ${codes.length > 0
        ? `<div class="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
            <table class="w-full">
              <thead>
                <tr class="border-b border-gray-800 text-xs text-gray-500 uppercase tracking-wider">
                  <th class="py-2 px-4 text-left">Code</th>
                  <th class="py-2 px-4 text-left">Uses</th>
                  <th class="py-2 px-4 text-left">Created By</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>`
        : ''
      }
    </div>`,
    user
  );
}

export function aboutPage(user: User | null = null): string {
  return layout(
    'About',
    `<div class="max-w-2xl mx-auto">
      <h1 class="text-3xl font-extrabold mb-2">The Story Behind ccrank.dev</h1>
      <p class="text-gray-400 mb-10">How a WhatsApp message became a live leaderboard in minutes.</p>

      <p class="text-gray-400 mb-8 text-lg leading-relaxed">
        ccrank.dev is an open-source developer ranking platform for Claude Code, Codex CLI, Kimi, Grok, GLM, Pi, and OpenCode token usage.
        Track, compare, and compete on your team's AI-assisted development metrics.
      </p>

      <!-- The Spark -->
      <section class="mb-10">
        <h2 class="text-xl font-bold mb-4 text-purple-400">The Spark</h2>
        <p class="text-gray-300 leading-relaxed mb-4">
          It started with a message in a WhatsApp group. <strong class="text-white">Thiyagarajan Maruthavanan (Rajan)</strong> dropped a simple idea:
        </p>
        <div class="bg-green-900/20 border border-green-800/30 rounded-xl p-5 mb-4">
          <p class="text-sm text-gray-300 italic">
            &ldquo;Code a Leaderboard Vivek? Let everyone submit their ccusage :)&rdquo;
          </p>
        </div>
        <img src="${IMG_RAJAN_MESSAGE}" alt="Rajan's original WhatsApp message suggesting the leaderboard" class="rounded-lg border border-gray-800 w-full mb-4" loading="lazy">
      </section>

      <!-- Built on a Phone -->
      <section class="mb-10">
        <h2 class="text-xl font-bold mb-4 text-cyan-400">Built on a Phone</h2>
        <p class="text-gray-300 leading-relaxed mb-4">
          <strong class="text-white">Akash</strong> saw the message and thought &mdash; why not? He opened Claude Code on his phone,
          described what he wanted, and let Claude build it. The entire app was generated, deployed, and live in minutes.
        </p>
        <p class="text-gray-400 text-sm mb-4 italic">
          &ldquo;The only hardwork I had to do was run 4 npm commands.&rdquo;
        </p>
        <img src="${IMG_CLAUDE_BUILDING}" alt="Claude Code building the leaderboard app" class="rounded-lg border border-gray-800 w-full mb-4" loading="lazy">
      </section>

      <!-- Sharing it -->
      <section class="mb-10">
        <h2 class="text-xl font-bold mb-4 text-pink-400">Going Live</h2>
        <p class="text-gray-300 leading-relaxed mb-4">
          Minutes later, the app was live on Cloudflare Workers. Akash shared the link in the group, and people started running the CLI immediately.
        </p>
        <img src="${IMG_APP_SHARED}" alt="Sharing the live app in the WhatsApp group" class="rounded-lg border border-gray-800 w-full mb-4" loading="lazy">
        <p class="text-gray-300 leading-relaxed mb-4">
          Then came the domain &mdash; <strong class="text-white">ccrank.dev</strong> &mdash; because every side project deserves a proper home.
        </p>
        <img src="${IMG_DOMAIN_PURCHASE}" alt="Buying the ccrank.dev domain" class="rounded-lg border border-gray-800 w-full mb-4" loading="lazy">
      </section>

      <!-- What it's for -->
      <section class="mb-10">
        <h2 class="text-xl font-bold mb-4 text-yellow-400">What This Leaderboard Is For</h2>
        <ul class="text-gray-300 space-y-2">
          <li class="flex items-start gap-2"><span class="text-purple-400 mt-1">&#x2022;</span> Track AI coding token usage across days, weeks, tools, and machines</li>
          <li class="flex items-start gap-2"><span class="text-purple-400 mt-1">&#x2022;</span> Friendly competition &mdash; who&rsquo;s getting the most AI coding leverage?</li>
          <li class="flex items-start gap-2"><span class="text-purple-400 mt-1">&#x2022;</span> Compare Claude Code, Codex CLI, Kimi, Grok, GLM, and Pi on one profile</li>
          <li class="flex items-start gap-2"><span class="text-purple-400 mt-1">&#x2022;</span> Fun titles &mdash; from Apprentice to Token Maximalist</li>
        </ul>
      </section>

      <!-- How it works -->
      <section class="mb-10">
        <h2 class="text-xl font-bold mb-4 text-green-400">How It Works</h2>
        <ol class="text-gray-300 space-y-3">
          <li class="flex items-start gap-3">
            <span class="bg-purple-600 text-white text-xs font-bold w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5">1</span>
            <span>Generate your token in <a href="/settings" class="text-purple-400 hover:text-purple-300 transition">Settings</a></span>
          </li>
          <li class="flex items-start gap-3">
            <span class="bg-purple-600 text-white text-xs font-bold w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5">2</span>
            <span>Download the ccrank CLI and run it from your project folder</span>
          </li>
          <li class="flex items-start gap-3">
            <span class="bg-purple-600 text-white text-xs font-bold w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5">3</span>
            <span>See your rank, earn titles, and compete with others</span>
          </li>
        </ol>
      </section>

      <!-- Credits -->
      <section class="mb-10">
        <h2 class="text-xl font-bold mb-4 text-gray-300">Credits</h2>
        <div class="bg-gray-900 border border-gray-800 rounded-xl p-6 space-y-4">
          <div>
            <div class="text-sm font-semibold text-white mb-1">Powered by ccusage</div>
            <p class="text-sm text-gray-400">
              <a href="https://github.com/ryoppippi/ccusage?utm_source=claude-leaderboard&utm_medium=web&utm_campaign=about" target="_blank" rel="noopener" class="text-purple-400 hover:text-purple-300 transition">ccusage</a>
              by <strong class="text-gray-300">ryoppippi</strong> powers Claude Code, Codex, and the other agents it detects; ccrank&rsquo;s native importers add Kimi Code, Grok CLI, GLM, and Pi.
              Without it, there&rsquo;d be no data to leaderboard.
            </p>
          </div>
          <div class="border-t border-gray-800 pt-4">
            <div class="text-sm font-semibold text-white mb-1">Built with</div>
            <p class="text-sm text-gray-400">
              <a href="https://claude.ai" target="_blank" rel="noopener" class="text-purple-400 hover:text-purple-300 transition">Claude Code</a> +
              <a href="https://hono.dev" target="_blank" rel="noopener" class="text-purple-400 hover:text-purple-300 transition">Hono</a> +
              <a href="https://workers.cloudflare.com" target="_blank" rel="noopener" class="text-purple-400 hover:text-purple-300 transition">Cloudflare Workers</a> +
              <a href="https://developers.cloudflare.com/d1/" target="_blank" rel="noopener" class="text-purple-400 hover:text-purple-300 transition">D1</a>
            </p>
          </div>
          <div class="border-t border-gray-800 pt-4">
            <div class="text-sm font-semibold text-white mb-1">The spark</div>
            <p class="text-sm text-gray-400">
              <strong class="text-gray-300">Thiyagarajan Maruthavanan (Rajan)</strong> &mdash; for the idea that started it all.
            </p>
          </div>
        </div>
      </section>

      <div class="text-center">
        <a href="/" class="text-purple-400 hover:text-purple-300 transition">&larr; Back to home</a>
      </div>
    </div>`,
    user
  );
}

export function historyPage(
  view: ViewType,
  dateRange: DateRange,
  entries: LeaderboardEntry[],
  user: User | null = null,
  platform: string | null = null
): string {
  const histPlatformParam = platform ? `&platform=${platform}` : '';
  const tabs = (['daily', 'weekly', 'monthly'] as ViewType[]).map(v => {
    const isActive = v === view;
    const label = v.charAt(0).toUpperCase() + v.slice(1);
    const href = `/history?view=${v}${histPlatformParam}`;
    return `<a href="${href}" class="px-4 py-2 text-sm font-medium rounded-lg transition ${isActive ? 'bg-purple-600 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-800'}">${label}</a>`;
  }).join('');

  // Platform filter tabs
  const histPlatformTabs = [
    { key: null, label: 'All' },
    ...PLATFORM_META.map(({ key, shortLabel }) => ({ key, label: shortLabel })),
  ].map(p => {
    const isActive = p.key === platform;
    const href = p.key ? `/history?view=${view}&platform=${p.key}` : `/history?view=${view}`;
    return `<a href="${href}" class="px-3 py-1.5 text-xs font-medium rounded-md transition ${isActive ? 'bg-emerald-600 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-800'}">${p.label}</a>`;
  }).join('');

  const rows = entries.length > 0
    ? entries.map((e) => {
        const title = getTitle(e.total_tokens);
        const rankClass = e.rank <= 3 ? `rank-${e.rank}` : '';
        const medal = e.rank === 1 ? '<span class="text-yellow-400 mr-1">&#x1f947;</span>' : e.rank === 2 ? '<span class="text-gray-300 mr-1">&#x1f948;</span>' : e.rank === 3 ? '<span class="text-amber-600 mr-1">&#x1f949;</span>' : '';
        const profileHref = e.share_slug ? `/user/${escapeHtml(e.share_slug)}` : '#';
        const clickableClass = e.share_slug ? 'cursor-pointer' : '';
        const rowClick = e.share_slug ? `onclick="window.location.href='${profileHref}'"` : '';
        return `<tr class="border-b border-gray-800/50 hover:bg-gray-800/30 transition ${rankClass} ${clickableClass}" ${rowClick}>
          <td class="py-3 px-4 text-center font-mono text-sm">${medal}${e.rank}</td>
          <td class="py-3 px-4">
            <div class="flex items-center gap-3">
              ${e.avatar_url ? `<img src="${escapeHtml(e.avatar_url)}" class="w-8 h-8 rounded-full" alt="">` : `<div class="w-8 h-8 rounded-full bg-purple-600 flex items-center justify-center text-xs font-bold">${escapeHtml(e.display_name.charAt(0))}</div>`}
              <div>
                <div class="font-medium">${e.share_slug
                  ? `<a href="${profileHref}" class="hover:text-purple-400 transition">${escapeHtml(e.display_name)}</a>`
                  : escapeHtml(e.display_name)}</div>
                <div class="text-xs" style="color:${title.color}">${title.label}</div>
              </div>
            </div>
          </td>
          <td class="py-3 px-4 text-right font-mono text-cyan-400">${formatTokens(e.total_tokens)}</td>
          <td class="py-3 px-4 text-right font-mono text-purple-400">${formatCost(e.total_cost)}</td>
          <td class="py-3 px-4 text-right text-sm text-gray-400">${e.days_active}</td>
        </tr>`;
      }).join('')
    : '';

  const prevHref = `/history?view=${view}&date=${dateRange.prevDate}${histPlatformParam}`;
  const nextHref = dateRange.isCurrentPeriod ? '#' : `/history?view=${view}&date=${dateRange.nextDate}${histPlatformParam}`;
  const nextDisabled = dateRange.isCurrentPeriod;

  return layout(
    'History',
    `<div class="max-w-4xl mx-auto">
      <div class="mb-8">
        <h1 class="text-2xl font-bold mb-1">History</h1>
        <p class="text-gray-400">Browse historical leaderboard rankings.</p>
      </div>

      <!-- Tabs -->
      <div class="flex items-center gap-4 mb-6 flex-wrap">
        <div class="flex gap-2">${tabs}</div>
        <div class="h-4 w-px bg-gray-700"></div>
        <div class="flex gap-2">${histPlatformTabs}</div>
      </div>

      <!-- Date navigation -->
      <div class="flex items-center justify-between mb-6 bg-gray-900 border border-gray-800 rounded-lg px-4 py-3">
        <a href="${prevHref}" class="text-gray-400 hover:text-white transition text-sm">&larr; Previous</a>
        <span class="text-sm font-medium text-gray-200">${escapeHtml(dateRange.label)}</span>
        ${nextDisabled
          ? '<span class="text-gray-600 text-sm cursor-not-allowed">Next &rarr;</span>'
          : `<a href="${nextHref}" class="text-gray-400 hover:text-white transition text-sm">Next &rarr;</a>`
        }
      </div>

      ${entries.length === 0
        ? `<div class="text-center py-16 text-gray-500">
            <p class="text-lg mb-2">No data for this period</p>
            <p class="text-sm">Try navigating to a different date.</p>
          </div>`
        : `<div class="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden glow">
          <div class="overflow-x-auto">
            <table class="w-full">
              <thead>
                <tr class="border-b border-gray-800 text-xs text-gray-500 uppercase tracking-wider">
                  <th class="py-3 px-4 text-center w-16">Rank</th>
                  <th class="py-3 px-4 text-left">User</th>
                  <th class="py-3 px-4 text-right">Tokens</th>
                  <th class="py-3 px-4 text-right">Cost</th>
                  <th class="py-3 px-4 text-right">Days</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </div>`
      }
    </div>`,
    user
  );
}

export function cardPage(
  cardUser: { display_name: string; avatar_url: string | null; share_slug: string },
  stats: { total_cost: number; total_tokens: number; total_output_tokens: number; days_active: number; rank: number; last_active: string | null },
  mode: 'simple' | 'full'
): string {
  const title = getTitle(stats.total_tokens);
  const rankLabel = `#${stats.rank}`;
  const rankColor = stats.rank === 1 ? '#eab308' : stats.rank === 2 ? '#9ca3af' : stats.rank === 3 ? '#b45309' : '#7c3aed';
  const cardUrl = `https://ccrank.dev/card/${escapeHtml(cardUser.share_slug)}`;
  const imageUrl = `https://ccrank.dev/card/${escapeHtml(cardUser.share_slug)}/image.png`;
  const tweetText = encodeURIComponent(`I'm ranked ${rankLabel} on the ccrank.dev token leaderboard with ${formatTokens(stats.total_tokens)} tokens! Check your ranking at ccrank.dev`);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(cardUser.display_name)}'s AI Coding Stats - ccrank.dev</title>
  <meta property="og:title" content="${escapeHtml(cardUser.display_name)} - ${rankLabel} on the AI Coding Token Leaderboard | ccrank.dev">
  <meta property="og:description" content="${title.label} with ${formatTokens(stats.total_tokens)} tokens across AI coding tools. ${stats.days_active} days active.">
  <meta property="og:image" content="${imageUrl}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:url" content="${cardUrl}">
  <meta property="og:type" content="profile">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(cardUser.display_name)} - ${rankLabel} on the AI Coding Token Leaderboard | ccrank.dev">
  <meta name="twitter:description" content="${title.label} with ${formatTokens(stats.total_tokens)} tokens. ${stats.days_active} days active.">
  <meta name="twitter:image" content="${imageUrl}">
  <meta name="twitter:creator" content="@makash">
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>&#x1f3c6;</text></svg>">
  <style>
    body { background: #0f0f1a; color: #e2e8f0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
  </style>
</head>
<body class="min-h-screen flex flex-col items-center justify-center p-4">

  <!-- Card -->
  <div id="stats-card" class="w-full max-w-lg bg-gray-900 border border-gray-700 rounded-2xl overflow-hidden shadow-2xl">
    <!-- Top accent -->
    <div class="h-1.5" style="background: linear-gradient(90deg, ${rankColor}, #7c3aed);"></div>

    <div class="p-8">
      <!-- Header -->
      <div class="flex items-center gap-5 mb-6">
        <div class="text-4xl font-bold" style="color: ${rankColor};">${rankLabel}</div>
        <div>
          <div class="flex items-center gap-3">
            ${cardUser.avatar_url
              ? `<img src="${escapeHtml(cardUser.avatar_url)}" class="w-12 h-12 rounded-full ring-2" style="--tw-ring-color: ${rankColor};" alt="">`
              : `<div class="w-12 h-12 rounded-full bg-purple-600 flex items-center justify-center text-lg font-bold">${escapeHtml(cardUser.display_name.charAt(0))}</div>`}
            <div>
              <div class="text-xl font-bold text-gray-100">${escapeHtml(cardUser.display_name)}</div>
              <div class="text-sm font-semibold" style="color: ${title.color};">${title.label}</div>
            </div>
          </div>
        </div>
      </div>

      <!-- Main stat -->
      <div class="mb-6">
        <div class="text-5xl font-bold text-cyan-400">${formatTokens(stats.total_tokens)}</div>
        <div class="text-sm text-gray-500 mt-1">total tokens across AI coding tools</div>
      </div>

      <!-- Stats grid -->
      <div class="grid grid-cols-3 gap-4 ${mode === 'full' ? 'mb-6' : ''}">
        <div>
          <div class="text-xl font-bold text-purple-400">${formatCost(stats.total_cost)}</div>
          <div class="text-xs text-gray-500">Estimated Cost</div>
        </div>
        <div>
          <div class="text-xl font-bold text-green-400">${formatTokens(stats.total_output_tokens)}</div>
          <div class="text-xs text-gray-500">Output Tokens</div>
        </div>
        <div>
          <div class="text-xl font-bold text-yellow-400">${stats.days_active}</div>
          <div class="text-xs text-gray-500">Days Active</div>
        </div>
      </div>

      ${mode === 'full' && stats.last_active ? `
      <div class="text-sm text-gray-500">Last active: ${escapeHtml(stats.last_active)}</div>
      ` : ''}
    </div>

    <!-- Footer -->
    <div class="px-8 py-4 bg-gray-800/50 border-t border-gray-800 flex items-center justify-between">
      <span class="text-sm text-gray-400">ccrank.dev</span>
      <span class="text-xs text-gray-600">AI Coding Token Leaderboard</span>
    </div>
  </div>

  <!-- Action buttons -->
  <div class="flex gap-3 mt-6">
    <a href="https://x.com/intent/tweet?text=${tweetText}&url=${encodeURIComponent(cardUrl)}"
       target="_blank" rel="noopener"
       class="flex items-center gap-2 bg-gray-800 hover:bg-gray-700 text-white text-sm font-medium rounded-lg px-5 py-2.5 transition">
      <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
      Share on X
    </a>
    <button id="download-btn"
       class="flex items-center gap-2 bg-gray-800 hover:bg-gray-700 text-white text-sm font-medium rounded-lg px-5 py-2.5 transition cursor-pointer">
      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
      Download PNG
    </button>
    <button onclick="navigator.clipboard.writeText('${cardUrl}').then(()=>{this.textContent='Copied!';setTimeout(()=>this.textContent='Copy Link',2000)})"
       class="flex items-center gap-2 bg-gray-800 hover:bg-gray-700 text-white text-sm font-medium rounded-lg px-5 py-2.5 transition cursor-pointer">
      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3"/></svg>
      Copy Link
    </button>
  </div>

  <!-- Mode toggle -->
  <div class="mt-4">
    <a href="/card/${escapeHtml(cardUser.share_slug)}?mode=${mode === 'simple' ? 'full' : 'simple'}"
       class="text-sm text-purple-400 hover:text-purple-300 transition">
      Switch to ${mode === 'simple' ? 'full' : 'simple'} card
    </a>
  </div>

  <!-- CTA for viewers -->
  <div class="mt-8 text-center">
    <p class="text-sm text-gray-500 mb-2">Track your own AI coding token usage</p>
    <a href="/" class="text-purple-400 hover:text-purple-300 font-medium transition">Join at ccrank.dev</a>
  </div>

  <script>
  document.getElementById('download-btn').addEventListener('click', async function() {
    const btn = this;
    btn.textContent = 'Generating...';
    try {
      const res = await fetch('${imageUrl}');
      const svgText = await res.text();
      const canvas = document.createElement('canvas');
      canvas.width = 1200;
      canvas.height = 630;
      const ctx = canvas.getContext('2d');
      const img = new Image();
      img.onload = function() {
        ctx.drawImage(img, 0, 0);
        const a = document.createElement('a');
        a.download = '${escapeHtml(cardUser.share_slug)}-card.png';
        a.href = canvas.toDataURL('image/png');
        a.click();
        btn.textContent = 'Download PNG';
      };
      img.onerror = function() {
        // Fallback: download SVG directly
        const blob = new Blob([svgText], { type: 'image/svg+xml' });
        const a = document.createElement('a');
        a.download = '${escapeHtml(cardUser.share_slug)}-card.svg';
        a.href = URL.createObjectURL(blob);
        a.click();
        btn.textContent = 'Download PNG';
      };
      img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgText)));
    } catch(e) {
      btn.textContent = 'Download PNG';
      alert('Failed to generate image');
    }
  });
  </script>

</body>
</html>`;
}

export function settingsPage(
  user: User,
  shareUrl: string | null,
  tokens: { id: string; token_prefix: string; created_at: string; last_used_at: string | null }[],
  gitProjects: { id: string; repo_name: string; repo_slug: string; description: string; description_override: number }[]
): string {
  const favTools: string[] = (() => {
    try { return JSON.parse(user.fav_tools || '[]'); } catch { return []; }
  })();

  const tokensHtml = tokens.length > 0
    ? tokens.map((t) => `
        <div class="flex items-center justify-between bg-gray-800/50 border border-gray-700 rounded-lg px-3 py-2">
          <div>
            <div class="text-sm text-gray-300 font-mono">token_${escapeHtml(t.token_prefix)}</div>
            <div class="text-xs text-gray-500">Created ${escapeHtml(t.created_at)}${t.last_used_at ? ` · Last used ${escapeHtml(t.last_used_at)}` : ''}</div>
          </div>
          <button data-token-id="${escapeHtml(t.id)}" class="revoke-token text-xs bg-red-600/20 hover:bg-red-600/30 text-red-300 border border-red-700/40 px-3 py-1 rounded transition">Revoke</button>
        </div>
      `).join('')
    : `<p class="text-sm text-gray-500">No API tokens yet.</p>`;

  const projectsHtml = gitProjects.length > 0
    ? gitProjects.map((p) => `
        <div class="bg-gray-800/50 border border-gray-700 rounded-lg p-3 mb-3">
          <div class="text-sm font-semibold text-gray-200 mb-2">${escapeHtml(p.repo_name)}</div>
          <div class="text-xs text-gray-500 mb-2">${escapeHtml(p.repo_slug)}</div>
          <textarea data-project-id="${escapeHtml(p.id)}" class="project-desc w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-purple-500 transition" rows="2" maxlength="200">${escapeHtml(p.description)}</textarea>
          <div class="flex items-center justify-between mt-2">
            <span class="text-xs text-gray-500">${p.description_override ? 'Custom description' : 'Auto-derived'}</span>
            <button data-project-id="${escapeHtml(p.id)}" class="save-project text-xs bg-purple-600/30 hover:bg-purple-600/40 text-purple-200 border border-purple-700/40 px-3 py-1 rounded transition">Save</button>
          </div>
        </div>
      `).join('')
    : `<p class="text-sm text-gray-500">No git projects uploaded yet.</p>`;

  return layout(
    'Settings',
    `<div class="max-w-2xl mx-auto">
      <h1 class="text-2xl font-bold mb-6">Settings</h1>

      <!-- Sharing Section -->
      <div class="bg-gray-900 border border-gray-800 rounded-xl p-6 mb-6">
        <h2 class="text-lg font-semibold mb-4">Social Stats Card</h2>
        <p class="text-sm text-gray-400 mb-4">Share your usage ranking as a beautiful card on Twitter/LinkedIn.</p>

        <form id="sharing-form" class="space-y-4">
          <div class="flex items-center justify-between">
            <label class="text-sm text-gray-300">Make my stats card public</label>
            <button type="button" id="sharing-toggle"
              class="relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out ${user.sharing_enabled ? 'bg-purple-600' : 'bg-gray-700'}"
              role="switch" aria-checked="${user.sharing_enabled ? 'true' : 'false'}">
              <span class="pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${user.sharing_enabled ? 'translate-x-5' : 'translate-x-0'}"></span>
            </button>
          </div>

          <div id="slug-section" class="${user.sharing_enabled ? '' : 'hidden'}">
            <label class="block text-sm text-gray-400 mb-2">Your card URL slug</label>
            <div class="flex items-center gap-2">
              <span class="text-sm text-gray-500">ccrank.dev/card/</span>
              <input type="text" id="share-slug" value="${escapeHtml(user.share_slug || '')}"
                placeholder="your-name"
                class="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-purple-500 transition"
                maxlength="30" pattern="[a-z0-9][a-z0-9-]*[a-z0-9]">
            </div>
            <p class="text-xs text-gray-600 mt-1">Lowercase letters, numbers, and hyphens only</p>
          </div>

          <button type="submit" id="save-btn"
            class="bg-purple-600 hover:bg-purple-500 text-white text-sm font-medium rounded-lg px-5 py-2.5 transition">
            Save Settings
          </button>

          <div id="settings-message" class="hidden text-sm mt-2"></div>
        </form>

        ${shareUrl ? `
        <div class="mt-6 pt-6 border-t border-gray-800">
          <p class="text-sm text-gray-400 mb-3">Your card is live:</p>
          <div class="flex items-center gap-3">
            <a href="${escapeHtml(shareUrl)}" target="_blank" class="text-purple-400 hover:text-purple-300 text-sm transition">${escapeHtml(shareUrl)}</a>
            <button onclick="navigator.clipboard.writeText('${escapeHtml(shareUrl)}').then(()=>{this.textContent='Copied!';setTimeout(()=>this.textContent='Copy',2000)})"
              class="text-xs bg-gray-800 hover:bg-gray-700 text-white px-3 py-1 rounded transition cursor-pointer">Copy</button>
          </div>
        </div>` : ''}
      </div>

      <!-- Favorite Tools Section -->
      <div class="bg-gray-900 border border-gray-800 rounded-xl p-6 mb-6">
        <h2 class="text-lg font-semibold mb-2">Favorite Tools</h2>
        <p class="text-sm text-gray-400 mb-4">What are the AI coding tools or plugins you can't live without? (shown on your profile)</p>
        <div class="space-y-3">
          <input type="text" id="fav-tool-1" value="${escapeHtml(favTools[0] || '')}"
            placeholder="e.g. playwright MCP"
            class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-purple-500 transition"
            maxlength="50">
          <input type="text" id="fav-tool-2" value="${escapeHtml(favTools[1] || '')}"
            placeholder="e.g. git-worktree"
            class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-purple-500 transition"
            maxlength="50">
          <input type="text" id="fav-tool-3" value="${escapeHtml(favTools[2] || '')}"
            placeholder="e.g. sentry skill"
            class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-purple-500 transition"
            maxlength="50">
        </div>
        <button type="button" id="save-tools-btn"
          class="mt-4 bg-purple-600 hover:bg-purple-500 text-white text-sm font-medium rounded-lg px-5 py-2.5 transition">
          Save Tools
        </button>
        <div id="tools-message" class="hidden text-sm mt-2"></div>
      </div>

      <!-- Git Metadata Section -->
      <div class="bg-gray-900 border border-gray-800 rounded-xl p-6 mb-6">
        <h2 class="text-lg font-semibold mb-2">Git Metadata</h2>
        <p class="text-sm text-gray-400 mb-4">Control visibility and manage your CLI upload tokens.</p>

        <div class="flex items-center justify-between mb-4">
          <label class="text-sm text-gray-300">Show git metadata on my profile</label>
          <button type="button" id="git-sharing-toggle"
            class="relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out ${user.git_sharing_enabled ? 'bg-purple-600' : 'bg-gray-700'}"
            role="switch" aria-checked="${user.git_sharing_enabled ? 'true' : 'false'}">
            <span class="pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${user.git_sharing_enabled ? 'translate-x-5' : 'translate-x-0'}"></span>
          </button>
        </div>

        <div id="git-sharing-message" class="hidden text-sm mt-2"></div>

        <div class="mt-6 pt-6 border-t border-gray-800">
          <div class="flex items-center justify-between mb-3">
            <h3 class="text-sm font-semibold text-gray-200">API Tokens</h3>
            <button id="create-token" class="text-xs bg-purple-600 hover:bg-purple-500 text-white px-3 py-1.5 rounded transition">Generate Token</button>
          </div>
          <div id="token-list" class="space-y-2">${tokensHtml}</div>
          <div id="new-token" class="hidden mt-3 bg-gray-800 border border-gray-700 rounded-lg p-3">
            <div class="text-xs text-gray-400 mb-2">Copy this token now. You won't see it again.</div>
            <code id="new-token-value" class="text-xs text-green-300 break-all"></code>
          </div>
          <div class="mt-4 text-xs text-gray-500">
            Download the CLI:
            <a class="text-purple-300 hover:text-purple-200 ml-2" href="https://github.com/makash/claude-leaderboard-using-ccusage/releases/latest/download/ccrank-git_darwin_arm64" target="_blank" rel="noopener">macOS arm64</a>
            <a class="text-purple-300 hover:text-purple-200 ml-2" href="https://github.com/makash/claude-leaderboard-using-ccusage/releases/latest/download/ccrank-git_linux_amd64" target="_blank" rel="noopener">Linux x64</a>
            <a class="text-purple-300 hover:text-purple-200 ml-2" href="https://github.com/makash/claude-leaderboard-using-ccusage/releases/latest/download/ccrank-git_windows_amd64.exe" target="_blank" rel="noopener">Windows x64</a>
          </div>
        </div>

        <div class="mt-6 pt-6 border-t border-gray-800">
          <h3 class="text-sm font-semibold text-gray-200 mb-3">Project Descriptions</h3>
          <div id="project-list">${projectsHtml}</div>
        </div>
      </div>
    </div>

    <script>
    (function() {
      const toggle = document.getElementById('sharing-toggle');
      const slugSection = document.getElementById('slug-section');
      const form = document.getElementById('sharing-form');
      const msgEl = document.getElementById('settings-message');
      let enabled = ${user.sharing_enabled ? 'true' : 'false'};

      toggle.addEventListener('click', () => {
        enabled = !enabled;
        toggle.classList.toggle('bg-purple-600', enabled);
        toggle.classList.toggle('bg-gray-700', !enabled);
        toggle.setAttribute('aria-checked', String(enabled));
        const thumb = toggle.querySelector('span');
        thumb.classList.toggle('translate-x-5', enabled);
        thumb.classList.toggle('translate-x-0', !enabled);
        slugSection.classList.toggle('hidden', !enabled);
      });

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const slug = document.getElementById('share-slug').value.trim();
        const btn = document.getElementById('save-btn');
        btn.disabled = true;
        btn.textContent = 'Saving...';
        msgEl.classList.add('hidden');

        try {
          const res = await fetch('/api/settings/sharing', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled, slug }),
          });
          const data = await res.json();
          if (data.ok) {
            msgEl.textContent = 'Settings saved!';
            msgEl.className = 'text-sm mt-2 text-green-400';
            if (data.shareUrl) {
              setTimeout(() => location.reload(), 1000);
            }
          } else {
            msgEl.textContent = data.error || 'Failed to save';
            msgEl.className = 'text-sm mt-2 text-red-400';
          }
        } catch {
          msgEl.textContent = 'Network error';
          msgEl.className = 'text-sm mt-2 text-red-400';
        }
        btn.disabled = false;
        btn.textContent = 'Save Settings';
      });
      // Favorite tools save
      const toolsBtn = document.getElementById('save-tools-btn');
      const toolsMsg = document.getElementById('tools-message');
      if (toolsBtn) {
        toolsBtn.addEventListener('click', async () => {
          const favTools = [
            document.getElementById('fav-tool-1').value.trim(),
            document.getElementById('fav-tool-2').value.trim(),
            document.getElementById('fav-tool-3').value.trim(),
          ].filter(Boolean);
          toolsBtn.disabled = true;
          toolsBtn.textContent = 'Saving...';
          toolsMsg.classList.add('hidden');
          try {
            const res = await fetch('/api/settings/sharing', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ enabled, slug: document.getElementById('share-slug').value.trim(), favTools }),
            });
            const data = await res.json();
            toolsMsg.classList.remove('hidden');
            if (data.ok) {
              toolsMsg.textContent = 'Tools saved!';
              toolsMsg.className = 'text-sm mt-2 text-green-400';
            } else {
              toolsMsg.textContent = data.error || 'Failed to save';
              toolsMsg.className = 'text-sm mt-2 text-red-400';
            }
          } catch {
            toolsMsg.classList.remove('hidden');
            toolsMsg.textContent = 'Network error';
            toolsMsg.className = 'text-sm mt-2 text-red-400';
          }
          toolsBtn.disabled = false;
          toolsBtn.textContent = 'Save Tools';
        });
      }

      // Git sharing toggle
      const gitToggle = document.getElementById('git-sharing-toggle');
      const gitMsg = document.getElementById('git-sharing-message');
      let gitEnabled = ${user.git_sharing_enabled ? 'true' : 'false'};
      if (gitToggle) {
        gitToggle.addEventListener('click', async () => {
          gitEnabled = !gitEnabled;
          gitToggle.classList.toggle('bg-purple-600', gitEnabled);
          gitToggle.classList.toggle('bg-gray-700', !gitEnabled);
          gitToggle.setAttribute('aria-checked', String(gitEnabled));
          const thumb = gitToggle.querySelector('span');
          thumb.classList.toggle('translate-x-5', gitEnabled);
          thumb.classList.toggle('translate-x-0', !gitEnabled);
          try {
            const res = await fetch('/api/settings/git-sharing', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ enabled: gitEnabled }),
            });
            const data = await res.json();
            gitMsg.classList.remove('hidden');
            if (data.ok) {
              gitMsg.textContent = 'Git visibility updated';
              gitMsg.className = 'text-sm mt-2 text-green-400';
            } else {
              gitMsg.textContent = data.error || 'Failed to update';
              gitMsg.className = 'text-sm mt-2 text-red-400';
            }
          } catch {
            gitMsg.classList.remove('hidden');
            gitMsg.textContent = 'Network error';
            gitMsg.className = 'text-sm mt-2 text-red-400';
          }
        });
      }

      // Token management
      const createTokenBtn = document.getElementById('create-token');
      const newTokenBox = document.getElementById('new-token');
      const newTokenValue = document.getElementById('new-token-value');
      if (createTokenBtn) {
        createTokenBtn.addEventListener('click', async () => {
          createTokenBtn.disabled = true;
          createTokenBtn.textContent = 'Generating...';
          try {
            const res = await fetch('/api/tokens/create', { method: 'POST' });
            const data = await res.json();
            if (data.ok && data.token) {
              newTokenBox.classList.remove('hidden');
              newTokenValue.textContent = data.token;
              const list = document.getElementById('token-list');
              if (list && data.token_prefix && data.id) {
                const wrapper = document.createElement('div');
                wrapper.className = 'flex items-center justify-between bg-gray-800/50 border border-gray-700 rounded-lg px-3 py-2';
                wrapper.innerHTML = '<div>' +
                  '<div class=\"text-sm text-gray-300 font-mono\">token_' + data.token_prefix + '</div>' +
                  '<div class=\"text-xs text-gray-500\">Created just now</div>' +
                  '</div>' +
                  '<button data-token-id=\"' + data.id + '\" class=\"revoke-token text-xs bg-red-600/20 hover:bg-red-600/30 text-red-300 border border-red-700/40 px-3 py-1 rounded transition\">Revoke</button>';
                list.prepend(wrapper);
                const revokeBtn = wrapper.querySelector('.revoke-token');
                if (revokeBtn) {
                  revokeBtn.addEventListener('click', async () => {
                    revokeBtn.textContent = 'Revoking...';
                    try {
                      await fetch('/api/tokens/revoke', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ id: data.id }),
                      });
                      location.reload();
                    } catch {
                      revokeBtn.textContent = 'Revoke';
                    }
                  });
                }
              }
            }
          } catch {}
          createTokenBtn.disabled = false;
          createTokenBtn.textContent = 'Generate Token';
        });
      }

      document.querySelectorAll('.revoke-token').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const id = btn.getAttribute('data-token-id');
          if (!id) return;
          btn.textContent = 'Revoking...';
          try {
            await fetch('/api/tokens/revoke', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id }),
            });
            location.reload();
          } catch {
            btn.textContent = 'Revoke';
          }
        });
      });

      // Project description save
      document.querySelectorAll('.save-project').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const id = btn.getAttribute('data-project-id');
          const textarea = document.querySelector('.project-desc[data-project-id=\"' + id + '\"]');
          if (!id || !textarea) return;
          btn.textContent = 'Saving...';
          try {
            const res = await fetch('/api/git/projects/update', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ projectId: id, description: textarea.value.trim() }),
            });
            const data = await res.json();
            btn.textContent = data.ok ? 'Saved' : 'Error';
            setTimeout(() => { btn.textContent = 'Save'; }, 1000);
          } catch {
            btn.textContent = 'Error';
            setTimeout(() => { btn.textContent = 'Save'; }, 1000);
          }
        });
      });
    })();
    </script>`,
    user
  );
}

function renderHeatmap(data: { date: string; cost: number; tokens: number; sessions: number }[], metric: 'cost' | 'tokens' | 'sessions'): string {
  const map = new Map<string, number>();
  data.forEach(d => map.set(d.date, d[metric]));

  const values = data.map(d => d[metric]).filter(v => v > 0);
  const maxVal = Math.max(...values, 1);

  const today = new Date();
  const startDate = new Date(today);
  startDate.setDate(startDate.getDate() - 364);
  startDate.setDate(startDate.getDate() - startDate.getDay());

  let cells = '';
  const current = new Date(startDate);
  while (current <= today) {
    const dateStr = current.toISOString().slice(0, 10);
    const val = map.get(dateStr) || 0;
    const intensity = val > 0 ? Math.max(0.15, Math.min(1, val / maxVal)) : 0;
    const color = val > 0
      ? `rgba(139, 92, 246, ${intensity})`
      : 'rgba(55, 65, 81, 0.3)';
    const label = metric === 'cost' ? formatCost(val) : metric === 'tokens' ? formatTokens(val) : String(val);
    cells += `<div title="${dateStr}: ${label}" style="background:${color}" class="w-3 h-3 rounded-sm"></div>`;
    current.setDate(current.getDate() + 1);
  }

  return `<div class="grid grid-flow-col gap-1" style="grid-template-rows:repeat(7,1fr)">${cells}</div>`;
}

function renderSparkline(values: number[], color: string): string {
  const maxVal = Math.max(...values, 1);
  const bars = values.map((v) => {
    const height = Math.max(2, Math.round((v / maxVal) * 48));
    return `<div style="height:${height}px;background:${color}" class="w-2 rounded-sm"></div>`;
  }).join('');
  return `<div class="flex items-end gap-1 h-12">${bars}</div>`;
}

export function profilePage(
  profileUser: { id: string; display_name: string; avatar_url: string | null; share_slug: string },
  stats: {
    total_cost: number;
    total_tokens: number;
    total_output_tokens: number;
    days_active: number;
    rank: number;
    last_active: string | null;
    output_per_dollar: number;
    cache_rate: number;
    output_ratio: number;
    meets_efficiency_threshold: boolean;
    platformBreakdown?: Record<string, { total_cost: number; total_tokens: number; total_output_tokens: number; days_active: number; last_active: string | null }>;
  },
  favTools: string[],
  heatmapData: { date: string; cost: number; tokens: number; sessions: number }[],
  gitData: {
    dates: string[];
    projects: {
      id: string;
      repo_name: string;
      repo_slug: string;
      description: string;
      description_override: number;
      per_day: number[];
      total_commits: number;
      commits_per_day: number;
      streak: number;
    }[];
    aggregate: { avg_commits_per_day: number; streak: number; total_commits: number };
    series: { git: number[]; usage: number[] };
  } | null,
  isOwner: boolean,
  viewer: User | null,
  trendData?: { dates: string[]; totalByDate: Record<string, number>; byPlatformByDate: Record<string, Record<string, number>> } | null
): string {
  const title = getTitle(stats.total_tokens);
  const rankColor = stats.rank === 1 ? '#eab308' : stats.rank === 2 ? '#9ca3af' : stats.rank === 3 ? '#b45309' : '#7c3aed';

  // Build heatmaps for all 3 metrics server-side
  const heatmapCost = renderHeatmap(heatmapData, 'cost');
  const heatmapTokens = renderHeatmap(heatmapData, 'tokens');
  const heatmapSessions = renderHeatmap(heatmapData, 'sessions');

  // Favorite tools section
  let favToolsHtml: string;
  if (favTools.length > 0) {
    const pills = favTools.map(t => `<span class="inline-block bg-purple-600/20 text-purple-300 border border-purple-700/50 text-sm px-3 py-1 rounded-full">${escapeHtml(t)}</span>`).join(' ');
    favToolsHtml = `<div class="bg-gray-900 border border-gray-800 rounded-xl p-6 mb-8">
      <h2 class="text-lg font-semibold mb-3">Tools I can't live without</h2>
      <div class="flex flex-wrap gap-2">${pills}</div>
    </div>`;
  } else if (isOwner) {
    favToolsHtml = `<div class="bg-gray-900 border border-gray-800 rounded-xl p-6 mb-8">
      <h2 class="text-lg font-semibold mb-3">Tools I can't live without</h2>
      <p class="text-sm text-gray-500">You haven't set any favorite tools yet. <a href="/settings" class="text-purple-400 hover:text-purple-300 transition">Add them in Settings</a></p>
    </div>`;
  } else {
    favToolsHtml = `<div class="bg-gray-900 border border-gray-800 rounded-xl p-6 mb-8">
      <h2 class="text-lg font-semibold mb-3">Tools I can't live without</h2>
      <p class="text-sm text-gray-500">No favorites set yet</p>
    </div>`;
  }

  // Share on X button
  let shareHtml = '';
  if (stats.total_tokens > 0) {
    let tweetText = `I'm ranked #${stats.rank} on ccrank.dev!`;
    if (favTools.length > 0) {
      tweetText += '\n\nMy go-to AI coding tools:';
      favTools.forEach(t => { tweetText += `\n- ${t}`; });
    }
    tweetText += `\n\nCheck your ranking: ccrank.dev/card/${profileUser.share_slug}`;
    const encodedTweet = encodeURIComponent(tweetText);
    shareHtml = `<div class="mb-8">
      <a href="https://x.com/intent/tweet?text=${encodedTweet}"
         target="_blank" rel="noopener"
         class="inline-flex items-center gap-2 bg-gray-800 hover:bg-gray-700 text-white text-sm font-medium rounded-lg px-5 py-2.5 transition">
        <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
        Share on X
      </a>
    </div>`;
  }

  let gitHtml = '';
  if (gitData && (gitData.projects.length > 0 || isOwner)) {
    const gitTrend = renderSparkline(gitData.series.git, 'rgba(139, 92, 246, 0.9)');
    const usageTrend = renderSparkline(gitData.series.usage, 'rgba(34, 197, 94, 0.9)');
    const projectCards = gitData.projects.map((p) => {
      const spark = renderSparkline(p.per_day, 'rgba(59, 130, 246, 0.9)');
      return `<div class="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <div class="flex items-start justify-between gap-4 mb-3">
          <div>
            <div class="text-sm font-semibold">${escapeHtml(p.repo_name)}</div>
            <div class="text-xs text-gray-500">${escapeHtml(p.description)}</div>
          </div>
          <div class="text-right">
            <div class="text-xs text-gray-400">Commits/day</div>
            <div class="text-sm font-semibold text-purple-300">${p.commits_per_day.toFixed(2)}</div>
          </div>
        </div>
        <div class="flex items-center justify-between gap-4">
          <div>${spark}</div>
          <div class="text-xs text-gray-400">Streak: <span class="text-gray-200 font-semibold">${p.streak}d</span></div>
        </div>
      </div>`;
    }).join('');

    gitHtml = `<div class="bg-gray-900 border border-gray-800 rounded-xl p-6 mb-8" data-git-profile="${escapeHtml(profileUser.id)}">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-lg font-semibold">Git Momentum</h2>
        <span class="text-xs text-gray-500">Last 28 days</span>
      </div>
      <div class="grid grid-cols-3 gap-4 mb-6">
        <div class="bg-gray-800/60 border border-gray-700 rounded-lg p-3 text-center">
          <div class="text-xs text-gray-400 mb-1">Avg commits/day</div>
          <div class="text-lg font-bold text-purple-300">${gitData.aggregate.avg_commits_per_day.toFixed(2)}</div>
        </div>
        <div class="bg-gray-800/60 border border-gray-700 rounded-lg p-3 text-center">
          <div class="text-xs text-gray-400 mb-1">Streak</div>
          <div class="text-lg font-bold text-cyan-300">${gitData.aggregate.streak}d</div>
        </div>
        <div class="bg-gray-800/60 border border-gray-700 rounded-lg p-3 text-center">
          <div class="text-xs text-gray-400 mb-1">Total commits</div>
          <div class="text-lg font-bold text-green-300">${gitData.aggregate.total_commits}</div>
        </div>
      </div>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
        <div>
          <div class="text-xs text-gray-400 mb-2">Git commits</div>
          ${gitTrend}
        </div>
        <div>
          <div class="text-xs text-gray-400 mb-2">AI usage (tokens)</div>
          ${usageTrend}
        </div>
      </div>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        ${projectCards || '<div class="text-sm text-gray-500">No projects uploaded yet.</div>'}
      </div>
      <div class="mt-6 pt-4 border-t border-gray-800 flex items-center gap-3">
        <span class="text-xs text-gray-500">Was this helpful?</span>
        <button data-rating="1" class="git-feedback text-xs bg-gray-800 hover:bg-gray-700 text-green-300 px-2.5 py-1 rounded">Up</button>
        <button data-rating="-1" class="git-feedback text-xs bg-gray-800 hover:bg-gray-700 text-red-300 px-2.5 py-1 rounded">Down</button>
        <span id="git-feedback-msg" class="text-xs text-gray-500"></span>
      </div>
    </div>`;
  }

  const content = `<div class="max-w-4xl mx-auto">
    <!-- Profile Header -->
    <div class="flex items-center gap-6 mb-8">
      ${profileUser.avatar_url
        ? `<img src="${escapeHtml(profileUser.avatar_url)}" class="w-20 h-20 rounded-full ring-2" style="--tw-ring-color: ${rankColor};" alt="">`
        : `<div class="w-20 h-20 rounded-full bg-purple-600 flex items-center justify-center text-3xl font-bold ring-2" style="--tw-ring-color: ${rankColor};">${escapeHtml(profileUser.display_name.charAt(0))}</div>`}
      <div>
        <h1 class="text-2xl font-bold mb-1">${escapeHtml(profileUser.display_name)}</h1>
        <div class="flex items-center gap-3">
          <span class="text-sm font-semibold" style="color: ${title.color};">${title.label}</span>
          <span class="text-xs font-bold px-2.5 py-0.5 rounded-full bg-purple-600/20 text-purple-300 border border-purple-700/50">#${stats.rank}</span>
        </div>
      </div>
    </div>

    <!-- Stats Row -->
    <div class="grid grid-cols-2 ${isOwner ? 'md:grid-cols-5' : 'md:grid-cols-4'} gap-4 mb-8">
      <div class="bg-gray-900 border border-gray-800 rounded-xl p-4 text-center">
        <div class="text-sm text-gray-400 mb-1">Total Tokens</div>
        <div class="text-xl font-bold text-cyan-400">${formatTokens(stats.total_tokens)}</div>
      </div>
      <div class="bg-gray-900 border border-gray-800 rounded-xl p-4 text-center">
        <div class="text-sm text-gray-400 mb-1">Output Tokens</div>
        <div class="text-xl font-bold text-green-400">${formatTokens(stats.total_output_tokens)}</div>
      </div>
      <div class="bg-gray-900 border border-gray-800 rounded-xl p-4 text-center">
        <div class="text-sm text-gray-400 mb-1">Days Active</div>
        <div class="text-xl font-bold text-yellow-400">${stats.days_active}</div>
      </div>
      ${isOwner ? `<div class="bg-gray-900 border border-gray-800 rounded-xl p-4 text-center">
        <div class="text-sm text-gray-400 mb-1">Estimated Cost</div>
        <div class="text-xl font-bold text-purple-400">${formatCost(stats.total_cost)}</div>
      </div>` : ''}
      <div class="bg-gray-900 border border-gray-800 rounded-xl p-4 text-center">
        <div class="text-sm text-gray-400 mb-1">Last Active</div>
        <div class="text-xl font-bold text-gray-300">${timeAgo(stats.last_active)}</div>
      </div>
    </div>

    <!-- Efficiency Stats Row -->
    ${stats.meets_efficiency_threshold ? `<div class="grid grid-cols-3 gap-4 mb-8">
      <div class="bg-gray-900 border border-gray-800 rounded-xl p-4 text-center">
        <div class="text-sm text-gray-400 mb-1">Output/$</div>
        <div class="text-xl font-bold text-emerald-400">${formatEfficiency(stats.output_per_dollar)} <span class="text-sm font-normal text-gray-500">tokens/$</span></div>
      </div>
      <div class="bg-gray-900 border border-gray-800 rounded-xl p-4 text-center">
        <div class="text-sm text-gray-400 mb-1">Cache Rate</div>
        <div class="text-xl font-bold text-blue-400">${formatPercent(stats.cache_rate)}</div>
      </div>
      <div class="bg-gray-900 border border-gray-800 rounded-xl p-4 text-center">
        <div class="text-sm text-gray-400 mb-1">Output Ratio</div>
        <div class="text-xl font-bold text-amber-400">${formatPercent(stats.output_ratio)}</div>
      </div>
    </div>` : ''}

    <!-- 30-day Trend -->
    ${(() => {
      if (!trendData || trendData.dates.length < 2) return '';
      const values = trendData.dates.map((d) => trendData.totalByDate[d] || 0);
      const titles = trendData.dates.map((d) => `${d}: ${formatTokens(trendData.totalByDate[d] || 0)}`);
      return `<div class="bg-gray-900 border border-gray-800 rounded-xl p-6 mb-8">
        <h2 class="text-lg font-semibold mb-4">30-day trend</h2>
        ${sparklineBars(values, '#c084fc', titles)}
      </div>`;
    })()}

    <!-- Platform Breakdown -->
    ${(() => {
      const pb = stats.platformBreakdown;
      if (!pb || Object.keys(pb).length <= 1) return '';
      const DOT_HEX: Record<string, string> = {
        'bg-purple-400': '#c084fc',
        'bg-emerald-400': '#34d399',
        'bg-sky-400': '#38bdf8',
        'bg-rose-400': '#fb7185',
        'bg-amber-400': '#fbbf24',
        'bg-teal-400': '#2dd4bf',
        'bg-orange-400': '#fb923c',
      };
      const cards = PLATFORM_META.flatMap((platform) => {
        const usage = pb[platform.key];
        if (!usage) return [];
        let sparkHtml = '';
        if (trendData) {
          const activeDays = trendData.dates.filter((d) => (trendData.byPlatformByDate[d]?.[platform.key] || 0) > 0);
          if (activeDays.length >= 2) {
            const vals = activeDays.map((d) => trendData.byPlatformByDate[d][platform.key]);
            const titles = activeDays.map((d) => `${d}: ${formatTokens(trendData.byPlatformByDate[d][platform.key])}`);
            sparkHtml = `<div class="mt-3 pt-3 border-t border-gray-700/50">
              <div class="text-xs text-gray-500 mb-1">30-day trend</div>
              ${sparklineBars(vals, DOT_HEX[platform.dot] || '#c084fc', titles)}
            </div>`;
          }
        }
        return [`<div class="bg-gray-800/60 border border-gray-700 rounded-xl p-5">
          <div class="flex items-center gap-2 mb-3">
            <span class="w-2.5 h-2.5 rounded-full ${platform.dot}"></span>
            <span class="text-sm font-semibold ${platform.text}">${platform.label}</span>
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div>
              <div class="text-xs text-gray-500">Tokens</div>
              <div class="text-lg font-bold text-cyan-400">${formatTokens(usage.total_tokens)}</div>
            </div>
            <div>
              <div class="text-xs text-gray-500">Output</div>
              <div class="text-lg font-bold text-green-400">${formatTokens(usage.total_output_tokens)}</div>
            </div>
            <div>
              <div class="text-xs text-gray-500">Days</div>
              <div class="text-lg font-bold text-yellow-400">${usage.days_active}</div>
            </div>
            ${isOwner ? `<div>
              <div class="text-xs text-gray-500">Cost</div>
              <div class="text-lg font-bold text-purple-400">${formatCost(usage.total_cost)}</div>
            </div>` : ''}
          </div>
          ${sparkHtml}
        </div>`];
      }).join('');
      if (!cards) return '';
      return `<div class="bg-gray-900 border border-gray-800 rounded-xl p-6 mb-8">
        <h2 class="text-lg font-semibold mb-4">Platform Breakdown</h2>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-4">${cards}</div>
      </div>`;
    })()}

    ${gitHtml}

    <!-- Activity Heatmap -->
    <div class="bg-gray-900 border border-gray-800 rounded-xl p-6 mb-8">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-lg font-semibold">Activity</h2>
        <div class="flex gap-1">
          <button id="tab-tokens" onclick="showHeatmap('tokens')" class="px-3 py-1 text-xs font-medium rounded-md bg-purple-600 text-white transition">Tokens</button>
          <button id="tab-cost" onclick="showHeatmap('cost')" class="px-3 py-1 text-xs font-medium rounded-md bg-gray-700 text-gray-400 transition">Cost</button>
          <button id="tab-sessions" onclick="showHeatmap('sessions')" class="px-3 py-1 text-xs font-medium rounded-md bg-gray-700 text-gray-400 transition">Sessions</button>
        </div>
      </div>
      <div class="overflow-x-auto">
        <div id="heatmap-tokens">${heatmapTokens}</div>
        <div id="heatmap-cost" class="hidden">${heatmapCost}</div>
        <div id="heatmap-sessions" class="hidden">${heatmapSessions}</div>
      </div>
      <div class="flex items-center justify-end gap-2 mt-3 text-xs text-gray-500">
        <span>Less</span>
        <div class="w-3 h-3 rounded-sm" style="background:rgba(55,65,81,0.3)"></div>
        <div class="w-3 h-3 rounded-sm" style="background:rgba(139,92,246,0.25)"></div>
        <div class="w-3 h-3 rounded-sm" style="background:rgba(139,92,246,0.5)"></div>
        <div class="w-3 h-3 rounded-sm" style="background:rgba(139,92,246,0.75)"></div>
        <div class="w-3 h-3 rounded-sm" style="background:rgba(139,92,246,1)"></div>
        <span>More</span>
      </div>
    </div>

    <!-- Favorite Tools -->
    ${favToolsHtml}

    <!-- Share on X -->
    ${shareHtml}
  </div>

  <script>
  function showHeatmap(metric) {
    ['cost', 'tokens', 'sessions'].forEach(m => {
      document.getElementById('heatmap-' + m).classList.toggle('hidden', m !== metric);
      const tab = document.getElementById('tab-' + m);
      tab.classList.toggle('bg-purple-600', m === metric);
      tab.classList.toggle('text-white', m === metric);
      tab.classList.toggle('bg-gray-700', m !== metric);
      tab.classList.toggle('text-gray-400', m !== metric);
    });
  }

  (function() {
    const container = document.querySelector('[data-git-profile]');
    if (!container) return;
    const profileId = container.getAttribute('data-git-profile');
    const msg = document.getElementById('git-feedback-msg');
    document.querySelectorAll('.git-feedback').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const rating = Number(btn.getAttribute('data-rating'));
        try {
          const res = await fetch('/api/git/feedback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: profileId, rating }),
          });
          const data = await res.json();
          if (msg) {
            msg.textContent = data.ok ? 'Thanks for the feedback.' : 'Could not record feedback.';
          }
        } catch {
          if (msg) msg.textContent = 'Network error.';
        }
      });
    });
  })();
  </script>`;

  const ogDesc = `${title.label} ranked #${stats.rank} on ccrank.dev. ${stats.days_active} days active, ${formatTokens(stats.total_tokens)} tokens. ccrank.dev is the leaderboard for AI coding power users.`;

  const ogImage = `https://ccrank.dev/card/${profileUser.share_slug}/image.png`;
  return layout('Profile - ' + profileUser.display_name, content, viewer, { image: ogImage, description: ogDesc });
}

export function errorPage(title: string, message: string, user: User | null = null): string {
  return layout(
    title,
    `<div class="flex flex-col items-center justify-center min-h-[60vh] text-center">
      <div class="text-6xl mb-4 text-red-400">!</div>
      <h1 class="text-2xl font-bold mb-2">${escapeHtml(title)}</h1>
      <p class="text-gray-400 mb-6">${escapeHtml(message)}</p>
      <a href="/" class="text-purple-400 hover:text-purple-300 transition">Back to home</a>
    </div>`,
    user
  );
}
