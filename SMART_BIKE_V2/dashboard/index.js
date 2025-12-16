// Smart Bike Dashboard JS
let wSocket = null;
let reconnectInterval = 2000; // ms
let reconnectTimeout = null;

// State
let simState = false;
let t0 = null;
let sampleCount = 0;
let simTimer = null;
let liveMode = true;
let currentRun = null; // { name, rows, fields }
let pollingTimer = null;  // For HTTP polling when no WebSocket
const LIVE_WINDOW_SECONDS = 60;  // 60-second rolling window for live data
let isPlottingCSV = false;  // Track if we're plotting CSV data vs live data

// UI refs
const themeToggler = document.querySelector(".theme-toggler");
const wsEl = document.getElementById("wsMessage");
const latestPressureEl = document.getElementById("latest_pressure");
const sampleCountEl = document.getElementById("sample_count");
const durationEl = document.getElementById("duration");
const chartDivRight = document.getElementById("pressure_chart_right");
const chartDivLeft = document.getElementById("pressure_chart_left");
const corrDiv = document.getElementById("corr_matrix");
const liveModeChk = document.getElementById('live_mode');
const btnRefreshRuns = document.getElementById('btn_refresh_runs');
const runSelect = document.getElementById('run_select');
const btnLoadRun = document.getElementById('btn_load_run');
const xFieldSel = document.getElementById('x_field');
const yFieldSel = document.getElementById('y_field');
const y2FieldSel = document.getElementById('y2_field');
const dualAxisChk = document.getElementById('dual_axis');
const langButtons = document.querySelectorAll('.lang-btn');
// Layout & Runner management refs
const runnerFilterSel = document.getElementById('runner_filter');
const renameInput = document.getElementById('rename_input');
const btnRenameRun = document.getElementById('btn_rename_run');
const layoutSelect = document.getElementById('layout_select');
const rowLive = document.getElementById('row_live');
const rowLayout = document.getElementById('row_layout');
const rowRunner = document.getElementById('row_runner');
const rowAxes = document.getElementById('row_axes');
const rowSmoothing = document.getElementById('row_smoothing');
const rowThresholds = document.getElementById('row_thresholds');
const kpiGrid = document.getElementById('kpi_grid');
const meanPressureEl = document.getElementById('mean_pressure');
const maxPressureEl = document.getElementById('max_pressure');
const pressureCardRight = document.getElementById('chart_pressure_right_card');
const pressureCardLeft = document.getElementById('chart_pressure_left_card');
const corrCard = document.getElementById('corr_card');
const threeCard = document.getElementById('three_card');
const threeContainer = document.getElementById('three_container');
// Smoothing & downsample controls
const smoothingSel = document.getElementById('smoothing_mode');
const maWindowInp = document.getElementById('ma_window');
const ewmaAlphaInp = document.getElementById('ewma_alpha');
const downsampleStrideInp = document.getElementById('downsample_stride');
const maxPointsInp = document.getElementById('max_points');
const lowerThInp = document.getElementById('lower_threshold');
const upperThInp = document.getElementById('upper_threshold');
const zonesToggle = document.getElementById('zones_toggle');
// Sidebar navigation & import
const navLinks = document.querySelectorAll('.nav-link');
const btnImportRun = document.getElementById('btn_import_run');
const fileImport = document.getElementById('file_import');
// Filters modal
const filtersBtn = document.getElementById('btn_filters');
const filtersModal = document.getElementById('filters_modal');
const filtersClose = document.getElementById('filters_close');
const filtersApply = document.getElementById('filters_apply');
// Local model load UI
const btnLoadModel = document.getElementById('btn_load_model');
const fileLoadModel = document.getElementById('file_load_model');
const btnFitView = document.getElementById('btn_fit_view');
const modelSelect = document.getElementById('model_select');
const btnLoadHandlebar = document.getElementById('btn_load_handlebar');
const fileLoadHandlebar = document.getElementById('file_load_handlebar');

// Profile / Settings UI
const btnProfile = document.getElementById('btn_profile');
const profileModal = document.getElementById('profile_modal');
const profileClose = document.getElementById('profile_close');
const profileSelect = document.getElementById('profile_select');
const btnSetActive = document.getElementById('btn_set_active');
const newRunnerName = document.getElementById('new_runner_name');
const btnCreateRunner = document.getElementById('btn_create_runner');
const unsortedList = document.getElementById('unsorted_list');
const profileRunsList = document.getElementById('profile_runs_list');
const btnMoveSelected = document.getElementById('btn_move_selected');
const renameRunInput = document.getElementById('rename_run_input');
const btnRenameProfileRun = document.getElementById('btn_rename_profile_run');
const btnDeleteProfileRun = document.getElementById('btn_delete_profile_run');

const RESERVED_UNSORTED = 'unsorted_run';

function showProfileModal() {
  if (!profileModal) return;
  profileModal.classList.remove('hidden');
  refreshProfilesUI();
}
function hideProfileModal() { if (profileModal) profileModal.classList.add('hidden'); }

async function apiGetJSON(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}
async function apiPostForm(url, data) {
  const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data).toString() });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json().catch(()=>({ok:true}));
}

async function refreshProfilesUI() {
  try {
    // Populate runners
    const runnersInfo = await apiGetJSON('/api/runners');
    const runners = Array.isArray(runnersInfo.runners) ? runnersInfo.runners : [];
    const active = runnersInfo.active || '';
    profileSelect.innerHTML = '';
    // Show only real runners (exclude reserved like 'models')
    for (const r of runners) {
      if (r === 'models') continue;
      const opt = document.createElement('option');
      opt.value = r; opt.textContent = r; if (r === active) opt.selected = true; profileSelect.appendChild(opt);
    }
    // Populate lists
    await refreshRunsLists();
  } catch (e) {
    console.error('Failed loading runners:', e);
  }
}

async function refreshRunsLists() {
  try {
    // Unsorted
    const unsorted = await apiGetJSON(`/api/runs-in?runner=${encodeURIComponent(RESERVED_UNSORTED)}`);
    unsortedList.innerHTML = '';
    for (const f of unsorted) {
      const opt = document.createElement('option');
      opt.value = f; opt.textContent = f; unsortedList.appendChild(opt);
    }
    // Selected profile
    const prof = profileSelect.value;
    const profRuns = prof ? await apiGetJSON(`/api/runs-in?runner=${encodeURIComponent(prof)}`) : [];
    profileRunsList.innerHTML = '';
    for (const f of profRuns) {
      const opt = document.createElement('option');
      opt.value = f; opt.textContent = f; profileRunsList.appendChild(opt);
    }
  } catch (e) {
    console.error('Failed loading runs lists:', e);
  }
}

btnProfile && btnProfile.addEventListener('click', showProfileModal);
profileClose && profileClose.addEventListener('click', hideProfileModal);
profileSelect && profileSelect.addEventListener('change', refreshRunsLists);

btnSetActive && btnSetActive.addEventListener('click', async () => {
  const prof = profileSelect.value;
  if (!prof) return;
  try { await apiPostForm('/api/active-runner', { runner: prof }); } catch (e) { console.error(e); }
});

btnCreateRunner && btnCreateRunner.addEventListener('click', async () => {
  const name = (newRunnerName.value || '').trim();
  if (!name) return;
  try { await apiPostForm('/api/create-runner', { name }); newRunnerName.value=''; await refreshProfilesUI(); }
  catch(e){ console.error(e); }
});

btnMoveSelected && btnMoveSelected.addEventListener('click', async () => {
  const prof = profileSelect.value; if (!prof) return;
  const selected = Array.from(unsortedList.selectedOptions).map(o=>o.value);
  for (const fname of selected) {
    try {
      await apiPostForm('/api/move-run', { src: `${RESERVED_UNSORTED}/${fname}`, dst: `${prof}/${fname}` });
    } catch (e) { console.error('Move failed for', fname, e); }
  }
  await refreshRunsLists();
});

btnRenameProfileRun && btnRenameProfileRun.addEventListener('click', async () => {
  const prof = profileSelect.value; if (!prof) return;
  const selected = profileRunsList.selectedOptions;
  if (selected.length !== 1) { console.log('Select exactly one run to rename'); return; }
  const oldName = selected[0].value;
  const newName = (renameRunInput.value || '').trim();
  if (!newName) { console.log('Enter a new name'); return; }
  try {
    await apiPostForm('/api/rename-run', { folder: prof, old: oldName, new: newName });
    renameRunInput.value = '';
    await refreshRunsLists();
  } catch (e) { console.error('Rename failed', e); }
});

btnDeleteProfileRun && btnDeleteProfileRun.addEventListener('click', async () => {
  const prof = profileSelect.value; if (!prof) return;
  const selected = Array.from(profileRunsList.selectedOptions).map(o=>o.value);
  if (selected.length === 0) { console.log('Select at least one run to delete'); return; }
  if (!confirm(`Delete ${selected.length} run(s)?`)) return;
  for (const fname of selected) {
    try {
      await apiPostForm('/api/delete-run', { folder: prof, file: fname });
    } catch (e) { console.error('Delete failed for', fname, e); }
  }
  await refreshRunsLists();
});

// Three.js state
let threeScene = null, threeRenderer = null, threeCamera = null, bikeModel = null, bikePivot = null, threeFrame = null;
let oriYaw = 0, oriPitch = 0, oriRoll = 0; // radians from sensor data

// Plotly time-series setup for two graphs
const chartLayout = {
  title: '',
  xaxis: { title: 'Time [s]', autorange: true },
  yaxis: { title: 'Voltage [V]', range: [0, 3.5], autorange: false },
  margin: { t: 10, r: 10, b: 40, l: 50 },
  showlegend: true,
  legend: { x: 0, y: 1, orientation: 'h' }
};
const chartConfig = { responsive: true, displayModeBar: false };

// Colors for 4 sensors
const colors = ['#2196f3', '#4caf50', '#ff9800', '#e91e63'];

// Initialize right handle chart (sensors 1-4)
Plotly.newPlot(chartDivRight, [
  { x: [], y: [], mode: 'lines', line: { color: colors[0], width: 2 }, name: 'Sensor 1' },
  { x: [], y: [], mode: 'lines', line: { color: colors[1], width: 2 }, name: 'Sensor 2' },
  { x: [], y: [], mode: 'lines', line: { color: colors[2], width: 2 }, name: 'Sensor 3' },
  { x: [], y: [], mode: 'lines', line: { color: colors[3], width: 2 }, name: 'Sensor 4' }
], chartLayout, chartConfig);

// Initialize left handle chart (sensors 5-8)
Plotly.newPlot(chartDivLeft, [
  { x: [], y: [], mode: 'lines', line: { color: colors[0], width: 2 }, name: 'Sensor 5' },
  { x: [], y: [], mode: 'lines', line: { color: colors[1], width: 2 }, name: 'Sensor 6' },
  { x: [], y: [], mode: 'lines', line: { color: colors[2], width: 2 }, name: 'Sensor 7' },
  { x: [], y: [], mode: 'lines', line: { color: colors[3], width: 2 }, name: 'Sensor 8' }
], chartLayout, chartConfig);

// Stats accumulators for live mode
let sumPressure = 0;
let maxPressure = -Infinity;

function connect() {
  // For ESP32, use HTTP polling instead of WebSocket
  // WebSocket can be added later if needed
  if (location.protocol === 'file:') {
    logToConsole('Running from file:// — Using Simulation mode.');
    updateWelcomeMsg('Local file mode - Using Simulation', 'darkGray');
    return;
  }
  
  // Start HTTP polling for live data from ESP32
  startHttpPolling();
  updateWelcomeMsg('Connected (HTTP polling)', 'darkGreen');
}

