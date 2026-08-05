(function () {
  const PAGE = window.GUIDE_PAGE || 'default';
  const STEPS = Array.isArray(window.GUIDE_STEPS) ? window.GUIDE_STEPS : [];
  const SEEN_KEY = 'guideSeen_' + PAGE;

  if (!STEPS.length) return;

  let overlay = null;
  let spotlight = null;
  let tooltip = null;
  let arrow = null;
  let launcher = null;
  let current = 0;
  let active = false;

  function build() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.className = 'guide-overlay';
    overlay.innerHTML = '<div class="guide-spotlight"></div>';
    spotlight = overlay.querySelector('.guide-spotlight');

    tooltip = document.createElement('div');
    tooltip.className = 'guide-tooltip hidden';
    tooltip.innerHTML = `
      <button class="guide-skip" style="position:absolute; top:8px; right:10px; font-size:16px;" aria-label="關閉導覽">✕</button>
      <div class="guide-step-label"></div>
      <div class="guide-title"></div>
      <div class="guide-text"></div>
      <div class="guide-dots"></div>
      <div class="guide-actions">
        <button class="btn btn-secondary guide-prev">上一步</button>
        <span class="guide-spacer"></span>
        <button class="btn btn-primary guide-next">下一步</button>
      </div>`;

    arrow = document.createElement('div');
    arrow.className = 'guide-arrow hidden';

    document.body.appendChild(overlay);
    document.body.appendChild(tooltip);
    document.body.appendChild(arrow);

    tooltip.querySelector('.guide-prev').addEventListener('click', prev);
    tooltip.querySelector('.guide-next').addEventListener('click', next);
    tooltip.querySelector('.guide-skip').addEventListener('click', close);
  }

  function buildLauncher() {
    if (launcher) return;
    launcher = document.createElement('button');
    launcher.className = 'guide-launcher';
    launcher.type = 'button';
    launcher.setAttribute('aria-label', '操作導覽');
    launcher.innerHTML = '<span class="guide-launcher-icon">?</span><span>操作導覽</span>';
    launcher.addEventListener('click', () => start());
    document.body.appendChild(launcher);
  }

  function markSeen() {
    try {
      localStorage.setItem(SEEN_KEY, '1');
    } catch (e) {}
  }

  function start() {
    if (active) return;
    build();
    active = true;
    current = 0;
    overlay.classList.add('visible');
    if (launcher) launcher.classList.add('hidden');
    markSeen();
    render();
  }

  function close() {
    if (!active) return;
    active = false;
    overlay.classList.remove('visible');
    tooltip.classList.add('hidden');
    arrow.classList.add('hidden');
    spotlight.style.width = '0';
    spotlight.style.height = '0';
    if (launcher) launcher.classList.remove('hidden');
  }

  function prev() {
    if (current > 0) {
      current--;
      render();
    }
  }

  function next() {
    if (current < STEPS.length - 1) {
      current++;
      render();
    } else {
      close();
    }
  }

  function rectOf(sel) {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return null;
    return r;
  }

  function render() {
    const step = STEPS[current];
    const label = tooltip.querySelector('.guide-step-label');
    const title = tooltip.querySelector('.guide-title');
    const text = tooltip.querySelector('.guide-text');
    const dots = tooltip.querySelector('.guide-dots');
    const prevBtn = tooltip.querySelector('.guide-prev');
    const nextBtn = tooltip.querySelector('.guide-next');

    label.textContent = `步驟 ${current + 1} / ${STEPS.length}`;
    title.textContent = step.title || '';
    text.textContent = step.text || '';
    prevBtn.classList.toggle('hidden', current === 0);
    nextBtn.textContent = current === STEPS.length - 1 ? '完成' : '下一步';

    dots.innerHTML = STEPS.map((_, i) => `<span class="guide-dot ${i === current ? 'active' : ''}"></span>`).join('');

    const rect = rectOf(step.target);
    const scrollNeeded = step.target && rect && (rect.top < 60 || rect.bottom > window.innerHeight - 60);
    if (scrollNeeded) {
      const el = document.querySelector(step.target);
      if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }

    position(step, rect);
  }

  function position(step, rect) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const pad = 10;

    if (rect) {
      const spotPad = 8;
      const left = rect.left - spotPad;
      const top = rect.top - spotPad;
      const width = rect.width + spotPad * 2;
      const height = rect.height + spotPad * 2;
      spotlight.style.left = Math.max(pad, left) + 'px';
      spotlight.style.top = Math.max(pad, top) + 'px';
      spotlight.style.width = width + 'px';
      spotlight.style.height = height + 'px';
    } else {
      spotlight.style.width = '0';
      spotlight.style.height = '0';
    }

    const tooltipH = tooltip.offsetHeight;
    const tooltipW = tooltip.offsetWidth;
    const placement = step.placement || 'bottom';
    const above = placement === 'top' || (placement === 'bottom' && rect && rect.bottom + tooltipH + 70 > vh && rect.top - tooltipH - 70 > 0);

    tooltip.classList.toggle('guide-tooltip-top', above);
    tooltip.classList.remove('hidden');

    let x;
    if (rect) {
      x = rect.left + rect.width / 2 - tooltipW / 2;
    } else {
      x = vw / 2 - tooltipW / 2;
    }
    x = Math.max(16, Math.min(x, vw - tooltipW - 16));
    tooltip.style.left = x + 'px';

    let y;
    if (rect) {
      y = above ? rect.top - tooltipH - 64 : rect.bottom + 64;
    } else {
      y = vh / 2;
    }
    y = Math.max(12, Math.min(y, vh - tooltipH - 12));
    tooltip.style.top = y + 'px';

    if (rect) {
      arrow.classList.toggle('up', above);
      arrow.classList.remove('hidden');
      const ax = rect.left + rect.width / 2 - 13;
      const ay = above ? rect.top - 6 : rect.bottom - 20;
      arrow.style.left = Math.max(0, Math.min(ax, vw - 26)) + 'px';
      arrow.style.top = ay + 'px';
    } else {
      arrow.classList.add('hidden');
    }
  }

  function onViewportChange() {
    if (!active) return;
    const step = STEPS[current];
    const rect = rectOf(step.target);
    position(step, rect);
  }

  function init() {
    buildLauncher();

    if (!localStorage.getItem(SEEN_KEY)) {
      setTimeout(start, 600);
    }

    window.addEventListener('resize', onViewportChange, { passive: true });
    window.addEventListener('scroll', onViewportChange, { passive: true });
    window.addEventListener('keydown', (e) => {
      if (!active) return;
      if (e.key === 'Escape') close();
      if (e.key === 'ArrowRight') next();
      if (e.key === 'ArrowLeft') prev();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
