# HOME TV - IPTV Streaming Application

A retro-styled, modern IPTV streaming terminal for watching free live TV channels.

---

## 📋 UI Analysis & Recommendations

**Analysis Date:** January 19, 2026  
**Last Updated:** January 25, 2026 (v2)

---

## 🛠 Technical Stack

| Component | Technology |
|-----------|------------|
| **Frontend** | Vanilla HTML5, CSS3, JavaScript (ES6+) |
| **Video Player** | Native HLS support with custom controls |
| **Fonts** | JetBrains Mono (Google Fonts), Material Icons Round |
| **Styling** | Custom CSS with CSS Variables |
| **PWA** | Service Worker (`sw.js`) + Web App Manifest |
| **Storage** | IndexedDB via custom `db.js` module |

### Dependencies (CDN)
```html
<!-- HLS.js for streaming -->
<script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>

<!-- Fonts -->
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;700&display=swap" rel="stylesheet">
<link href="https://fonts.googleapis.com/icon?family=Material+Icons+Round" rel="stylesheet">
```

---

## 📁 Project Structure

```
/TV
├── index.html      # Main HTML structure (245 lines)
├── style.css       # Styles & theming (1816 lines)
├── script.js       # Main application logic (1552 lines, TVApp class)
├── db.js           # IndexedDB wrapper for persistence (13KB)
├── sw.js           # Service worker for PWA/caching
├── manifest.json   # PWA manifest
├── icon.png        # App icon (401KB)
└── README.md       # This file
```

---

## 🎨 Current Design System

### Color Palette (CSS Variables)

```css
:root {
    /* Core Colors */
    --bg-base: #0a0a0f;           /* Deepest background */
    --bg-elevated: #0f0f15;       /* Elevated surface */
    --bg-surface: #161620;        /* Cards/panels */
    
    /* Accent - Cyber Green */
    --accent-primary: #00ff7f;    /* Main accent */
    --accent-secondary: #00d068;  /* Secondary accent */
    --accent-dim: rgba(0, 255, 127, 0.15);
    --accent-glow: rgba(0, 255, 127, 0.35);
    
    /* Text Hierarchy */
    --text-primary: #f0f0f5;      /* Main text */
    --text-secondary: #a0a0b0;    /* Secondary text */
    --text-muted: #606070;        /* Muted/disabled */
    
    /* Status Colors */
    --live-red: #ff3b5c;          /* Live indicator */
    --error-red: #ff4460;         /* Errors */
    --warning-amber: #ffaa00;     /* Warnings */
}
```

### Typography
- **Font Family:** JetBrains Mono (monospace, terminal aesthetic)
- **Font Weights:** 300 (light), 400 (regular), 500 (medium), 700 (bold)
- **Letter Spacing:** 0.3px - 3px depending on context

---

## 📐 Current UI Layout

### Desktop (>768px)
```
┌─────────────────────────────────────────────────────────────┐
│ ┌──────────────┐ ┌────────────────────────────────────────┐ │
│ │   SIDEBAR    │ │                                        │ │
│ │   (340px)    │ │        MAIN VIDEO AREA                 │ │
│ │              │ │        (flex: 1)                       │ │
│ │ - Header     │ │                                        │ │
│ │ - Config     │ │   ┌──────────────────┐                 │ │
│ │ - Tabs       │ │   │ Unified Top Bar  │                 │ │
│ │ - Search     │ │   └──────────────────┘                 │ │
│ │ - Channels   │ │                                        │ │
│ │              │ │   ┌────────────────────────────────────┤ │
│ │ - Status     │ │   │ Unified Dock (on hover)            │ │
│ └──────────────┘ └───┴────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

### Mobile (<768px)
- Sidebar becomes a slide-out drawer (300px, transforms from left)
- Mobile menu button appears (fixed, top-left)
- Backdrop overlay when sidebar is open

---

## ✨ Changelog (January 25, 2026)

### Compact Sidebar Redesign
- **TV Icon Header**: Replaced "HOME TV" text with a sleek TV icon featuring neon glow effects.
- **Compact Config Panel**: Reduced padding, gaps, and font sizes throughout the configuration section.
- **Smaller Channel Items**: Channel logos reduced from 32px to 26px, names from 10px to 9px.
- **Refined Buttons**: Favorite and list buttons shrunk from 28px to 22px with lighter shadows.
- **Tighter Lists Header**: Favorites section headers and "New List" button made more compact.
- **Minimal Status Bar**: Reduced padding and font sizes, status dot from 8px to 6px.
- **Overall Space Savings**: ~25% reduction in vertical space usage across all sidebar elements.

### Unified Dock & UI Cleanup
- **Removed Run Mode Sidebar Button**: Cleaned up the sidebar by removing the bulky "Run Mode" section.
- **Unified Controls Dock**: Moved all playback, loop, and system controls into a single, polished dock at the bottom of the screen.
- **Global Scaling**: Reduced the overall size of the dock and top bar for a more professional, "compact" terminal feel.
- **Typography Sync**: Synchronized all top bar font sizes to a consistent 9px for better visual balance.

### Intelligent Visuals
- **Dynamic Text Placeholders**: Added a system that extracts the first word of a channel name and displays it inside the icon container if no logo is available.
- **Auto-Scaling Font Size**: Placeholders dynamically adjust their font size (from 14px down to 6px) to perfectly fit the text within the square.
- **Enhanced Logo Containers**: Icons now sit on a refined dark gray (`#2a2d32`) background with subtle inner highlights and depth shadows.
- **Minimized Padding**: Reduced icon padding to 2px, allowing logos to "zoom" and fill their containers effectively.

### UX & Reliability
- **Sidebar Sync**: The sidebar now automatically highlights and scrolls to the current channel when skipping or looping.
- **Infinity/Loop Restoration**: Fixed the loop functionality to work independently of any specific "mode," allowing for seamless auto-advance.

---

## ✅ Current Strengths

1. **Strong Visual Identity** - Cohesive "Cyberpunk/Terminal" aesthetic with consistent color scheme
2. **Excellent Typography** - JetBrains Mono gives a premium, tech-forward feel
3. **Good Animation System** - Smooth transitions (0.1s-0.25s), subtle glow effects
4. **Responsive Design** - Mobile-first approach with breakpoint at 768px
5. **PWA Ready** - Service worker and manifest in place
6. **Clean Status Indicators** - Clear LIVE badge, status dots with pulses
7. **Premium Controls** - Glassmorphism on overlays, gradient fills on sliders
8. **Dynamic Fallbacks** - Smart placeholders ensure no channel looks broken or empty

---

## 🚀 Quick Start

```bash
# Serve locally
cd /Users/vikramsra/Desktop/Duar\ Projects/TV
python3 -m http.server 8080

# Open in browser
open http://localhost:8080
```

---

## 🔮 Future Agent Reference

1. **CSS Variables** are defined in `:root` - always use them for consistency
2. **The app uses a single-page architecture** - no routing
3. **State is managed in `TVApp.state`** object
4. **IndexedDB operations** go through `window.tvDB` (defined in db.js)
5. **Mobile breakpoint** is 768px
6. **Animation timing** should be 0.1s-0.25s for snappy feel
7. **The "Loop" functionality** auto-cycles through channels based on the current list view

---

*Generated by AI Assistant for UI Analysis*