// Fetch live ADC data from ESP32 via HTTP
async function startHttpPolling() {
  if (pollingTimer) return; // Already running
  
  const fetchLiveData = async () => {
    if (!liveMode) return; // Skip if not in live mode
    
    try {
      const resp = await fetch('/api/live');
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      
      const data = await resp.json();
      // data = { timestamp: <ms>, active: <bool>, run_id: <int>, sensors: [v1,v2,...v8] }
      
      if (data.active && data.sensors && data.sensors.length === 8) {
        // Pass individual sensor voltages for plotting
        handleSensorData(data.sensors, data.timestamp);
      }
    } catch (e) {
      // Log errors to help debugging
      logToConsole(`Polling error: ${e}`);
    }
  };
  
  // Poll every 100ms for smoother real-time visualization
  function updateHandlebarHeatmap() {
    if (!handlebarRoot) return;

    // Collect candidate grip meshes (prefer names; fallback to heuristics)
    const gripMeshes = [];
    handlebarRoot.traverse(obj => {
      if (obj.isMesh && obj.geometry && obj.geometry.isBufferGeometry) {
        const name = (obj.name || '').toLowerCase();
        const namedGrip = name.includes('grip') || name.includes('handle') || name.includes('barend');

        const bbox = new THREE.Box3().setFromObject(obj);
        const size = new THREE.Vector3();
        bbox.getSize(size);
        const maxDim = Math.max(size.x, size.y, size.z);
        const minDim = Math.min(size.x, size.y, size.z);

        // Heuristic: grips are short segments compared to the main bar.
        const isLikelyGrip = maxDim < 0.6 && minDim > 0.02;

        // Exclude meshes that are extremely long (main bar)
        const isMainBar = maxDim > 0.8 && minDim < 0.06;

        if (!isMainBar && (namedGrip || isLikelyGrip)) {
          gripMeshes.push(obj);
        }
      }
    });

    if (gripMeshes.length === 0) {
      console.warn("No grip meshes detected; ensuring materials allow colors.");
      // As fallback, enable vertexColors on all meshes to help debugging
      handlebarRoot.traverse(obj => {
        if (obj.isMesh) {
          const mat = obj.material;
          if (Array.isArray(mat)) {
            mat.forEach(m => { m.vertexColors = true; m.color && m.color.set(0xffffff); m.needsUpdate = true; });
          } else if (mat) {
            mat.vertexColors = true;
            mat.color && mat.color.set(0xffffff);
            mat.needsUpdate = true;
          }
        }
      });
      return;
    }

    // Ensure we have 8 sensor values (4 right, 4 left)
    const sensors = sensorPressures && sensorPressures.length >= 8
      ? sensorPressures
      : [50, 60, 70, 80, 50, 60, 70, 80];

    // Determine left vs right by mesh centers along X
    const centers = gripMeshes.map(m => new THREE.Box3().setFromObject(m).getCenter(new THREE.Vector3()));
    const avgX = centers.reduce((s, c) => s + c.x, 0) / centers.length;

    const leftSide = gripMeshes.filter((m, i) => centers[i].x < avgX);
    const rightSide = gripMeshes.filter((m, i) => centers[i].x >= avgX);

    const applyColorsToGrip = (mesh, side) => {
      // Work on non-indexed copy to color per-vertex
      const geom = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
      const pos = geom.getAttribute('position');
      const count = pos.count;

      // Choose mapping axis by longest bbox dimension but avoid the bar's long axis; if very short in Y, use X/Z.
      const bbox = new THREE.Box3().setFromObject(mesh);
      const size = new THREE.Vector3();
      bbox.getSize(size);
      let axis = 'y';
      const dims = [size.x, size.y, size.z];
      const maxIdx = dims.indexOf(Math.max(...dims));
      axis = maxIdx === 0 ? 'x' : maxIdx === 1 ? 'y' : 'z';

      // If chosen axis range is tiny (e.g., flattened), pick another
      const ranges = { x: Math.max(1e-6, Math.abs(bbox.max.x - bbox.min.x)), y: Math.max(1e-6, Math.abs(bbox.max.y - bbox.min.y)), z: Math.max(1e-6, Math.abs(bbox.max.z - bbox.min.z)) };
      if (ranges[axis] < 0.02) {
        axis = ranges.x >= ranges.z ? 'x' : 'z';
      }

      const min = bbox.min[axis];
      const max = bbox.max[axis];

      const colors = new Float32Array(count * 3);

      const sideSensors = side === 'right' ? sensors.slice(0, 4) : sensors.slice(4, 8);

      for (let i = 0; i < count; i++) {
        const vx = pos.getX(i);
        const vy = pos.getY(i);
        const vz = pos.getZ(i);
        const v = axis === 'x' ? vx : axis === 'y' ? vy : vz;
        const t = THREE.MathUtils.clamp((v - min) / (max - min || 1), 0, 1);
        const idx = Math.min(3, Math.floor(t * 4));
        const pressure = sideSensors[idx];
        const p = THREE.MathUtils.clamp(pressure, 0, 100) / 100;
        const color = pressureToColor(p);
        colors[i * 3 + 0] = color.r;
        colors[i * 3 + 1] = color.g;
        colors[i * 3 + 2] = color.b;
      }

      geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));

      // Ensure material uses vertex colors and isn't multiplying by black
      const mat = mesh.material;
      if (Array.isArray(mat)) {
        mat.forEach(m => {
          m.vertexColors = true;
          if (m.map) m.map = null;
          m.color && m.color.set(0xffffff);
          m.needsUpdate = true;
        });
      } else if (mat) {
        mat.vertexColors = true;
        if (mat.map) mat.map = null;
        mat.color && mat.color.set(0xffffff);
        mat.needsUpdate = true;
      }

      mesh.geometry = geom;
    };

    rightSide.forEach(m => applyColorsToGrip(m, 'right'));
    leftSide.forEach(m => applyColorsToGrip(m, 'left'));

    // Final render to show updates immediately
    handlebarRenderer && handlebarRenderer.render(handlebarScene, handlebarCamera);
  }
  if (meanPressureEl) meanPressureEl.textContent = `${(sumPressure / sampleCount).toFixed(2)} N`;
  if (maxPressureEl && isFinite(maxPressure)) maxPressureEl.textContent = `${maxPressure.toFixed(2)} N`;
}

function handlePressure(value, t) {
  // Legacy function kept for compatibility with simulation/other features
  if (!isFinite(value)) return;

  if (t0 == null) t0 = performance.now();
  const now = (typeof t === 'number') ? t : (performance.now() - t0);
  const seconds = now / 1000;

  if (latestPressureEl) latestPressureEl.textContent = `${value.toFixed(2)} N`;
  sampleCount += 1;
  if (sampleCountEl) sampleCountEl.textContent = `${sampleCount}`;
  if (durationEl) durationEl.textContent = `${seconds.toFixed(1)}s`;

  // Update stats
  sumPressure += value;
  if (value > maxPressure) maxPressure = value;
  if (meanPressureEl) meanPressureEl.textContent = `${(sumPressure / sampleCount).toFixed(2)} N`;
  if (maxPressureEl && isFinite(maxPressure)) maxPressureEl.textContent = `${maxPressure.toFixed(2)} N`;
}

function updateWelcomeMsg(msg, color) {
  if (wsEl) {
    wsEl.style.color = color;
    wsEl.textContent = msg;
  }
}

function logToConsole(msg) {
  try { console.log(msg); } catch (_) {}
}

// Buttons
const simBtn = document.getElementById('toggleSim');
const clearChartBtn = document.getElementById('btn_clear_chart');
const downloadAllBtn = document.getElementById('btn_download_all');

function sendToggle(label, value) {
  if (wSocket && wSocket.readyState === WebSocket.OPEN) {
    const message = `${label}=${value}`;
    wSocket.send(message);
    logToConsole(`TX: ${message}`);
  } else {
    logToConsole('WS not connected.');
  }
}

function updateSimButton() {
  if (simBtn) simBtn.textContent = `Simulation: ${simState ? 'ON' : 'OFF'}`;
}

if (simBtn) simBtn.addEventListener('click', () => {
  simState = !simState;
  updateSimButton();
  sendToggle('SIM_ENABLE', simState);
  if (simState) startSim(); else stopSim();
});

if (clearChartBtn) clearChartBtn.addEventListener('click', () => {
  // Clear right handle chart
  Plotly.react(chartDivRight, [
    { x: [], y: [], mode: 'lines', line: { color: colors[0], width: 2 }, name: 'Sensor 1' },
    { x: [], y: [], mode: 'lines', line: { color: colors[1], width: 2 }, name: 'Sensor 2' },
    { x: [], y: [], mode: 'lines', line: { color: colors[2], width: 2 }, name: 'Sensor 3' },
    { x: [], y: [], mode: 'lines', line: { color: colors[3], width: 2 }, name: 'Sensor 4' }
  ], chartLayout, chartConfig);
  
  // Clear left handle chart
  Plotly.react(chartDivLeft, [
    { x: [], y: [], mode: 'lines', line: { color: colors[0], width: 2 }, name: 'Sensor 5' },
    { x: [], y: [], mode: 'lines', line: { color: colors[1], width: 2 }, name: 'Sensor 6' },
    { x: [], y: [], mode: 'lines', line: { color: colors[2], width: 2 }, name: 'Sensor 7' },
    { x: [], y: [], mode: 'lines', line: { color: colors[3], width: 2 }, name: 'Sensor 8' }
  ], chartLayout, chartConfig);
  
  t0 = null; sampleCount = 0;
  if (latestPressureEl) latestPressureEl.textContent = '0 N';
  if (sampleCountEl) sampleCountEl.textContent = '0';
  if (durationEl) durationEl.textContent = '0s';
  sumPressure = 0; maxPressure = -Infinity;
  if (meanPressureEl) meanPressureEl.textContent = '0 N';
  if (maxPressureEl) maxPressureEl.textContent = '0 N';
  
  // Return to live mode
  isPlottingCSV = false;
  liveMode = true;
  if (liveModeChk) liveModeChk.checked = true;
  startHttpPolling();
});

// Console UI removed; no reset needed

// Theme toggle updates chart colors
function applyChartTheme() {
  const chartBGColor = getComputedStyle(document.body).getPropertyValue('--chart-background');
  const chartFontColor = getComputedStyle(document.body).getPropertyValue('--chart-font-color');
  const chartAxisColor = getComputedStyle(document.body).getPropertyValue('--chart-axis-color');
  const update = {
    plot_bgcolor: chartBGColor,
    paper_bgcolor: chartBGColor,
    font: { color: chartFontColor },
    xaxis: { color: chartAxisColor, linecolor: chartAxisColor },
    yaxis: { color: chartAxisColor, linecolor: chartAxisColor },
  };
  Plotly.relayout(chartDivRight, update);
  Plotly.relayout(chartDivLeft, update);
  
  // Update handlebar 3D scene background
  if (handlebarScene) {
    const isDark = document.body.classList.contains('dark-theme-variables');
    handlebarScene.background = new THREE.Color(isDark ? 0x1a1a1a : 0xf0f0f0);
  }
}

function loadThemePreference() {
  const savedTheme = localStorage.getItem('theme');
  // Default to light theme if no preference
  if (savedTheme === 'dark') {
    document.body.classList.add('dark-theme-variables');
    themeToggler.querySelector('span:nth-child(1)').classList.remove('active');
    themeToggler.querySelector('span:nth-child(2)').classList.add('active');
  } else {
    // Ensure light theme is active (default)
    document.body.classList.remove('dark-theme-variables');
    themeToggler.querySelector('span:nth-child(1)').classList.add('active');
    themeToggler.querySelector('span:nth-child(2)').classList.remove('active');
  }
  applyChartTheme();
}

