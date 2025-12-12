// UI layout enhancements: topbar active states, widget customization, and auto-resize
(function(){
  function onReady(fn){
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  onReady(function(){
    // Topbar active link handling
    const navLinks = document.querySelectorAll('.topbar .nav-links .nav-link');
    navLinks.forEach(a => a.addEventListener('click', (e) => {
      navLinks.forEach(n => n.classList.remove('active'));
      e.currentTarget.classList.add('active');
    }));

    // Cards registry
    const cards = {
      kpi: document.getElementById('kpi_card'),
      three: document.getElementById('three_card'),
      pressure: document.getElementById('chart_pressure_card'),
      corr: document.getElementById('corr_card')
    };

    // Customize modal controls
    const customizeBtn = document.getElementById('btn_customize');
    const customizeModal = document.getElementById('customize_modal');
    const customizeClose = document.getElementById('customize_close');
    const customizeApply = document.getElementById('customize_apply');

    const inputs = {
      kpi: { show: document.getElementById('show_kpi'), size: document.getElementById('size_kpi') },
      three: { show: document.getElementById('show_three'), size: document.getElementById('size_three') },
      pressure: { show: document.getElementById('show_pressure'), size: document.getElementById('size_pressure') },
      corr: { show: document.getElementById('show_corr'), size: document.getElementById('size_corr') }
    };

    const loadPrefs = () => { try { const raw = localStorage.getItem('layoutPrefs'); return raw ? JSON.parse(raw) : null; } catch { return null; } };
    const savePrefs = (prefs) => { try { localStorage.setItem('layoutPrefs', JSON.stringify(prefs)); } catch {} };

    const triggerVisualResizes = () => {
      try { if (window.Plotly) {
        const chart = document.getElementById('pressure_chart');
        const corr = document.getElementById('corr_matrix');
        if (chart) window.Plotly.Plots.resize(chart);
        if (corr) window.Plotly.Plots.resize(corr);
      }} catch {}
      try {
        const container = document.getElementById('three_container');
        if (container && window.threeRenderer && window.threeCamera) {
          const rect = container.getBoundingClientRect();
          window.threeCamera.aspect = rect.width / Math.max(rect.height, 1);
          window.threeCamera.updateProjectionMatrix();
          window.threeRenderer.setSize(rect.width, rect.height, false);
        }
      } catch {}
    };

    const applyPrefs = (prefs) => {
      if (!prefs) return;
      Object.keys(cards).forEach(key => {
        const card = cards[key];
        if (!card) return;
        const p = prefs[key] || {};
        card.style.display = p.show === false ? 'none' : '';
        card.classList.remove('size-s','size-m','size-l');
        const def = key === 'pressure' ? 'l' : (key === 'kpi' ? 's' : 'm');
        card.classList.add(`size-${p.size || def}`);
      });
      setTimeout(triggerVisualResizes, 50);
    };

    const collectPrefsFromUI = () => ({
      kpi: { show: inputs.kpi.show.checked, size: inputs.kpi.size.value },
      three: { show: inputs.three.show.checked, size: inputs.three.size.value },
      pressure: { show: inputs.pressure.show.checked, size: inputs.pressure.size.value },
      corr: { show: inputs.corr.show.checked, size: inputs.corr.size.value }
    });

    const fillUIFromPrefs = (prefs) => {
      inputs.kpi.show.checked = prefs?.kpi?.show !== false;
      inputs.kpi.size.value = prefs?.kpi?.size || 's';
      inputs.three.show.checked = prefs?.three?.show !== false;
      inputs.three.size.value = prefs?.three?.size || 'm';
      inputs.pressure.show.checked = prefs?.pressure?.show !== false;
      inputs.pressure.size.value = prefs?.pressure?.size || 'l';
      inputs.corr.show.checked = prefs?.corr?.show !== false;
      inputs.corr.size.value = prefs?.corr?.size || 'm';
    };

    if (customizeBtn && customizeModal) {
      customizeBtn.addEventListener('click', ()=>{
        fillUIFromPrefs(loadPrefs() || {});
        customizeModal.classList.remove('hidden');
      });
      customizeClose?.addEventListener('click', ()=> customizeModal.classList.add('hidden'));
      customizeApply?.addEventListener('click', ()=>{
        const prefs = collectPrefsFromUI();
        savePrefs(prefs);
        applyPrefs(prefs);
        customizeModal.classList.add('hidden');
      });
      // Apply stored prefs on load
      applyPrefs(loadPrefs() || {});
    }

    // Resize observers
    const ro = new ResizeObserver(()=> triggerVisualResizes());
    ['pressure_chart','corr_matrix','three_container','dashboard_grid'].forEach(id=>{
      const el = document.getElementById(id);
      if (el) ro.observe(el);
    });

    // Also throttle window resize
    let resizeTimer; window.addEventListener('resize', ()=>{ clearTimeout(resizeTimer); resizeTimer = setTimeout(triggerVisualResizes, 100); });
  });
})();
