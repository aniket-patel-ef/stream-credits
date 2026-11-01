/*
 * Stream Credits — renders a credits object into DOM and scrolls it like movie credits.
 */
(function (root) {
  'use strict';

  const TWITCH_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0 1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714z"/></svg>';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function initials(name) {
    const clean = String(name || '?').replace(/[^\p{L}\p{N}]/gu, '');
    return esc((clean[0] || '?').toUpperCase());
  }

  function avatar(item, cls) {
    const inner = item.avatar
      ? '<img src="' + esc(item.avatar) + '" alt="" referrerpolicy="no-referrer">'
      : '<span class="avatar__initial">' + initials(item.name) + '</span>';
    const tint = /^#[0-9a-f]{3,8}$/i.test(item.color || '') ? ' style="--user:' + item.color + '"' : '';
    return '<div class="avatar ' + (cls || '') + '"' + tint + '>' + inner + '<i class="avatar__platform">' + TWITCH_SVG + '</i></div>';
  }

  function renderSection(sec) {
    const head = '<h2 class="sec__title"><span>' + esc(sec.title) + '</span></h2>' +
      (sec.subtitle ? '<p class="sec__subtitle">' + esc(sec.subtitle) + '</p>' : '');
    let body = '';
    switch (sec.kind) {
      case 'star': {
        const it = sec.items[0];
        body = '<div class="star">' + avatar(it, 'avatar--xl') + '<div class="star__name">' + esc(it.name) + '</div></div>';
        break;
      }
      case 'cards':
        body = '<div class="cards' + (sec.items.length === 1 ? ' cards--single' : '') + '">' + sec.items.map((it) => {
          const ranked = sec.ranked !== false;
          return '<div class="card' + (ranked && it.rank <= 3 ? ' card--top card--r' + it.rank : '') + '">' +
            avatar(it) +
            '<div class="card__body"><div class="card__name">' + esc(it.name) + '</div><div class="card__stat">' + esc(it.stat) + '</div></div>' +
            (ranked ? '<div class="card__rank">#' + it.rank + '</div>' : '') +
            '</div>';
        }).join('') + '</div>';
        break;
      case 'pills':
        body = '<div class="pills">' + sec.items.map((it) =>
          '<span class="pill"><i class="pill__icon">' + TWITCH_SVG + '</i><span class="pill__name">' + esc(it.name) + '</span>' +
          (it.badge ? '<b class="pill__badge">' + esc(it.badge) + '</b>' : '') + '</span>').join('') + '</div>';
        break;
      case 'names':
        body = '<ul class="names">' + sec.items.map((it) =>
          '<li' + (it.more ? ' class="names__more"' : '') + '>' + esc(it.name) + '</li>').join('') + '</ul>';
        break;
      case 'stats':
        body = '<div class="stats">' + sec.items.map((it) =>
          '<div class="stat"><div class="stat__value">' + esc(it.value) + '</div><div class="stat__label">' + esc(it.label) + '</div></div>').join('') + '</div>';
        break;
      default:
    }
    return '<section class="sec sec--' + sec.kind + '" data-key="' + esc(sec.key) + '">' + head + body + '</section>';
  }

  function render(credits) {
    const m = credits.meta || {};
    const metaBits = [m.game, m.date, m.duration].filter(Boolean).map(esc).join('<i class="dot">•</i>');
    const hasPeople = credits.sections.some((s) => s.kind !== 'star' && s.kind !== 'stats');
    const reel = document.createElement('div');
    reel.className = 'reel';
    reel.innerHTML =
      '<header class="intro">' +
        (credits.title ? '<h1 class="intro__title">' + esc(credits.title) + '</h1>' : '') +
        (credits.tagline ? '<p class="intro__tagline">' + esc(credits.tagline) + '</p>' : '') +
        (m.streamTitle ? '<p class="intro__stream">“' + esc(m.streamTitle) + '”</p>' : '') +
        (metaBits ? '<p class="intro__meta">' + metaBits + '</p>' : '') +
        (hasPeople ? '' : '<p class="intro__empty">A quiet one today — thanks for hanging out ♡</p>') +
      '</header>' +
      credits.sections.map(renderSection).join('') +
      '<footer class="outro"><div class="outro__card">' +
        (credits.outro.title ? '<h2 class="outro__title">' + esc(credits.outro.title) + '</h2>' : '') +
        (credits.outro.sub ? '<p class="outro__sub">' + esc(credits.outro.sub) + '</p>' : '') +
      '</div></footer>';
    return reel;
  }

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  async function settle(reel) {
    const fonts = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
    const imgs = [...reel.querySelectorAll('img')].map((img) => new Promise((resolve) => {
      if (img.complete) return resolve();
      img.onload = resolve;
      img.onerror = () => {
        // fall back to the initial if the picture fails
        const box = img.parentNode;
        img.remove();
        box.insertAdjacentHTML('afterbegin', '<span class="avatar__initial">?</span>');
        resolve();
      };
    }));
    await Promise.race([Promise.all([fonts].concat(imgs)), wait(2500)]);
  }

  class Roller {
    constructor(stage) {
      this.stage = stage;
      this.viewport = stage.querySelector('.viewport');
      this.raf = 0;
      this.timers = [];
      this.run = 0;
      this.onLoop = null;
      this.onDone = null;
    }

    async play(credits, opts) {
      this.stop();
      const run = ++this.run;
      const reel = render(credits);
      reel.style.visibility = 'hidden';
      this.viewport.appendChild(reel);
      await settle(reel);
      if (run !== this.run) return;

      const H = this.viewport.clientHeight;
      const outro = reel.querySelector('.outro');
      const startY = H;
      const endY = Math.round(H / 2 - (outro.offsetTop + outro.offsetHeight / 2));
      const dist = startY - endY;
      const speed = opts.duration > 0 ? dist / opts.duration : opts.speed * (H / 1080);
      const runMs = (dist / speed) * 1000;

      reel.style.transform = 'translate3d(0,' + startY + 'px,0)';
      reel.style.visibility = '';
      this.stage.classList.add('is-rolling');
      this.stage.classList.remove('is-holding', 'is-fading');

      const t0 = performance.now();
      const tick = (t) => {
        if (run !== this.run) return;
        const elapsed = t - t0;
        const y = elapsed >= runMs ? endY : startY - (elapsed / 1000) * speed;
        reel.style.transform = 'translate3d(0,' + y.toFixed(2) + 'px,0)';
        if (elapsed < runMs) {
          this.raf = requestAnimationFrame(tick);
          return;
        }
        this.stage.classList.add('is-holding');
        this.later(() => this.finish(run, opts), opts.hold * 1000);
      };
      this.raf = requestAnimationFrame(tick);
    }

    finish(run, opts) {
      if (run !== this.run) return;
      if (this.onDone) this.onDone();
      if (!opts.loop) return;
      this.stage.classList.add('is-fading');
      this.later(() => {
        if (run !== this.run) return;
        if (this.onLoop) this.onLoop(); else this.stop();
      }, 900);
    }

    later(fn, ms) { this.timers.push(setTimeout(fn, ms)); }

    stop() {
      this.run++;
      cancelAnimationFrame(this.raf);
      this.timers.forEach(clearTimeout);
      this.timers = [];
      this.viewport.innerHTML = '';
      this.stage.classList.remove('is-rolling', 'is-holding', 'is-fading');
    }

    get rolling() { return this.stage.classList.contains('is-rolling'); }
  }

  root.SC = Object.assign(root.SC || {}, { Roller, renderCredits: render, TWITCH_SVG });
})(window);