function saveThemePreference() {
  const isDark = document.body.classList.contains('dark-theme-variables');
  localStorage.setItem('theme', isDark ? 'dark' : 'light');
}

themeToggler.addEventListener('click', () => {
  document.body.classList.toggle('dark-theme-variables');
  themeToggler.querySelector('span:nth-child(1)').classList.toggle('active');
  themeToggler.querySelector('span:nth-child(2)').classList.toggle('active');
  applyChartTheme();
  saveThemePreference();
});

// Init
window.addEventListener('load', () => {
  loadThemePreference();
  connect();
  if (btnRefreshRuns) btnRefreshRuns.addEventListener('click', listRuns);
  if (btnLoadRun) btnLoadRun.addEventListener('click', plotSelectedRun);
  if (liveModeChk) liveModeChk.addEventListener('change', () => { 
    liveMode = liveModeChk.checked; 
    if (liveMode) {
      startHttpPolling();
    } else {
      stopHttpPolling();
    }
  });
  langButtons.forEach(btn => btn.addEventListener('click', () => setLanguage(btn.dataset.lang)));
  setLanguage(loadLangPref());
  
  // Download all CSV files
  if (downloadAllBtn) {
    downloadAllBtn.addEventListener('click', async () => {
      console.log('Download All button clicked');
      
      // Check if JSZip is available
      if (typeof JSZip === 'undefined') {
        alert('ZIP library not loaded. Downloading files individually...');
        // Fallback to individual downloads
        downloadFilesIndividually();
        return;
      }
      
      try {
        console.log('Fetching run list from /api/runs');
        downloadAllBtn.disabled = true;
        downloadAllBtn.textContent = 'Downloading...';
        
        const resp = await fetch('/api/runs');
        if (!resp.ok) {
          console.error('Failed to fetch run list:', resp.status);
          throw new Error('Failed to fetch run list');
        }
        const files = await resp.json();
        console.log('Found files:', files);
        
        if (files.length === 0) {
          alert('No CSV files found on SD card');
          downloadAllBtn.disabled = false;
          downloadAllBtn.textContent = 'Download All CSV';
          return;
        }
        
        // Create ZIP file
        const zip = new JSZip();
        
        // Fetch all files and add to ZIP
        for (let i = 0; i < files.length; i++) {
          const filename = files[i];
          const url = `/api/runs/${filename}`;
          console.log(`Fetching file ${i+1}/${files.length}: ${filename}`);
          downloadAllBtn.textContent = `Downloading ${i+1}/${files.length}...`;
          
          const fileResp = await fetch(url);
          if (fileResp.ok) {
            const blob = await fileResp.blob();
            zip.file(filename, blob);
          } else {
            console.error(`Failed to download ${filename}`);
          }
          
          // Small delay to avoid overwhelming ESP32
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        console.log('Creating ZIP file...');
        downloadAllBtn.textContent = 'Creating ZIP...';
        
        // Generate ZIP file
        const zipBlob = await zip.generateAsync({ type: 'blob' });
        
        // Create download link
        const url = URL.createObjectURL(zipBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `SmartBike_Runs_${new Date().toISOString().slice(0,10)}.zip`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        console.log(`ZIP download complete: ${files.length} files`);
        alert(`Downloaded ${files.length} CSV file(s) as ZIP`);
        
      } catch (err) {
        console.error('Error downloading files:', err);
        alert('Error downloading files: ' + err.message);
      } finally {
        downloadAllBtn.disabled = false;
        downloadAllBtn.textContent = 'Download All CSV';
      }
    });
  } else {
    console.warn('Download All button not found in DOM');
  }
  
  // Fallback function for individual downloads
  async function downloadFilesIndividually() {
    try {
      const resp = await fetch('/api/runs');
      if (!resp.ok) throw new Error('Failed to fetch run list');
      const files = await resp.json();
      
      if (files.length === 0) {
        alert('No CSV files found on SD card');
        return;
      }
      
      for (let i = 0; i < files.length; i++) {
        const filename = files[i];
        const url = `/api/runs/${filename}`;
        
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        
        if (i < files.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 300));
        }
      }
      
      alert(`Downloaded ${files.length} CSV file(s)`);
    } catch (err) {
      console.error('Error downloading files:', err);
      alert('Error downloading files: ' + err.message);
    }
  }
  
  // Sidebar nav
  navLinks.forEach(link => link.addEventListener('click', (e) => {
    e.preventDefault();
    const mode = link.dataset.layout;
    applyLayout(mode);
    setActiveNav(mode);
  }));
  // Import run from SD card
  if (btnImportRun) {
    btnImportRun.addEventListener('click', async () => {
      try {
        const resp = await fetch('/api/runs');
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const runs = await resp.json();
        
        if (!Array.isArray(runs) || runs.length === 0) {
          alert('No SD card mounted or no run files found on SD card.');
          return;
        }
        
        // Show file selection dialog
        const selected = await showRunSelectionDialog(runs);
        if (selected) {
          await loadAndPlotCSV(selected);
        }
      } catch (e) {
        alert('Error accessing SD card: ' + e.message);
        logToConsole(`Import error: ${e}`);
      }
    });
  }
  
  // Keep local file import for backward compatibility
  if (fileImport) {
    fileImport.addEventListener('change', onImportFileChange);
  }
  // Local 3D model loader
  if (btnLoadModel && fileLoadModel) {
    btnLoadModel.addEventListener('click', () => fileLoadModel.click());
    fileLoadModel.addEventListener('change', onLoadModelFileChange);
  }
  if (btnLoadHandlebar && fileLoadHandlebar) {
    btnLoadHandlebar.addEventListener('click', () => fileLoadHandlebar.click());
    fileLoadHandlebar.addEventListener('change', onLoadHandlebarFileChange);
  }
  if (btnFitView) {
    btnFitView.addEventListener('click', () => {
      const target = bikePivot || bikeModel;
      if (target) frameObject(target); else logToConsole('No model to frame.');
    });
  }
  // Model selector
  if (modelSelect) {
    modelSelect.addEventListener('change', (e) => {
      const selectedModel = e.target.value;
      if (selectedModel) {
        tryLoadBikeModel(selectedModel);
      }
    });
  }
  // Filters modal wiring
  if (filtersBtn && filtersModal) {
    filtersBtn.addEventListener('click', () => openFilters());
  }
  if (filtersClose) filtersClose.addEventListener('click', () => closeFilters());
  if (filtersApply) filtersApply.addEventListener('click', () => { if (!liveMode) replotCurrent(); closeFilters(); });
  // Close modal on overlay click
  if (filtersModal) filtersModal.addEventListener('click', (e) => {
    if (e.target === filtersModal) closeFilters();
  });
  // ESC to close
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeFilters(); });
  if (btnRenameRun) btnRenameRun.addEventListener('click', renameSelectedRun);
  if (runnerFilterSel) runnerFilterSel.addEventListener('change', filterRunsByRunner);
  applyLayout('live');
  setActiveNav('live');
  // replot current when any control changes
  [smoothingSel, maWindowInp, ewmaAlphaInp, downsampleStrideInp, maxPointsInp].forEach(el => {
    if (el) el.addEventListener('change', () => { if (!liveMode) replotCurrent(); });
  });
  [lowerThInp, upperThInp, zonesToggle].forEach(el => { if (el) el.addEventListener('change', () => { if (!liveMode) replotCurrent(); }); });
  // Initialize 3D viewers
  initThree();
  initHandlebar();

  // Fallback wiring for Customize modal if ui-layout.js isn't active
  // Customize modal removed
});

// Customize modal removed

function openFilters() { if (filtersModal) filtersModal.classList.remove('hidden'); }
function closeFilters() { if (filtersModal) filtersModal.classList.add('hidden'); }

// Simple client-side simulator to generate data when SIM is ON
function startSim() {
  if (simTimer) return;
  if (t0 == null) t0 = performance.now();
  // Realistic orientation state (degrees)
  let yaw = 0, pitch = 0, roll = 0; // stay near upright
  let yawEvent = null, pitchEvent = null, rollEvent = null; // transient turns/leans
  const dt = 0.2; // seconds per tick
  const decay = { yaw: 0.8, pitch: 1.0, roll: 1.2 }; // pull back to 0 (per second)
  const sigma = { yaw: 4, pitch: 3, roll: 4 }; // random jitter (deg/s)
  const limits = { yaw: 45, pitch: 45, roll: 45 }; // bounds (deg) - max ±45 degrees

  function stepOU(val, k, s) {
    // Ornstein–Uhlenbeck style drift toward 0 with jitter
    const drift = -k * val * dt;
    const noise = s * dt * (Math.random() * 2 - 1);
    return val + drift + noise;
  }
  function clamp(v, lim) { return Math.max(-lim, Math.min(lim, v)); }
  function maybeStartEvent() {
    // Low probability transient: turn or lean for 1–2s (max ±45 degrees)
    if (!yawEvent && Math.random() < 0.05) yawEvent = { target: (Math.random()<0.5?1:-1) * (15 + Math.random()*30), t: 1 + Math.random() * 1.2 };
    if (!pitchEvent && Math.random() < 0.04) pitchEvent = { target: (Math.random()<0.5?1:-1) * (10 + Math.random()*25), t: 0.8 + Math.random() * 1.0 };
    if (!rollEvent && Math.random() < 0.04) rollEvent = { target: (Math.random()<0.5?1:-1) * (15 + Math.random()*30), t: 0.8 + Math.random() * 1.2 };
  }
  function applyEvent(val, evt) {
    if (!evt) return val;
    // Move a fraction toward target, and decay time
    val += (evt.target - val) * 0.5 * dt;
    evt.t -= dt;
    if (evt.t <= 0) return val;
    return val;
  }

  simTimer = setInterval(() => {
    const now = performance.now() - t0;
    // Pressure profile: quasi-periodic effort with noise
    const base = 40;
    const sine = 18 * Math.sin(now / 1000 * 1.6);
    const noise = (Math.random() - 0.5) * 6;
    const v = Math.max(0, base + sine + noise);
    handlePressure(v);

    // Orientation: mostly straight, occasional small events
    maybeStartEvent();
    yaw = stepOU(yaw, decay.yaw, sigma.yaw); yaw = applyEvent(yaw, yawEvent); yaw = clamp(yaw, limits.yaw);
    pitch = stepOU(pitch, decay.pitch, sigma.pitch); pitch = applyEvent(pitch, pitchEvent); pitch = clamp(pitch, limits.pitch);
    roll = stepOU(roll, decay.roll, sigma.roll); roll = applyEvent(roll, rollEvent); roll = clamp(roll, limits.roll);
    // Clear finished events
    if (yawEvent && yawEvent.t <= 0) yawEvent = null;
    if (pitchEvent && pitchEvent.t <= 0) pitchEvent = null;
    if (rollEvent && rollEvent.t <= 0) rollEvent = null;

    handleOrientation(yaw, pitch, roll);
    
    // Simulate handlebar sensor pressures
    simulateHandlebarPressure();
  }, 200);
}

function simulateHandlebarPressure() {
  // Generate realistic pressure pattern across 8 sensors
  // Create distinct values for each sensor to clearly show the 4 zones per grip
  const now = performance.now();
  
  // Create a "wave" pattern that cycles through the sensors
  const phase = (now / 3000) % 1; // 0 to 1, repeating every 3 seconds
  
  for (let i = 0; i < 8; i++) {
    // Create a wave that peaks at different sensors over time
    const sensorPhase = (i / 8 + phase) % 1;
    const wave = Math.sin(sensorPhase * Math.PI * 2) * 0.5 + 0.5; // 0 to 1
    
    // Base pressure varies by sensor position (top sensors typically get more pressure)
    const positionFactor = i % 4; // 0-3 for each grip
    let basePressure = 30 + positionFactor * 15; // 30, 45, 60, 75
    
    // Apply wave modulation
    const pressure = basePressure + wave * 40;
    
    // Add small noise for realism
    const noise = (Math.random() - 0.5) * 5;
    
    // Convert to voltage (assuming 0-100N maps to 0-3.3V)
    sensorPressures[i] = Math.max(0, Math.min(3.3, ((pressure + noise) / 100) * 3.3));
  }
  
  updateHandlebarHeatmap();
}

function stopSim() {
  if (!simTimer) return;
  clearInterval(simTimer);
  simTimer = null;
}

// ---------- Run loading and plotting ----------

async function listRuns() {
  try {
    const resp = await fetch('/api/runs'); // ESP32 API endpoint
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const names = Array.isArray(data) ? data : [];
    populateRuns(names);
    logToConsole(`Runs: ${names.join(', ')}`);
  } catch (e) {
    logToConsole(`Failed to list runs: ${e}`);
  }
}

function populateRuns(names) {
  if (!runSelect) return;
  runSelect.innerHTML = '<option value="">Select a run…</option>' + names.map(n => `<option value="${n}">${n}</option>`).join('');
  if (runnerFilterSel) {
    const runners = new Set();
    names.forEach(n => {
      const base = n.replace(/^.*[\\\/]/, '');
      const m = base.match(/^([A-Za-z0-9_-]+)/);
      if (m) runners.add(m[1]);
    });
    const opts = ['<option value="">All</option>'].concat(Array.from(runners).sort().map(r => `<option value="${r}">${r}</option>`));
    runnerFilterSel.innerHTML = opts.join('');
  }
}

async function plotSelectedRun() {
  if (!runSelect || !runSelect.value) {
    logToConsole('Select a run first.');
    return;
  }
  liveMode = false; if (liveModeChk) liveModeChk.checked = false;
  stopHttpPolling(); // Stop live polling when viewing stored runs
  try {
    const name = runSelect.value;
    const resp = await fetch(`/api/runs/${encodeURIComponent(name)}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const text = await resp.text();
    const parsed = parseDelimited(text);
    currentRun = { name, ...parsed };
    populateFieldSelectors(parsed.fields);
    // Default axes: prefer time on X if exists
    const x = pickDefaultX(parsed.fields);
    const y = pickDefaultY(parsed.fields, x);
    setSelected(xFieldSel, x); setSelected(yFieldSel, y);
    plotRun(parsed.rows, x, y);
    renderCorrelation(parsed.rows, parsed.fields);
  } catch (e) {
    logToConsole(`Failed to load run: ${e}`);
  }
}

function setSelected(sel, val) {
  if (!sel) return;
  const opt = Array.from(sel.options).find(o => o.value === val);
  if (opt) sel.value = val;
}

function populateFieldSelectors(fields) {
  if (!xFieldSel || !yFieldSel) return;
  const opts = fields.map(f => `<option value="${f}">${f}</option>`).join('');
  xFieldSel.innerHTML = opts;
  yFieldSel.innerHTML = opts;
  if (y2FieldSel) y2FieldSel.innerHTML = '<option value="">—</option>' + opts;
  xFieldSel.onchange = () => replotCurrent();
  yFieldSel.onchange = () => replotCurrent();
  if (y2FieldSel) y2FieldSel.onchange = () => replotCurrent();
  if (dualAxisChk) dualAxisChk.onchange = () => replotCurrent();
}

function pickDefaultX(fields) {
  const lc = fields.map(f => f.toLowerCase());
  const idx = lc.findIndex(f => ['t','time','timestamp','seconds'].includes(f));
  return idx >= 0 ? fields[idx] : fields[0];
}

function pickDefaultY(fields, x) {
  const lc = fields.map(f => f.toLowerCase());
  const prefer = ['pressure','force','torque','cadence','speed'];
  for (const p of prefer) {
    const i = lc.findIndex(f => f === p);
    if (i >= 0 && fields[i] !== x) return fields[i];
  }
  return fields.find(f => f !== x) || fields[0];
}

function replotCurrent() {
  if (!currentRun) return;
  const x = xFieldSel ? xFieldSel.value : '';
  const y = yFieldSel ? yFieldSel.value : '';
  const y2 = y2FieldSel ? y2FieldSel.value : '';
  const dual = dualAxisChk ? !!dualAxisChk.checked : false;
  plotRun(currentRun.rows, x, y, y2, dual);
  renderCorrelation(currentRun.rows, currentRun.fields);
}

function plotRun(rows, xField, yField, y2Field = '', dualAxis = false) {
  if (!rows || !rows.length) return;
  // Note: This function is for analyzing stored CSV runs
  // For now, keep simple single-trace plotting on right chart
  // Can be enhanced later to split by sensor
  const rawX = []; const rawY = []; const rawY2 = [];
  for (const r of rows) {
    const xv = toNum(r[xField]);
    const yv = toNum(r[yField]);
    if (isFinite(xv) && isFinite(yv)) {
      rawX.push(xv);
      rawY.push(yv);
      if (y2Field) {
        const y2v = toNum(r[y2Field]);
        rawY2.push(isFinite(y2v) ? y2v : NaN);
      }
    }
  }
  const stride = Math.max(1, parseInt(downsampleStrideInp && downsampleStrideInp.value ? downsampleStrideInp.value : '1', 10));
  let { x, y } = decimate(rawX, rawY, stride);
  let y2 = [];
  if (y2Field) {
    y2 = decimate(rawX, rawY2, stride).y;
  }
  const mode = (smoothingSel && smoothingSel.value) ? smoothingSel.value : 'none';
  if (mode === 'ma') {
    y = movingAverage(y, nextLiveMAWindow());
    if (y2Field) y2 = movingAverage(y2, nextLiveMAWindow());
  } else if (mode === 'ewma') {
    y = ewma(y, nextLiveEWMAAlpha());
    if (y2Field) y2 = ewma(y2, nextLiveEWMAAlpha());
  }
  const shapes = buildThresholdShapes(x, yField);
  const traces = [{ x, y, mode: 'lines', line: { color: '#2196f3', width: 2 }, name: yField }];
  if (y2Field) traces.push({ x, y: y2, mode: 'lines', line: { color: '#ff9800', width: 2 }, name: y2Field, yaxis: dualAxis ? 'y2' : 'y' });
  const layout = { ...chartLayout, xaxis: { title: xField }, yaxis: { title: yField }, shapes };
  if (y2Field && dualAxis) {
    layout.yaxis2 = { title: y2Field, overlaying: 'y', side: 'right' };
  }
  // Plot CSV analysis on right chart only for now
  Plotly.react(chartDivRight, traces, layout, chartConfig);
  if (latestPressureEl) latestPressureEl.textContent = rows.length ? `${(y[y.length-1] != null ? y[y.length-1] : 0).toFixed(2)} ${yField && yField.toLowerCase().includes('pressure') ? 'N' : ''}` : '0';
  if (sampleCountEl) sampleCountEl.textContent = String(rows.length);
  // Stats for loaded run (use primary Y series)
  if (rows.length) {
    const validY = y.filter(v => isFinite(v));
    const mean = validY.length ? (validY.reduce((a,b)=>a+b,0) / validY.length) : 0;
    const max = validY.length ? Math.max(...validY) : 0;
    if (meanPressureEl) meanPressureEl.textContent = `${mean.toFixed(2)} ${yField && yField.toLowerCase().includes('pressure') ? 'N' : ''}`;
    if (maxPressureEl) maxPressureEl.textContent = `${max.toFixed(2)} ${yField && yField.toLowerCase().includes('pressure') ? 'N' : ''}`;
  }
  const xl = (xField || '').toLowerCase();
  if (xl.includes('time') || xl === 't' || xl === 'seconds') {
    const dur = (x[x.length-1] - x[0]);
    durationEl.textContent = `${(dur >= 1000 ? dur/1000 : dur).toFixed(1)}s`;
  }
}

// ---------- smoothing & downsampling helpers ----------
function movingAverage(arr, win) {
  win = Math.max(2, Math.min(win || 5, 200));
  if (arr.length < win) return arr.slice();
  const out = new Array(arr.length);
  let sum = 0;
  for (let i=0;i<arr.length;i++) {
    sum += arr[i];
    if (i>=win) sum -= arr[i-win];
    out[i] = (i>=win-1) ? sum / win : arr[i];
  }
  return out;
}

function ewma(arr, alpha) {
  alpha = Math.min(0.99, Math.max(0.01, alpha || 0.3));
  if (!arr.length) return arr;
  const out = new Array(arr.length);
  out[0] = arr[0];
  for (let i=1;i<arr.length;i++) out[i] = alpha*arr[i] + (1-alpha)*out[i-1];
  return out;
}

function decimate(x, y, stride) {
  if (stride<=1) return { x, y };
  const dx = []; const dy = [];
  for (let i=0;i<x.length;i+=stride) { dx.push(x[i]); dy.push(y[i]); }
  return { x: dx, y: dy };
}

// For live smoothing, keep closures per mode
let _maBuf = [];
function liveSmootherMA(win) {
  win = Math.max(2, Math.min(win || 5, 200));
  return (v) => {
    _maBuf.push(v); if (_maBuf.length>win) _maBuf.shift();
    const s = _maBuf.reduce((a,b)=>a+b,0);
    return s/_maBuf.length;
  };
}
let _ewmaPrev = null;
function liveSmootherEWMA(alpha) {
  alpha = Math.min(0.99, Math.max(0.01, alpha || 0.3));
  return (v) => {
    _ewmaPrev = (_ewmaPrev==null) ? v : alpha*v + (1-alpha)*_ewmaPrev;
    return _ewmaPrev;
  };
}

function nextLiveMAWindow() { return parseInt(maWindowInp && maWindowInp.value ? maWindowInp.value : '5', 10); }
function nextLiveEWMAAlpha() { return parseFloat(ewmaAlphaInp && ewmaAlphaInp.value ? ewmaAlphaInp.value : '0.3'); }

function renderCorrelation(rows, fields) {
  if (!corrDiv || !rows.length) return;
  const nums = fields.filter(f => rows.some(r => isFinite(toNum(r[f]))));
  const dataCols = nums.map(f => rows.map(r => toNum(r[f])).filter(v => isFinite(v)));
  const n = nums.length;
  const z = Array.from({ length: n }, () => Array(n).fill(1));
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      const corr = pearson(dataCols[i], dataCols[j]);
      z[i][j] = z[j][i] = corr;
    }
  }
  Plotly.react(corrDiv, [{ z, x: nums, y: nums, type: 'heatmap', colorscale: 'RdBu', zmin: -1, zmax: 1, reversescale: true }], { margin: { t: 10, r: 10, b: 80, l: 80 } }, chartConfig);
}

function pearson(a, b) {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let sumX=0, sumY=0, sumXY=0, sumXX=0, sumYY=0;
  for (let i=0;i<n;i++) {
    const x=a[i], y=b[i];
    sumX+=x; sumY+=y; sumXY+=x*y; sumXX+=x*x; sumYY+=y*y;
  }
  const num = n*sumXY - sumX*sumY;
  const den = Math.sqrt((n*sumXX - sumX*sumX)*(n*sumYY - sumY*sumY));
  return den ? (num/den) : 0;
}

function toNum(v) {
  const n = (typeof v === 'number') ? v : parseFloat(v);
  return isNaN(n) ? NaN : n;
}

function parseDelimited(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  const firstLine = lines[0] || '';
  const delim = firstLine.includes('\t') ? '\t' : ',';
  const headers = lines.shift().split(new RegExp(delim)).map(s => s.trim());
  const rows = lines.map(line => {
    const vals = line.split(new RegExp(delim));
    const obj = {};
    headers.forEach((h,i)=> obj[h]=vals[i]);
    return obj;
  });
  return { fields: headers, rows };
}

function buildThresholdShapes(x) {
  const shapes = [];
  const xmin = x.length ? x[0] : 0;
  const xmax = x.length ? x[x.length-1] : 1;
  const lower = parseFloat(lowerThInp && lowerThInp.value ? lowerThInp.value : 'NaN');
  const upper = parseFloat(upperThInp && upperThInp.value ? upperThInp.value : 'NaN');
  const showZones = !!(zonesToggle && zonesToggle.checked);
  if (isFinite(lower)) {
    shapes.push({ type: 'line', x0: xmin, x1: xmax, y0: lower, y1: lower, xref: 'x', yref: 'y', line: { color: 'orange', width: 1, dash: 'dot' } });
  }
  if (isFinite(upper)) {
    shapes.push({ type: 'line', x0: xmin, x1: xmax, y0: upper, y1: upper, xref: 'x', yref: 'y', line: { color: 'crimson', width: 1, dash: 'dot' } });
  }
  if (showZones && isFinite(lower) && isFinite(upper) && upper>lower) {
    shapes.push({ type: 'rect', x0: xmin, x1: xmax, y0: lower, y1: upper, xref: 'x', yref: 'y', fillcolor: 'rgba(76,175,80,0.12)', line: { width: 0 } });
  }
  return shapes;
}

// ---------- 3D (Three.js) ----------
function initThree() {
  if (!threeContainer || !window.THREE) return;
  const w = Math.max(1, threeContainer.clientWidth);
  const h = Math.max(1, threeContainer.clientHeight);
  threeScene = new THREE.Scene();
  threeCamera = new THREE.PerspectiveCamera(45, w/h, 0.1, 100);
  threeCamera.position.set(0, 1.2, 3);
  threeRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  threeRenderer.setPixelRatio(window.devicePixelRatio || 1);
  threeRenderer.setSize(w, h);
  threeContainer.innerHTML = '';
  threeContainer.appendChild(threeRenderer.domElement);
  // Lights
  const amb = new THREE.AmbientLight(0xffffff, 0.8);
  threeScene.add(amb);
  const dir = new THREE.DirectionalLight(0xffffff, 0.8);
  dir.position.set(3, 5, 2);
  threeScene.add(dir);
  // Add floor plane under bike wheels (grass/dirt texture)
  const floorGeometry = new THREE.PlaneGeometry(10, 10);
  
  // Create a simple procedural dirt/grass texture
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');
  
  // Base grass color (greener)
  ctx.fillStyle = '#2d5016';
  ctx.fillRect(0, 0, 512, 512);
  
  // Add grass patches (more and brighter)
  for (let i = 0; i < 8000; i++) {
    const x = Math.random() * 512;
    const y = Math.random() * 512;
    const green = Math.floor(80 + Math.random() * 100);
    ctx.fillStyle = `rgb(${green * 0.3}, ${green}, ${green * 0.4})`;
    ctx.fillRect(x, y, 2, Math.random() * 4);
  }
  
  // Add dirt variation (much less)
  for (let i = 0; i < 800; i++) {
    const x = Math.random() * 512;
    const y = Math.random() * 512;
    const brown = Math.floor(40 + Math.random() * 50);
    ctx.fillStyle = `rgba(${brown + 30}, ${brown}, ${brown * 0.5}, 0.3)`;
    ctx.fillRect(x, y, 2, 2);
  }
  
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(4, 4);
  
  const floorMaterial = new THREE.MeshStandardMaterial({ 
    map: texture,
    side: THREE.DoubleSide,
    roughness: 0.9,
    metalness: 0.1
  });
  const floor = new THREE.Mesh(floorGeometry, floorMaterial);
  floor.rotation.x = -Math.PI / 2; // Rotate to be horizontal
  floor.position.y = 0; // At ground level
  floor.receiveShadow = true;
  threeScene.add(floor);
  // Load default bike model
  tryLoadBikeModel('Santa_cruz.glb');
  // Resize handling
  window.addEventListener('resize', onThreeResize);
  // Mouse wheel zoom
  threeContainer.addEventListener('wheel', (e) => {
    e.preventDefault();
    const zoomSpeed = 0.1;
    const delta = e.deltaY > 0 ? 1 : -1;
    // Zoom along X axis (camera is on negative X axis)
    threeCamera.position.x += delta * zoomSpeed;
    // Limit zoom range
    const minX = -10;
    const maxX = -0.5;
    threeCamera.position.x = Math.max(minX, Math.min(maxX, threeCamera.position.x));
  }, { passive: false });
  // Animation loop
  const loop = () => {
    threeFrame = requestAnimationFrame(loop);
    if (bikeModel) applyModelOrientation();
    threeRenderer.render(threeScene, threeCamera);
  };
  loop();
}

function onThreeResize() {
  if (!threeRenderer || !threeCamera || !threeContainer) return;
  const w = Math.max(1, threeContainer.clientWidth);
  const h = Math.max(1, threeContainer.clientHeight);
  threeCamera.aspect = w/h;
  threeCamera.updateProjectionMatrix();
  threeRenderer.setSize(w, h);
}

function tryLoadBikeModel(modelFileName = 'Santa_cruz.glb') {
  // When running from file://, show a helpful message but don't block
  // The model will work fine when served from ESP32's HTTP server
  if (location.protocol === 'file:') {
    logToConsole('Running from file:// - 3D model loading disabled. When served from ESP32 HTTP server, models will load automatically.');
    if (threeContainer) {
      ensureThreeOverlay('3D model will load when served from ESP32 HTTP server. For local testing, click "Load 3D model" button to select a GLB file.');
    }
    return;
  }
  
  const loader = (window.THREE && THREE.GLTFLoader) ? new THREE.GLTFLoader() : (window.GLTFLoader ? new GLTFLoader() : null);
  if (!loader) { 
    logToConsole('GLTFLoader not found.'); 
    return; 
  }
  
  // Load GLB model from models/ folder (filename can be anything.glb)
  const modelPath = `models/${modelFileName}`;
  const displayName = modelFileName.replace('.glb', '').replace(/_/g, ' ');
  ensureThreeOverlay(`Loading ${displayName} model...`);
  logToConsole(`Loading 3D model: ${modelPath}`);
  
  loader.load(
    modelPath,
    (gltf) => {
      // Remove existing bike model if any
      if (bikePivot && threeScene) {
        threeScene.remove(bikePivot);
        bikePivot = null;
        bikeModel = null;
      }
      
      bikeModel = gltf.scene || (gltf.scenes && gltf.scenes[0]);
      if (!bikeModel) { 
        logToConsole('GLB has no scene'); 
        ensureThreeOverlay('Error: Model has no scene data');
        return; 
      }
      
      // Enable shadows for all meshes in the model and ensure materials work
      bikeModel.traverse((child) => {
        if (child.isMesh) {
          child.castShadow = true;
          child.receiveShadow = true;
          
          // Ensure materials render correctly with textures
          if (child.material) {
            child.material.needsUpdate = true;
          }
        }
      });
      
      // Center the model around origin and create a pivot we will rotate
      const box = new THREE.Box3().setFromObject(bikeModel);
      const center = box.getCenter(new THREE.Vector3());
      const pivot = new THREE.Group();
      bikeModel.position.sub(center);
      pivot.add(bikeModel);
      
      // Auto-scale to fit in view
      const size = box.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z);
      const scale = 2.0 / maxDim;
      pivot.scale.setScalar(scale);
      
      // Position pivot at origin
      // Default rotation is applied by applyModelOrientation() in the animation loop
      pivot.position.set(0, 0.5, 0);
      
      threeScene.add(pivot);
      bikePivot = pivot;
      frameObject(pivot);
      
      logToConsole(`3D model loaded: ${displayName}`);
      ensureThreeOverlay(`${displayName} loaded successfully`);
      setTimeout(() => {
        const overlay = threeContainer.querySelector('div');
        if (overlay) overlay.remove();
      }, 2000);
    },
    (xhr) => {
      // Progress callback
      if (xhr.lengthComputable) {
        const percent = Math.round((xhr.loaded / xhr.total) * 100);
        ensureThreeOverlay(`Loading ${displayName}: ${percent}%`);
      }
    },
    (error) => {
      logToConsole(`Failed to load ${modelPath}: ${error && error.message ? error.message : error}`);
      ensureThreeOverlay(`Failed to load ${displayName} model. Check console for details.`);
    }
  );
}

function ensureThreeOverlay(text) {
  // Remove any existing overlay
  const existing = threeContainer.querySelector('.three-overlay');
  if (existing) existing.remove();
  
  if (!text) return; // If empty text, just remove overlay
  
  const msg = document.createElement('div');
  msg.className = 'three-overlay';
  msg.style.cssText = 'position:absolute; inset:0; display:flex; align-items:center; justify-content:center; color:#888; text-align:center; padding:1rem; pointer-events:none;';
  msg.textContent = text;
  const prevPos = getComputedStyle(threeContainer).position;
  if (prevPos === 'static') threeContainer.style.position = 'relative';
  threeContainer.appendChild(msg);
}

function onLoadModelFileChange(evt) {
  const file = evt.target.files && evt.target.files[0];
  if (!file) return;
  
  const isGLTF = file.name.toLowerCase().endsWith('.gltf');
  const isGLB = file.name.toLowerCase().endsWith('.glb');
  
  if (!isGLTF && !isGLB) {
    logToConsole('Only GLTF/GLB files are supported');
    ensureThreeOverlay('Only GLTF/GLB files are supported');
    return;
  }
  
  ensureThreeOverlay(`Loading ${file.name}...`);
  
  const reader = new FileReader();
  reader.onload = () => {
    const arrayBuffer = reader.result;
    const loader = (window.THREE && THREE.GLTFLoader) ? new THREE.GLTFLoader() : (window.GLTFLoader ? new GLTFLoader() : null);
    if (!loader) { 
      logToConsole('GLTFLoader not found.'); 
      ensureThreeOverlay('GLTFLoader not available');
      return; 
    }
    
    // Clear previous model/pivot
    if (bikePivot && threeScene) { 
      threeScene.remove(bikePivot); 
      bikePivot = null; 
      bikeModel = null;
    }
    
    try {
      loader.parse(arrayBuffer, '', (gltf) => {
        bikeModel = gltf.scene || (gltf.scenes && gltf.scenes[0]);
        if (!bikeModel) { 
          logToConsole('Model has no scene'); 
          ensureThreeOverlay('Error: Model has no scene data');
          return; 
        }
        
        // Enable shadows and ensure materials work with textures
        bikeModel.traverse(obj => { 
          if (obj.isMesh) { 
            obj.castShadow = true; 
            obj.receiveShadow = true;
            if (obj.material) {
              obj.material.needsUpdate = true;
            }
          } 
        });
        
        const box = new THREE.Box3().setFromObject(bikeModel);
        const center = box.getCenter(new THREE.Vector3());
        const pivot = new THREE.Group();
        bikeModel.position.sub(center);
        pivot.add(bikeModel);
        
        // Auto-scale
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z);
        const scale = 2.0 / maxDim;
        pivot.scale.setScalar(scale);
        pivot.position.set(0, 0.5, 0);
        
        threeScene.add(pivot);
        bikePivot = pivot;
        frameObject(pivot);
        
        logToConsole(`Loaded local model: ${file.name}`);
        ensureThreeOverlay(`${file.name} loaded`);
        setTimeout(() => ensureThreeOverlay(''), 2000);
      }, (err) => {
        logToConsole(`Failed to parse model: ${err && err.message ? err.message : err}`);
        ensureThreeOverlay('Failed to parse model file');
      });
    } catch (e) {
      logToConsole(`Model parse error: ${e}`);
      ensureThreeOverlay('Error parsing model');
    } finally {
      fileLoadModel.value = '';
    }
  };
  reader.onerror = () => {
    logToConsole('Failed to read model file.');
    ensureThreeOverlay('Failed to read file');
  };
  reader.readAsArrayBuffer(file);
}

function onLoadHandlebarFileChange(evt) {
  const file = evt.target.files && evt.target.files[0];
  if (!file) return;
  
  const isGLTF = file.name.toLowerCase().endsWith('.gltf');
  const isGLB = file.name.toLowerCase().endsWith('.glb');
  
  if (!isGLTF && !isGLB) {
    logToConsole('Only GLTF/GLB files are supported for handlebar');
    return;
  }
  
  logToConsole(`Loading handlebar: ${file.name}...`);
  
  const reader = new FileReader();
  reader.onload = () => {
    const arrayBuffer = reader.result;
    const loader = (window.THREE && THREE.GLTFLoader) ? new THREE.GLTFLoader() : (window.GLTFLoader ? new GLTFLoader() : null);
    if (!loader) { 
      logToConsole('GLTFLoader not found.'); 
      return; 
    }
    
    try {
      loader.parse(arrayBuffer, '', (gltf) => {
        const model = gltf.scene || (gltf.scenes && gltf.scenes[0]);
        if (!model) { 
          logToConsole('Handlebar model has no scene'); 
          return; 
        }
        
        // Normalize model scale to standard size
        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z);
        const targetSize = 2.0; // Standard target size
        const scale = targetSize / maxDim;
        model.scale.multiplyScalar(scale);
        
        // Remove previous handlebar model
        if (handlebarModel && handlebarScene) {
          handlebarScene.remove(handlebarModel);
        }
        
        handlebarModel = model;
        handlebarScene.add(handlebarModel);
        
        // Frame the handlebar in view (resets zoom)
        frameHandlebar(handlebarModel);
        
        // Initialize heatmap
        updateHandlebarHeatmap();
        
        logToConsole(`Loaded handlebar model: ${file.name}`);
      }, (err) => {
        logToConsole(`Failed to parse handlebar model: ${err && err.message ? err.message : err}`);
      });
    } catch (e) {
      logToConsole(`Handlebar model parse error: ${e}`);
    } finally {
      fileLoadHandlebar.value = '';
    }
  };
  reader.onerror = () => {
    logToConsole('Failed to read handlebar model file.');
  };
  reader.readAsArrayBuffer(file);
}

function handleOrientation(yawDeg, pitchDeg, rollDeg) {
  if (yawDeg != null && isFinite(yawDeg)) oriYaw = toRad(yawDeg);
  if (pitchDeg != null && isFinite(pitchDeg)) oriPitch = toRad(pitchDeg);
  if (rollDeg != null && isFinite(rollDeg)) oriRoll = toRad(rollDeg);
}

function toRad(v) {
  const av = Math.abs(v);
  return (av <= 6.5) ? v : (v * Math.PI / 180);
}

function applyModelOrientation() {
  const target = bikePivot || bikeModel;
  if (!target) return;
  // Apply sensor orientation data directly (no offsets)
  // Pitch = rotation around X (front/back tilt)
  // Yaw = rotation around Y (left/right turn)
  // Roll = rotation around Z (lean left/right)
  target.rotation.set(
    oriPitch, 
    oriYaw, 
    oriRoll, 
    'XYZ'
  );
}

function frameObject(object3D) {
  if (!threeCamera) return;
  const box = new THREE.Box3().setFromObject(object3D);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  const fov = threeCamera.fov * (Math.PI / 180);
  const fitDist = (maxDim/2) / Math.tan(fov/2);
  // Place camera to the side of the bike (-90° angle on X axis) to view it from the left side
  // Position on negative X axis, slightly above center, closer to model
  threeCamera.position.set(center.x - fitDist * 0.7, center.y + maxDim*0.1, center.z);
  threeCamera.near = Math.max(0.01, fitDist/100);
  threeCamera.far = fitDist * 100;
  threeCamera.updateProjectionMatrix();
  threeCamera.lookAt(center);
}

// ---------- Handlebar 3D with Heatmap ----------
let handlebarScene, handlebarCamera, handlebarRenderer, handlebarFrame;
let handlebarModel;
const sensorPressures = [0, 0, 0, 0, 0, 0, 0, 0]; // 8 sensors
let handlebarRotation = { x: 0, y: 0 };
let handlebarZoom = 2;
let handlebarCenter = new THREE.Vector3(0, 0, 0);
let handlebarMouseDown = false;
let handlebarLastMouse = { x: 0, y: 0 };

function initHandlebar() {
  const container = document.getElementById('handlebar_container');
  if (!container) return;
  
  // Scene setup
  handlebarScene = new THREE.Scene();
  // Set background based on current theme
  const isDark = document.body.classList.contains('dark-theme-variables');
  handlebarScene.background = new THREE.Color(isDark ? 0x1a1a1a : 0xf0f0f0);
  
  // Camera
  const w = Math.max(1, container.clientWidth);
  const h = Math.max(1, container.clientHeight);
  handlebarCamera = new THREE.PerspectiveCamera(50, w / h, 0.01, 1000);
  handlebarCamera.position.set(0, 0.5, 1.2);
  handlebarCamera.lookAt(0, 0, 0);
  
  // Renderer
  handlebarRenderer = new THREE.WebGLRenderer({ antialias: true });
  handlebarRenderer.setSize(w, h);
  container.appendChild(handlebarRenderer.domElement);
  
  // Lights
  const amb = new THREE.AmbientLight(0xffffff, 0.6);
  handlebarScene.add(amb);
  const dir = new THREE.DirectionalLight(0xffffff, 0.8);
  dir.position.set(2, 3, 1);
  handlebarScene.add(dir);
  
  // Load handlebar GLB model
  loadHandlebarModel('HandleBar.glb');
  
  // Mouse controls for rotation and zoom
  container.addEventListener('mousedown', (e) => {
    handlebarMouseDown = true;
    handlebarLastMouse.x = e.clientX;
    handlebarLastMouse.y = e.clientY;
  });
  
  container.addEventListener('mouseup', () => {
    handlebarMouseDown = false;
  });
  
  container.addEventListener('mouseleave', () => {
    handlebarMouseDown = false;
  });
  
  container.addEventListener('mousemove', (e) => {
    if (!handlebarMouseDown) return;
    
    const deltaX = e.clientX - handlebarLastMouse.x;
    const deltaY = e.clientY - handlebarLastMouse.y;
    
    // Allow both yaw (horizontal drag) and pitch (vertical drag)
    handlebarRotation.y += deltaX * 0.01; // yaw
    handlebarRotation.x += deltaY * 0.01; // pitch
    
    handlebarLastMouse.x = e.clientX;
    handlebarLastMouse.y = e.clientY;
    
    updateHandlebarCamera();
  });
  
  container.addEventListener('wheel', (e) => {
    e.preventDefault();
    // Use percentage-based zoom for better scaling across different model sizes
    const zoomFactor = e.deltaY > 0 ? 1.02 : 0.98;
    handlebarZoom *= zoomFactor;
    handlebarZoom = Math.max(0.5, Math.min(50, handlebarZoom));
    updateHandlebarCamera();
  }, { passive: false });
  
  // Resize handling
  window.addEventListener('resize', onHandlebarResize);
  
  // Animation loop
  const loop = () => {
    handlebarFrame = requestAnimationFrame(loop);
    handlebarRenderer.render(handlebarScene, handlebarCamera);
  };
  loop();
}

function onHandlebarResize() {
  if (!handlebarRenderer || !handlebarCamera) return;
  const container = document.getElementById('handlebar_container');
  if (!container) return;
  const w = Math.max(1, container.clientWidth);
  const h = Math.max(1, container.clientHeight);
  handlebarCamera.aspect = w / h;
  handlebarCamera.updateProjectionMatrix();
  handlebarRenderer.setSize(w, h);
}

function updateHandlebarCamera() {
  if (!handlebarCamera) return;
  
  // Calculate camera position based on rotation and zoom
  const radius = handlebarZoom;
  const x = radius * Math.sin(handlebarRotation.y) * Math.cos(handlebarRotation.x);
  const y = radius * Math.sin(handlebarRotation.x);
  const z = radius * Math.cos(handlebarRotation.y) * Math.cos(handlebarRotation.x);
  
  handlebarCamera.position.set(
    handlebarCenter.x + x, 
    handlebarCenter.y + y, 
    handlebarCenter.z + z
  );
  handlebarCamera.lookAt(handlebarCenter);
}

function loadHandlebarModel(modelFileName) {
  // When running from file://, show a helpful message but don't block
  if (location.protocol === 'file:') {
    logToConsole('Running from file:// - handlebar 3D model loading disabled. Will work when served from ESP32 HTTP server.');
    // Create a simple fallback cylinder for local testing
    createFallbackHandlebar();
    return;
  }
  
  const loader = (window.THREE && THREE.GLTFLoader) ? new THREE.GLTFLoader() : (window.GLTFLoader ? new GLTFLoader() : null);
  if (!loader) {
    logToConsole('GLTFLoader not found for handlebar.');
    createFallbackHandlebar();
    return;
  }
  
  const modelPath = `models/${modelFileName}`;
  loader.load(modelPath, (gltf) => {
    if (handlebarModel) handlebarScene.remove(handlebarModel);
    handlebarModel = gltf.scene;
    handlebarScene.add(handlebarModel);
    
    // Frame the handlebar in the view
    frameHandlebar(handlebarModel);
    
    // Initialize vertex colors for heatmap
    updateHandlebarHeatmap();
    
    logToConsole(`Loaded handlebar model: ${modelFileName}`);
  }, undefined, (err) => {
    logToConsole(`Failed to load handlebar model: ${err}`);
    createFallbackHandlebar();
  });
}

function createFallbackHandlebar() {
  // Create a simple cylinder as fallback when GLB can't be loaded
  const geometry = new THREE.CylinderGeometry(0.15, 0.15, 2, 32, 8, false);
  const material = new THREE.MeshStandardMaterial({ 
    color: 0x808080,
    vertexColors: true 
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.rotation.z = Math.PI / 2; // Horizontal
  
  if (handlebarModel) handlebarScene.remove(handlebarModel);
  handlebarModel = mesh;
  handlebarScene.add(handlebarModel);
  
  // Initialize vertex colors for heatmap
  updateHandlebarHeatmap();
  
  logToConsole('Using fallback cylinder handlebar for testing');
}

function frameHandlebar(object3D) {
  if (!handlebarCamera) return;
  const box = new THREE.Box3().setFromObject(object3D);
  const size = box.getSize(new THREE.Vector3());
  handlebarCenter = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  const fov = handlebarCamera.fov * (Math.PI / 180);
  const fitDist = (maxDim / 2) / Math.tan(fov / 2);
  
  // Set initial zoom and rotation based on model size
  handlebarZoom = fitDist * 0.4;
  handlebarRotation.x = 0.5; // Slight tilt down
  handlebarRotation.y = 3.1415; // Front view
  
  handlebarCamera.near = Math.max(0.01, fitDist / 100);
  handlebarCamera.far = fitDist * 100;
  handlebarCamera.updateProjectionMatrix();
  
  updateHandlebarCamera();
}

function updateHandlebarHeatmap() {
  if (!handlebarModel) return;
  
  // Get max pressure for normalization
  const maxPressure = Math.max(...sensorPressures, 1);
  
  // Find the specific grip meshes by name
  let rightGrip = null;
  let leftGrip = null;
  
  handlebarModel.traverse((child) => {
    if (child.isMesh && child.geometry) {
      const name = (child.name || '').toLowerCase();
      if (name === 'empty_3') {
        rightGrip = child;
      } else if (name === 'empty_4') {
        leftGrip = child;
      }
    }
  });
  
  if (!rightGrip && !leftGrip) {
    console.warn('Could not find grip meshes (empty_3 or empty_4)');
    return;
  }
  
  // Helper function to apply heatmap to a grip
  const applyHeatmapToGrip = (grip, isRight) => {
    if (!grip || !grip.geometry) return;
    
    const geometry = grip.geometry;
    const position = geometry.attributes.position;
    
    if (!position) return;
    
    const colors = new Float32Array(position.count * 3);
    
    // Get bounding box to map sensor positions
    const bbox = new THREE.Box3().setFromBufferAttribute(position);
    const bboxSize = bbox.getSize(new THREE.Vector3());
    const bboxCenter = bbox.getCenter(new THREE.Vector3());
    
    // Define the 4 zones: each sensor gets 25% of the grip height
    // Zone boundaries at 0-25%, 25-50%, 50-75%, 75-100%
    const zoneBoundaries = [0, 0.25, 0.5, 0.75, 1.0];
    
    // Map sensors to positions on the grip
    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i);
      const y = position.getY(i);
      const z = position.getZ(i);
      
      // Normalize Y position (0 to 1) for grip height
      const yNorm = (y - bbox.min.y) / (bbox.max.y - bbox.min.y || 1);
      
      // Determine which of the 4 zones this vertex belongs to
      let zoneIndex = 0;
      if (yNorm >= zoneBoundaries[3]) zoneIndex = 0; // Top zone (sensor 1 or 5)
      else if (yNorm >= zoneBoundaries[2]) zoneIndex = 1; // Upper-middle (sensor 2 or 6)
      else if (yNorm >= zoneBoundaries[1]) zoneIndex = 2; // Lower-middle (sensor 3 or 7)
      else zoneIndex = 3; // Bottom zone (sensor 4 or 8)
      
      let pressure = 0;
      
      if (isRight) {
        // Right grip: sensors 1-4 (top to bottom)
        pressure = sensorPressures[zoneIndex];
      } else {
        // Left grip: sensors 5-8 (top to bottom)
        pressure = sensorPressures[4 + zoneIndex];
      }
      
      // Normalize pressure (0-1)
      const normalized = Math.min(pressure / maxPressure, 1);
      
      // Color gradient: blue (low) -> green -> yellow -> red (high)
      let r, g, b;
      if (normalized < 0.33) {
        // Blue to green
        const t = normalized / 0.33;
        r = 0;
        g = t;
        b = 1 - t;
      } else if (normalized < 0.66) {
        // Green to yellow
        const t = (normalized - 0.33) / 0.33;
        r = t;
        g = 1;
        b = 0;
      } else {
        // Yellow to red
        const t = (normalized - 0.66) / 0.34;
        r = 1;
        g = 1 - t;
        b = 0;
      }
      
      colors[i * 3] = r;
      colors[i * 3 + 1] = g;
      colors[i * 3 + 2] = b;
    }
    
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.attributes.color.needsUpdate = true;
    
    // Enable vertex colors on material and ensure it's visible
    if (grip.material) {
      if (Array.isArray(grip.material)) {
        grip.material.forEach(mat => {
          mat.vertexColors = true;
          mat.color && mat.color.set(0xffffff);
          if (mat.map) mat.map = null;
          mat.needsUpdate = true;
        });
      } else {
        grip.material.vertexColors = true;
        grip.material.color && grip.material.color.set(0xffffff);
        if (grip.material.map) grip.material.map = null;
        grip.material.needsUpdate = true;
      }
    }
  };
  
  // Apply heatmap to both grips
  if (rightGrip) applyHeatmapToGrip(rightGrip, true);
  if (leftGrip) applyHeatmapToGrip(leftGrip, false);
}

// ---------- i18n ----------
const I18N = {
  en: {
    websocket_label: 'WebSocket:',
    wsDisconnected: 'Disconnected',
    live_mode: 'Live Mode',
    refresh_runs: 'Refresh Runs',
    select_run_placeholder: 'Select a run…',
    plot_run: 'Plot Run',
    x_axis_label: 'X:',
    y_axis_label: 'Y:',
    y2_axis_label: 'Y2:',
    dual_axis: 'Dual axis',
    smoothing: 'Smoothing',
    smoothing_none: 'None',
    smoothing_ma: 'Moving Avg',
    smoothing_ewma: 'EWMA',
    ma_window: 'Window',
    ewma_alpha: 'Alpha',
    downsample: 'Downsample',
    max_points: 'Max points',
    lower_threshold: 'Lower',
    upper_threshold: 'Upper',
    show_zones: 'Show zones',
    pressure_over_time: 'Handle Pressure over Time',
    correlation_matrix: 'Correlation Matrix',
    console: 'Console',
    import_run: 'Import run (CSV/TSV)',
    x_axis_time: 'Time [s]',
    y_axis_voltage: 'Voltage [V]',
    right_handle: 'Right Handle (Sensors 1-4)',
    left_handle: 'Left Handle (Sensors 5-8)',
    // New
    layout: 'Layout',
    layout_live: 'Live',
    layout_analysis: 'Analysis',
    layout_files: 'Files',
    layout_rider: 'Rider',
    layout_coach: 'Coach',
    runner: 'Runner',
    runner_all: 'All',
    rename_to: 'Rename to',
    rename: 'Rename',
    latest_pressure_title: 'Latest Pressure',
    samples_title: 'Samples',
    duration_title: 'Duration',
    simulation_off: 'Simulation: OFF',
    clear_chart: 'Clear chart',
    clear_console: 'Clear console',
    filters: 'Filters',
    apply: 'Apply',
    bike_3d: '3D Bike',
    select_model: 'Model:',
    load_model: 'Load 3D model',
    load_handlebar: 'Load Handlebar Model',
    fit_view: 'Fit view',
    handlebar_pressure: 'Handlebar Pressure Heatmap',
    // Customize modal
    customize: 'Customize',
    widget_kpi: 'KPI',
    widget_3d: '3D',
    widget_pressure: 'Pressure',
    widget_corr: 'Correlation',
    size_s: 'Small',
    size_m: 'Medium',
    size_l: 'Large',
    // Profile modal
    profile_settings: 'Profile / Settings',
    profile_title: 'Profile & Sorting',
    active_profile: 'Active profile',
    set_active: 'Set Active',
    new_runner_placeholder: 'New runner name',
    create_runner: 'Create',
    unsorted_runs: 'Unsorted runs',
    profile_runs: 'Profile runs',
    move_to_profile: '→ Move to profile',
    rename_placeholder: 'New name',
    rename_run: 'Rename',
    delete_run: 'Delete',
    download_all: 'Download All CSV',
  },
  fr: {
    websocket_label: 'WebSocket :',
    wsDisconnected: 'Déconnecté',
    live_mode: 'Mode Live',
    refresh_runs: 'Rafraîchir',
    select_run_placeholder: 'Choisir une session…',
    plot_run: 'Tracer',
    x_axis_label: 'X :',
    y_axis_label: 'Y :',
    y2_axis_label: 'Y2 :',
    dual_axis: 'Double axe',
    smoothing: 'Lissage',
    smoothing_none: 'Aucun',
    smoothing_ma: 'Moy. mobile',
    smoothing_ewma: 'EWMA',
    ma_window: 'Fenêtre',
    ewma_alpha: 'Alpha',
    downsample: 'Décimation',
    max_points: 'Points max',
    lower_threshold: 'Bas',
    upper_threshold: 'Haut',
    show_zones: 'Zones',
    pressure_over_time: 'Pression de guidon dans le temps',
    correlation_matrix: 'Matrice de corrélation',
    console: 'Console',
    import_run: 'Importer un run (CSV/TSV)',
    x_axis_time: 'Temps [s]',
    y_axis_voltage: 'Tension [V]',
    right_handle: 'Guidon Droit (Capteurs 1-4)',
    left_handle: 'Guidon Gauche (Capteurs 5-8)',
    layout: 'Disposition',
    layout_live: 'Live',
    layout_analysis: 'Analyse',
    layout_files: 'Fichiers',
    layout_rider: 'Coureur',
    layout_coach: 'Coach',
    runner: 'Coureur',
    runner_all: 'Tous',
    rename_to: 'Renommer en',
    rename: 'Renommer',
    latest_pressure_title: 'Dernière pression',
    samples_title: 'Échantillons',
    duration_title: 'Durée',
    simulation_off: 'Simulation : OFF',
    clear_chart: 'Effacer le graphe',
    clear_console: 'Effacer la console',
    filters: 'Filtres',
    apply: 'Appliquer',
    bike_3d: 'Vélo 3D',
    select_model: 'Modèle :',
    load_model: 'Charger un modèle 3D',
    load_handlebar: 'Charger un modèle de guidon',
    fit_view: 'Ajuster la vue',
    handlebar_pressure: 'Carte de chaleur - Pression guidon',
    // Customize modal
    customize: 'Personnaliser',
    widget_kpi: 'Indicateurs',
    widget_3d: '3D',
    widget_pressure: 'Pression',
    widget_corr: 'Corrélation',
    size_s: 'Petit',
    size_m: 'Moyen',
    size_l: 'Grand',
    // Profile modal
    profile_settings: 'Profil / Paramètres',
    profile_title: 'Profil & Tri',
    active_profile: 'Profil actif',
    set_active: 'Définir actif',
    new_runner_placeholder: 'Nom du nouveau coureur',
    create_runner: 'Créer',
    unsorted_runs: 'Runs non triés',
    profile_runs: 'Runs du profil',
    move_to_profile: '→ Déplacer vers le profil',
    rename_placeholder: 'Nouveau nom',
    rename_run: 'Renommer',
    delete_run: 'Supprimer',
    download_all: 'Télécharger tous les CSV',
  },
  de: {
    websocket_label: 'WebSocket:',
    wsDisconnected: 'Getrennt',
    live_mode: 'Live-Modus',
    refresh_runs: 'Aktualisieren',
    select_run_placeholder: 'Lauf auswählen…',
    plot_run: 'Plotten',
    x_axis_label: 'X:',
    y_axis_label: 'Y:',
    y2_axis_label: 'Y2:',
    dual_axis: 'Duale Achse',
    smoothing: 'Glättung',
    smoothing_none: 'Keine',
    smoothing_ma: 'Gleitender Mittelwert',
    smoothing_ewma: 'EWMA',
    ma_window: 'Fenster',
    ewma_alpha: 'Alpha',
    downsample: 'Downsample',
    max_points: 'Max Punkte',
    lower_threshold: 'Unter',
    upper_threshold: 'Ober',
    show_zones: 'Zonen',
    pressure_over_time: 'Lenkerdruck über die Zeit',
    correlation_matrix: 'Korrelationsmatrix',
    console: 'Konsole',
    import_run: 'Lauf importieren (CSV/TSV)',
    x_axis_time: 'Zeit [s]',
    y_axis_voltage: 'Spannung [V]',
    right_handle: 'Rechter Lenker (Sensoren 1-4)',
    left_handle: 'Linker Lenker (Sensoren 5-8)',
    layout: 'Layout',
    layout_live: 'Live',
    layout_analysis: 'Analyse',
    layout_files: 'Dateien',
    layout_rider: 'Fahrer',
    layout_coach: 'Trainer',
    runner: 'Fahrer',
    runner_all: 'Alle',
    rename_to: 'Umbenennen in',
    rename: 'Umbenennen',
    latest_pressure_title: 'Letzter Druck',
    samples_title: 'Stichproben',
    duration_title: 'Dauer',
    simulation_off: 'Simulation: AUS',
    clear_chart: 'Diagramm leeren',
    clear_console: 'Konsole leeren',
    filters: 'Filter',
    apply: 'Übernehmen',
    bike_3d: '3D-Fahrrad',
    select_model: 'Modell:',
    load_model: '3D‑Modell laden',
    load_handlebar: 'Lenkermodell laden',
    fit_view: 'Ansicht einpassen',
    handlebar_pressure: 'Lenker-Druck-Heatmap',
    // Customize modal
    customize: 'Anpassen',
    widget_kpi: 'KPI',
    widget_3d: '3D',
    widget_pressure: 'Druck',
    widget_corr: 'Korrelation',
    size_s: 'Klein',
    size_m: 'Mittel',
    size_l: 'Groß',
    // Profile modal
    profile_settings: 'Profil / Einstellungen',
    profile_title: 'Profil & Sortierung',
    active_profile: 'Aktives Profil',
    set_active: 'Aktivieren',
    new_runner_placeholder: 'Neuer Fahrername',
    create_runner: 'Erstellen',
    unsorted_runs: 'Unsortierte Läufe',
    profile_runs: 'Profil-Läufe',
    move_to_profile: '→ Zum Profil verschieben',
    rename_placeholder: 'Neuer Name',
    rename_run: 'Umbenennen',
    delete_run: 'Löschen',
    download_all: 'Alle CSV herunterladen',
  }
};

function setLanguage(lang) {
  if (!I18N[lang]) lang = 'en';
  localStorage.setItem('lang', lang);
  applyTranslations(lang);
  langButtons.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.lang === lang);
  });
}

function loadLangPref() {
  return localStorage.getItem('lang') || (navigator.language || 'en').substring(0,2);
}

function applyTranslations(lang) {
  const dict = I18N[lang] || I18N.en;
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    if (dict[key]) {
      if (el.tagName === 'OPTION') {
        el.textContent = dict[key];
      } else {
        el.textContent = dict[key];
      }
    }
  });
  
  // Handle placeholder translations
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = el.getAttribute('data-i18n-placeholder');
    if (dict[key]) {
      el.placeholder = dict[key];
    }
  });
  
  // Update Plotly axis labels
  const xAxisLabel = dict.x_axis_time || 'Time [s]';
  const yAxisLabel = dict.y_axis_voltage || 'Voltage [V]';
  
  Plotly.relayout(chartDivRight, {
    'xaxis.title': xAxisLabel,
    'yaxis.title': yAxisLabel
  });
  Plotly.relayout(chartDivLeft, {
    'xaxis.title': xAxisLabel,
    'yaxis.title': yAxisLabel
  });
}

function filterRunsByRunner() {
  if (!runnerFilterSel) return;
  const runner = runnerFilterSel.value.trim();
  fetch('/api/runs')
    .then(r => r.json())
    .then(data => {
      const names = Array.isArray(data) ? data : [];
      const filtered = runner ? names.filter(n => n.toLowerCase().startsWith(runner.toLowerCase())) : names;
      populateRuns(filtered);
    })
    .catch(e => logToConsole(`Filter failed: ${e}`));
}

async function renameSelectedRun() {
  if (!runSelect || !runSelect.value || !renameInput || !renameInput.value) {
    logToConsole('Select a run and enter a new name.');
    return;
  }
  const oldName = runSelect.value;
  const newName = renameInput.value.trim();
  try {
    const resp = await fetch('/runs/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: oldName, to: newName })
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    logToConsole(`Renamed ${oldName} -> ${newName}`);
    await listRuns();
    setSelected(runSelect, newName);
  } catch (e) {
    logToConsole(`Rename failed: ${e}`);
  }
}

function applyLayout(mode) {
  const show = (el, v) => { if (!el) return; el.style.display = v ? '' : 'none'; };
  switch ((mode || 'live').toLowerCase()) {
    case 'live':
      show(rowLive, true); show(rowRunner, false); show(rowAxes, true); show(rowSmoothing, true); show(rowThresholds, true);
      show(kpiGrid, true); show(threeCard, true); show(pressureCardRight, true); show(pressureCardLeft, true); show(corrCard, false);
      break;
    case 'analysis':
      show(rowLive, false); show(rowRunner, true); show(rowAxes, true); show(rowSmoothing, true); show(rowThresholds, true);
      show(kpiGrid, true); show(threeCard, false); show(pressureCardRight, true); show(pressureCardLeft, false); show(corrCard, true);
      break;
    case 'files':
      show(rowLive, false); show(rowRunner, true); show(rowAxes, false); show(rowSmoothing, false); show(rowThresholds, false);
      show(kpiGrid, false); show(threeCard, false); show(pressureCardRight, false); show(pressureCardLeft, false); show(corrCard, false);
      break;
    case 'rider':
      show(rowLive, false); show(rowRunner, true); show(rowAxes, true); show(rowSmoothing, true); show(rowThresholds, false);
      show(kpiGrid, true); show(threeCard, true); show(pressureCardRight, true); show(pressureCardLeft, true); show(corrCard, false);
      break;
    case 'coach':
      show(rowLive, false); show(rowRunner, true); show(rowAxes, true); show(rowSmoothing, true); show(rowThresholds, true);
      show(kpiGrid, true); show(threeCard, false); show(pressureCardRight, true); show(pressureCardLeft, true); show(corrCard, true);
      break;
    default:
      show(rowLive, true); show(rowRunner, true); show(rowAxes, true); show(rowSmoothing, true); show(rowThresholds, true);
      show(kpiGrid, true); show(threeCard, true); show(pressureCardRight, true); show(pressureCardLeft, true); show(corrCard, true);
  }
}

function setActiveNav(mode) {
  navLinks.forEach(link => link.classList.toggle('active', link.dataset.layout === mode));
}

// Show dialog to select a run file from SD card
function showRunSelectionDialog(runs) {
  return new Promise((resolve) => {
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:9999;';
    
    const dialog = document.createElement('div');
    dialog.style.cssText = 'background:var(--color-background,white);padding:2rem;border-radius:8px;max-width:400px;width:90%;max-height:80vh;overflow-y:auto;';
    
    const title = document.createElement('h3');
    title.textContent = 'Select Run from SD Card';
    title.style.marginTop = '0';
    dialog.appendChild(title);
    
    const list = document.createElement('div');
    list.style.cssText = 'margin:1rem 0;';
    
    runs.forEach(runFile => {
      const btn = document.createElement('button');
      btn.textContent = runFile;
      btn.className = 'btn';
      btn.style.cssText = 'display:block;width:100%;margin:0.5rem 0;padding:0.75rem;text-align:left;';
      btn.onclick = () => {
        document.body.removeChild(modal);
        resolve(runFile);
      };
      list.appendChild(btn);
    });
    
    dialog.appendChild(list);
    
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.className = 'btn';
    cancelBtn.style.cssText = 'width:100%;';
    cancelBtn.onclick = () => {
      document.body.removeChild(modal);
      resolve(null);
    };
    dialog.appendChild(cancelBtn);
    
    modal.appendChild(dialog);
    document.body.appendChild(modal);
  });
}

// Load and plot CSV from SD card
async function loadAndPlotCSV(filename) {
  try {
    const resp = await fetch(`/api/runs/${encodeURIComponent(filename)}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const csvText = await resp.text();
    
    // Parse CSV
    const lines = csvText.trim().split('\n');
    if (lines.length < 2) throw new Error('CSV file is empty');
    
    const header = lines[0].split(',');
    // Expected: run,time_run_ms,capteur,value_V
    
    // Group data by sensor (capteur)
    const sensorData = {};
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(',');
      if (parts.length < 4) continue;
      
      const timeMs = parseFloat(parts[1]);
      const sensor = parseInt(parts[2]);
      const voltage = parseFloat(parts[3]);
      
      if (!sensorData[sensor]) {
        sensorData[sensor] = { x: [], y: [] };
      }
      sensorData[sensor].x.push(timeMs / 1000); // Convert to seconds
      sensorData[sensor].y.push(voltage);
    }
    
    // Stop live mode and clear charts
    isPlottingCSV = true;
    liveMode = false;
    if (liveModeChk) liveModeChk.checked = false;
    stopHttpPolling();
    
    // Build traces for right handle (sensors 1-4)
    const tracesRight = [];
    for (let i = 1; i <= 4; i++) {
      const data = sensorData[i] || { x: [], y: [] };
      tracesRight.push({
        x: data.x,
        y: data.y,
        mode: 'lines',
        line: { color: colors[i-1], width: 2 },
        name: `Sensor ${i}`
      });
    }
    
    // Build traces for left handle (sensors 5-8)
    const tracesLeft = [];
    for (let i = 5; i <= 8; i++) {
      const data = sensorData[i] || { x: [], y: [] };
      tracesLeft.push({
        x: data.x,
        y: data.y,
        mode: 'lines',
        line: { color: colors[i-5], width: 2 },
        name: `Sensor ${i}`
      });
    }
    
    // Plot with auto-range (no 30-second limit for CSV)
    const layoutCSV = {
      title: '',
      xaxis: { title: 'Time (s)', autorange: true },
      yaxis: { title: 'Voltage (V)' },
      margin: { t: 10, r: 10, b: 40, l: 50 },
      showlegend: true,
      legend: { x: 0, y: 1, orientation: 'h' }
    };
    
    Plotly.react(chartDivRight, tracesRight, layoutCSV, chartConfig);
    Plotly.react(chartDivLeft, tracesLeft, layoutCSV, chartConfig);
    
    logToConsole(`Loaded ${filename} with ${lines.length - 1} samples`);
    
    // Update KPIs
    if (lines.length > 1) {
      const maxTime = Math.max(...Object.values(sensorData).flatMap(d => d.x));
      durationEl.textContent = `${maxTime.toFixed(1)}s`;
      sampleCountEl.textContent = `${lines.length - 1}`;
    }
  } catch (e) {
    alert('Failed to load CSV: ' + e.message);
    logToConsole(`CSV load error: ${e}`);
  }
}

function onImportFileChange(evt) {
  const file = evt.target.files && evt.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const text = reader.result;
      const parsed = parseDelimited(text);
      currentRun = { name: file.name, ...parsed };
      populateFieldSelectors(parsed.fields);
      const x = pickDefaultX(parsed.fields);
      const y = pickDefaultY(parsed.fields, x);
      setSelected(xFieldSel, x); setSelected(yFieldSel, y);
      plotRun(parsed.rows, x, y);
      renderCorrelation(parsed.rows, parsed.fields);
      liveMode = false; if (liveModeChk) liveModeChk.checked = false;
      applyLayout('analysis'); setActiveNav('analysis');
      logToConsole(`Imported ${file.name} (${parsed.rows.length} rows)`);
    } catch (e) {
      logToConsole(`Import failed: ${e}`);
    } finally {
      fileImport.value = '';
    }
  };
  reader.onerror = () => logToConsole('Failed to read file.');
  reader.readAsText(file);
}