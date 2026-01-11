// Smart Bike Dashboard JS

// State
let t0 = null;
let sampleCount = 0;
let liveMode = true;
let currentRun = null; // { name, rows, fields }
let pollingTimer = null;  // For HTTP polling
const LIVE_WINDOW_SECONDS = 60;  // 60-second rolling window for live data
let isPlottingCSV = false;  // Track if we're plotting CSV data vs live data
let runActive = false; // Track if device is currently recording
let currentLang = 'en'; // Active language key

// UI refs
const themeToggler = document.querySelector(".theme-toggler");
const latestPressureEl = document.getElementById("latest_pressure");
const sampleCountEl = document.getElementById("sample_count");
const durationEl = document.getElementById("duration");
const chartDivRight = document.getElementById("pressure_chart_right");
const chartDivLeft = document.getElementById("pressure_chart_left");
const liveDataToggle = document.getElementById("live_data_toggle");
const runSelectorContainer = document.getElementById("run_selector_container");
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
// Run selector
const runSelector = document.getElementById('run_selector');
const activeProfileNameEl = document.getElementById('active_profile_name');
const btnRunControl = document.getElementById('btn_run_control');

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
const btnMoveToUnsorted = document.getElementById('btn_move_to_unsorted');
const renameRunInput = document.getElementById('rename_run_input');
const btnRenameProfileRun = document.getElementById('btn_rename_profile_run');
const btnDownloadProfileRun = document.getElementById('btn_download_profile_run');
const btnDeleteProfileRun = document.getElementById('btn_delete_profile_run');
const btnDeleteUnsortedRun = document.getElementById('btn_delete_unsorted_run');

const RESERVED_UNSORTED = '.';  // Root SD card directory

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
    // Show only real runners (exclude reserved folders like 'models', 'SYSTEM~1', etc.)
    for (const r of runners) {
      const lowerName = r.toLowerCase();
      // Skip system folders: models, SYSTEM~1, lost+found, etc.
      if (lowerName === 'models' || r.includes('SYSTEM') || lowerName === 'lost+found') continue;
      const opt = document.createElement('option');
      opt.value = r; opt.textContent = r; if (r === active) opt.selected = true; profileSelect.appendChild(opt);
    }
    
    // Update active profile indicator
    const indicator = document.getElementById('active_profile_indicator');
    if (indicator) {
      if (active) {
        indicator.textContent = `✓ ${active}`;
        indicator.style.display = 'inline';
      } else {
        indicator.textContent = '';
        indicator.style.display = 'none';
      }
    }
    
    // Update header active profile display
    if (activeProfileNameEl) {
      activeProfileNameEl.textContent = active || 'None';
    }
    
    // Populate lists
    await refreshRunsLists();
    
    // Refresh the header run selector
    await loadActiveProfileAndRuns();
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

// Load active profile and populate the run selector in the header
function highlightSelectedRun(selectedValue) {
  if (!runSelector) return;
  
  // Remove previous highlighting
  Array.from(runSelector.options).forEach(opt => {
    opt.style.background = '';
    opt.style.fontWeight = '';
    opt.style.color = '';
  });
  
  // Highlight the selected run
  if (selectedValue) {
    const selectedOption = Array.from(runSelector.options).find(opt => opt.value === selectedValue);
    if (selectedOption) {
      selectedOption.style.background = 'var(--color-primary)';
      selectedOption.style.fontWeight = 'bold';
      selectedOption.style.color = 'var(--color-white)';
    }
  }
}

async function loadActiveProfileAndRuns() {
  try {
    // Get active runner
    const runnersInfo = await apiGetJSON('/api/runners');
    const activeRunner = runnersInfo.active || '';
    
    // Update active profile display
    if (activeProfileNameEl) {
      activeProfileNameEl.textContent = activeRunner || 'None';
    }
    
    // Populate run selector with runs from active profile and unsorted
    if (runSelector) {
      runSelector.innerHTML = '<option value="">-- No run selected --</option>';
      
      // Add runs from active profile first
      if (activeRunner) {
        const profRuns = await apiGetJSON(`/api/runs-in?runner=${encodeURIComponent(activeRunner)}`);
        if (profRuns.length > 0) {
          const profileGroup = document.createElement('optgroup');
          profileGroup.label = `Profile: ${activeRunner}`;
          for (const f of profRuns) {
            const opt = document.createElement('option');
            opt.value = `${activeRunner}/${f}`;
            opt.textContent = f;
            profileGroup.appendChild(opt);
          }
          runSelector.appendChild(profileGroup);
        }
      }
      
      // Add unsorted runs after profile runs
      const unsorted = await apiGetJSON(`/api/runs-in?runner=${encodeURIComponent(RESERVED_UNSORTED)}`);
      if (unsorted.length > 0) {
        const unsortedGroup = document.createElement('optgroup');
        unsortedGroup.label = 'Unsorted';
        for (const f of unsorted) {
          const opt = document.createElement('option');
          opt.value = f;
          opt.textContent = f;
          unsortedGroup.appendChild(opt);
        }
        runSelector.appendChild(unsortedGroup);
      }
    }
  } catch (e) {
    console.error('Failed loading active profile and runs:', e);
    if (activeProfileNameEl) {
      activeProfileNameEl.textContent = 'Error';
    }
  }
}

btnProfile && btnProfile.addEventListener('click', showProfileModal);
profileClose && profileClose.addEventListener('click', hideProfileModal);
profileSelect && profileSelect.addEventListener('change', refreshRunsLists);

btnSetActive && btnSetActive.addEventListener('click', async () => {
  const prof = profileSelect.value;
  if (!prof) {
    alert('Please select a profile first');
    return;
  }
  try {
    await apiPostForm('/api/active-runner', { runner: prof });
    console.log(`Active profile set to: ${prof}`);
    alert(`Active profile set to "${prof}"`);
    await refreshProfilesUI();
  } catch (e) {
    console.error('Failed to set active profile:', e);
    alert('Failed to set active profile: ' + e.message);
  }
});

btnCreateRunner && btnCreateRunner.addEventListener('click', async () => {
  const name = (newRunnerName.value || '').trim();
  if (!name) {
    alert('Please enter a runner name');
    return;
  }
  
  // Validate: only alphanumeric characters (letters and numbers)
  if (!/^[a-zA-Z0-9]+$/.test(name)) {
    alert('Runner name can only contain letters (a-z, A-Z) and numbers (0-9)');
    return;
  }
  
  // FAT32 filesystem warning: short names (8 chars or less) will be converted to uppercase
  // To preserve mixed case, the name should be longer than 8 characters
  if (name.length <= 8 && name !== name.toUpperCase() && name !== name.toLowerCase()) {
    const proceed = confirm(
      `Note: FAT32 filesystems convert short folder names to UPPERCASE.\n\n` +
      `"${name}" will appear as "${name.toUpperCase()}" in the list.\n\n` +
      `To preserve mixed case, use more than 8 characters.\n\nContinue anyway?`
    );
    if (!proceed) return;
  }
  
  try {
    const result = await apiPostForm('/api/create-runner', { name });
    
    if (result.exists) {
      alert(`Runner "${name}" already exists!`);
    } else {
      console.log(`Runner "${name}" created successfully`);
      newRunnerName.value = '';
      await refreshProfilesUI();
    }
  } catch(e) {
    console.error('Failed to create runner:', e);
    alert('Failed to create runner: ' + e.message);
  }
});

btnMoveSelected && btnMoveSelected.addEventListener('click', async () => {
  const prof = profileSelect.value;
  if (!prof) {
    alert('Please select a profile first');
    return;
  }
  const selected = Array.from(unsortedList.selectedOptions).map(o=>o.value);
  if (selected.length === 0) {
    alert('Please select at least one run to move');
    return;
  }
  
  let successCount = 0;
  for (const fname of selected) {
    try {
      await apiPostForm('/api/move-run', { src: `${RESERVED_UNSORTED}/${fname}`, dst: `${prof}/${fname}` });
      successCount++;
    } catch (e) {
      console.error('Move failed for', fname, e);
      alert(`Failed to move ${fname}`);
    }
  }
  
  if (successCount > 0) {
    console.log(`Moved ${successCount} run(s) to profile "${prof}"`);
  }
  await refreshRunsLists();
});

btnMoveToUnsorted && btnMoveToUnsorted.addEventListener('click', async () => {
  const prof = profileSelect.value;
  if (!prof) {
    alert('Please select a profile first');
    return;
  }
  const selected = Array.from(profileRunsList.selectedOptions).map(o=>o.value);
  if (selected.length === 0) {
    alert('Please select at least one run to move');
    return;
  }
  
  let successCount = 0;
  for (const fname of selected) {
    try {
      await apiPostForm('/api/move-run', { src: `${prof}/${fname}`, dst: `${RESERVED_UNSORTED}/${fname}` });
      successCount++;
    } catch (e) {
      console.error('Move to unsorted failed for', fname, e);
      alert(`Failed to move ${fname}`);
    }
  }
  
  if (successCount > 0) {
    console.log(`Moved ${successCount} run(s) back to unsorted`);
  }
  await refreshRunsLists();
});

btnRenameProfileRun && btnRenameProfileRun.addEventListener('click', async () => {
  const prof = profileSelect.value;
  if (!prof) {
    alert('Please select a profile first');
    return;
  }
  const selected = profileRunsList.selectedOptions;
  if (selected.length === 0) {
    alert('Please select a run to rename');
    return;
  }
  if (selected.length > 1) {
    alert('Please select exactly one run to rename');
    return;
  }
  const oldName = selected[0].value;
  let newName = (renameRunInput.value || '').trim();
  if (!newName) {
    alert('Please enter a new name');
    return;
  }
  
  // Ensure name starts with RUN and ends with .CSV
  if (!newName.toUpperCase().startsWith('RUN')) {
    alert('File name must start with "RUN"');
    return;
  }
  if (!newName.toUpperCase().endsWith('.CSV')) {
    newName += '.CSV';
  }
  
  if (newName === oldName) {
    alert('New name is the same as the old name');
    return;
  }
  
  try {
    await apiPostForm('/api/rename-run', { folder: prof, old: oldName, new: newName });
    console.log(`Renamed "${oldName}" to "${newName}"`);
    renameRunInput.value = '';
    await refreshRunsLists();
  } catch (e) {
    console.error('Rename failed', e);
    alert('Failed to rename: ' + e.message);
  }
});

btnDownloadProfileRun && btnDownloadProfileRun.addEventListener('click', async () => {
  const prof = profileSelect.value; if (!prof) return;
  const selected = Array.from(profileRunsList.selectedOptions).map(o=>o.value);
  if (selected.length === 0) { console.log('Select at least one run to download'); return; }
  
  // Download selected runs
  for (const fname of selected) {
    try {
      const url = `/api/runs/${encodeURIComponent(prof + '/' + fname)}`;
      const a = document.createElement('a');
      a.href = url;
      a.download = fname;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      
      // Small delay between downloads if multiple selected
      if (selected.length > 1) {
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    } catch (e) { 
      console.error('Download failed for', fname, e); 
      alert(`Failed to download ${fname}`);
    }
  }
  
  if (selected.length > 0) {
    console.log(`Downloaded ${selected.length} file(s)`);
  }
});

btnDeleteProfileRun && btnDeleteProfileRun.addEventListener('click', async () => {
  const prof = profileSelect.value; if (!prof) return;
  const selected = Array.from(profileRunsList.selectedOptions).map(o=>o.value);
  if (selected.length === 0) { 
    alert('Select at least one run to delete'); 
    return; 
  }
  
  // Build confirmation message with file names
  let message = `Delete ${selected.length} run(s) from profile "${prof}"?\n\n`;
  if (selected.length <= 5) {
    message += selected.join('\n');
  } else {
    message += selected.slice(0, 5).join('\n') + `\n... and ${selected.length - 5} more`;
  }
  
  if (!confirm(message)) return;
  
  for (const fname of selected) {
    try {
      await apiPostForm('/api/delete-run', { folder: prof, file: fname });
    } catch (e) { console.error('Delete failed for', fname, e); }
  }
  await refreshRunsLists();
});

btnDeleteUnsortedRun && btnDeleteUnsortedRun.addEventListener('click', async () => {
  const selected = Array.from(unsortedList.selectedOptions).map(o=>o.value);
  if (selected.length === 0) { 
    alert('Select at least one run to delete'); 
    return; 
  }
  
  // Build confirmation message with file names
  let message = `Delete ${selected.length} unsorted run(s)?\n\n`;
  if (selected.length <= 5) {
    message += selected.join('\n');
  } else {
    message += selected.slice(0, 5).join('\n') + `\n... and ${selected.length - 5} more`;
  }
  
  if (!confirm(message)) return;
  
  for (const fname of selected) {
    try {
      // Unsorted runs are in the root directory (RESERVED_UNSORTED = '.')
      await apiPostForm('/api/delete-run', { folder: RESERVED_UNSORTED, file: fname });
    } catch (e) { 
      console.error('Delete failed for', fname, e); 
      alert(`Failed to delete ${fname}`);
    }
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
  // For ESP32, use HTTP polling
  if (location.protocol === 'file:') {
    console.log('Running from file:// — Using local file mode.');
    return;
  }
  
  // Start HTTP polling for live data from ESP32
  startHttpPolling();
}

// Fetch live ADC data from ESP32 via HTTP
async function startHttpPolling() {
  if (pollingTimer) return; // Already running
  
  let noDataWarningShown = false;
  
  const fetchLiveData = async () => {
    if (!liveMode) return; // Skip if not in live mode
    
    try {
      const resp = await fetch('/api/live');
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      
      const data = await resp.json();
      // data = { timestamp: <ms>, active: <bool>, run_id: <int>, roll: <deg>, pitch: <deg>, sensors: [v1,v2,...v8] }
      
      if (data.sensors && data.sensors.length === 8) {
        runActive = !!data.active;
        updateRunButton();
        if (data.active) {
          // Run is active, display data normally
          const roll = data.roll !== undefined ? data.roll : 0;
          const pitch = data.pitch !== undefined ? data.pitch : 0;
          handleSensorData(data.sensors, data.timestamp, roll, pitch);
          noDataWarningShown = false;
        } else {
          // No run active - show message once
          if (!noDataWarningShown) {
            console.log('Waiting for run... Press button on ESP32 to start data collection.');
            noDataWarningShown = true;
          }
        }
      }
    } catch (e) {
      // Log errors to help debugging
      console.log(`Polling error: ${e}`);
    }
  };
  
  // Start polling immediately and then every 100ms
  fetchLiveData();
  pollingTimer = setInterval(fetchLiveData, 100);
  console.log('HTTP polling started');
}

// Stop HTTP polling
function stopHttpPolling() {
  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = null;
    console.log('HTTP polling stopped');
  }
}

function updateRunButton() {
  if (!btnRunControl) return;
  btnRunControl.style.display = liveMode ? '' : 'none';
  btnRunControl.textContent = runActive ? t('stop_run') : t('start_run');
  btnRunControl.disabled = !liveMode;
}

// Handle incoming sensor data from ESP32
function handleSensorData(voltages, timestamp, roll, pitch) {
  if (!voltages || voltages.length !== 8) return;
  if (!liveMode || isPlottingCSV) return; // Don't update during CSV viewing
  
  // Initialize time reference if needed
  if (t0 == null) t0 = Date.now();
  
  // Calculate relative time in seconds
  const elapsedMs = timestamp || (Date.now() - t0);
  const seconds = elapsedMs / 1000;
  
  // Update sample count
  sampleCount += 1;
  if (sampleCountEl) sampleCountEl.textContent = `${sampleCount}`;
  if (durationEl) durationEl.textContent = `${seconds.toFixed(1)}s`;
  
  // Update sensor pressures for handlebar visualization (keep as voltages)
  sensorPressures = voltages.slice(); // Keep as voltage values (0-3.3V)
  
  // Update bike rotation if angles are provided
  if (roll !== undefined && pitch !== undefined) {
    updateBikeRotation(roll, pitch);
  }
  
  // Store in history for averaging
  for (let i = 0; i < 8; i++) {
    sensorPressureHistory[i].push({ time: seconds, pressure: sensorPressures[i] });
    // Keep only recent history (e.g., last 1000 samples or 60 seconds)
    if (sensorPressureHistory[i].length > 1000) {
      sensorPressureHistory[i].shift();
    }
    // Calculate average
    const sum = sensorPressureHistory[i].reduce((acc, item) => acc + item.pressure, 0);
    sensorPressureAverages[i] = sum / sensorPressureHistory[i].length;
  }
  
  updateHandlebarHeatmap();
  
  // Prepare data for right handle (sensors 1-4) - one point per trace
  const xDataRight = [[seconds], [seconds], [seconds], [seconds]];
  const yDataRight = [[voltages[0]], [voltages[1]], [voltages[2]], [voltages[3]]];
  
  // Prepare data for left handle (sensors 5-8) - one point per trace
  const xDataLeft = [[seconds], [seconds], [seconds], [seconds]];
  const yDataLeft = [[voltages[4]], [voltages[5]], [voltages[6]], [voltages[7]]];
  
  // Extend traces (add new points)
  Plotly.extendTraces(chartDivRight, { x: xDataRight, y: yDataRight }, [0, 1, 2, 3]);
  Plotly.extendTraces(chartDivLeft, { x: xDataLeft, y: yDataLeft }, [0, 1, 2, 3]);
  
  // Update x-axis range to show rolling window
  const windowStart = Math.max(0, seconds - LIVE_WINDOW_SECONDS);
  Plotly.relayout(chartDivRight, {
    'xaxis.range': [windowStart, seconds]
  });
  Plotly.relayout(chartDivLeft, {
    'xaxis.range': [windowStart, seconds]
  });
  
  // Trim old data points to prevent memory buildup (keep last 10 minutes of data)
  if (chartDivRight.data && chartDivRight.data[0].x.length > 6000) {
    const removeCount = chartDivRight.data[0].x.length - 6000;
    Plotly.relayout(chartDivRight, {});
    for (let i = 0; i < 4; i++) {
      chartDivRight.data[i].x.splice(0, removeCount);
      chartDivRight.data[i].y.splice(0, removeCount);
    }
  }
  if (chartDivLeft.data && chartDivLeft.data[0].x.length > 6000) {
    const removeCount = chartDivLeft.data[0].x.length - 6000;
    Plotly.relayout(chartDivLeft, {});
    for (let i = 0; i < 4; i++) {
      chartDivLeft.data[i].x.splice(0, removeCount);
      chartDivLeft.data[i].y.splice(0, removeCount);
    }
  }
  
  // Update KPI stats
  const avgVoltage = voltages.reduce((a, b) => a + b, 0) / voltages.length;
  const maxVoltage = Math.max(...voltages);
  
  sumPressure += avgVoltage;
  if (avgVoltage > maxPressure) maxPressure = avgVoltage;
  
  if (latestPressureEl) latestPressureEl.textContent = `${avgVoltage.toFixed(2)} V`;
  if (meanPressureEl) meanPressureEl.textContent = `${(sumPressure / sampleCount).toFixed(2)} V`;
  if (maxPressureEl && isFinite(maxPressure)) maxPressureEl.textContent = `${maxPressure.toFixed(2)} V`;
}

// Buttons
const clearChartBtn = document.getElementById('btn_clear_chart');

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
  
  // Clear CSV highlighting
  isPlottingCSV = false;
  
  // Only return to live mode if live data toggle is checked
  if (liveDataToggle && liveDataToggle.checked) {
    liveMode = true;
    startHttpPolling();
  } else {
    // Keep historical mode, but clear CSV selection
    highlightSelectedRun('');
  }
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
  
  // Keep handlebar 3D transparent so card background shows through
  if (handlebarScene && handlebarRenderer) {
    handlebarScene.background = null;
    handlebarRenderer.setClearColor(0x000000, 0);
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
  updateRunButton();
  if (btnRefreshRuns) btnRefreshRuns.addEventListener('click', listRuns);
  if (btnLoadRun) btnLoadRun.addEventListener('click', plotSelectedRun);
  if (liveModeChk) liveModeChk.addEventListener('change', () => { 
    liveMode = liveModeChk.checked; 
    if (liveMode) {
      startHttpPolling();
    } else {
      stopHttpPolling();
    }
    updateRunButton();
  });
  if (btnRunControl) btnRunControl.addEventListener('click', async () => {
    if (!liveMode) return;
    btnRunControl.disabled = true;
    try {
      const endpoint = runActive ? '/api/run/stop' : '/api/run/start';
      const resp = await fetch(endpoint, { method: 'POST' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json().catch(() => ({}));
      if (typeof data.active === 'boolean') {
        runActive = data.active;
      } else {
        runActive = !runActive;
      }
    } catch (e) {
      console.error('Run control failed:', e);
    } finally {
      btnRunControl.disabled = false;
      updateRunButton();
    }
  });
  langButtons.forEach(btn => btn.addEventListener('click', () => setLanguage(btn.dataset.lang)));
  setLanguage(loadLangPref());
  
  // Sidebar nav
  navLinks.forEach(link => link.addEventListener('click', (e) => {
    e.preventDefault();
    const mode = link.dataset.layout;
    applyLayout(mode);
    setActiveNav(mode);
  }));
  // Live data toggle - show/hide run selector
  if (liveDataToggle) {
    liveDataToggle.addEventListener('change', (e) => {
      const isLiveMode = e.target.checked;
      if (runSelectorContainer) {
        runSelectorContainer.style.display = isLiveMode ? 'none' : 'block';
      }
      if (isLiveMode) {
        // Switch to live mode
        liveMode = true;
        isPlottingCSV = false;
        updateRunButton();
        
        // Start HTTP polling for live data
        startHttpPolling();
        
        // Clear all graphs
        Plotly.react(chartDivRight, [
          { x: [], y: [], mode: 'lines', line: { color: colors[0], width: 2 }, name: 'Sensor 1' },
          { x: [], y: [], mode: 'lines', line: { color: colors[1], width: 2 }, name: 'Sensor 2' },
          { x: [], y: [], mode: 'lines', line: { color: colors[2], width: 2 }, name: 'Sensor 3' },
          { x: [], y: [], mode: 'lines', line: { color: colors[3], width: 2 }, name: 'Sensor 4' }
        ], chartLayout, chartConfig);
        
        Plotly.react(chartDivLeft, [
          { x: [], y: [], mode: 'lines', line: { color: colors[0], width: 2 }, name: 'Sensor 5' },
          { x: [], y: [], mode: 'lines', line: { color: colors[1], width: 2 }, name: 'Sensor 6' },
          { x: [], y: [], mode: 'lines', line: { color: colors[2], width: 2 }, name: 'Sensor 7' },
          { x: [], y: [], mode: 'lines', line: { color: colors[3], width: 2 }, name: 'Sensor 8' }
        ], chartLayout, chartConfig);
        
        // Reset sensor pressures and history
        sensorPressures = [0, 0, 0, 0, 0, 0, 0, 0];
        sensorPressureHistory = [[], [], [], [], [], [], [], []];
        sensorPressureAverages = [0, 0, 0, 0, 0, 0, 0, 0];
        hoverTime = null;
        updateHandlebarHeatmap();
        
        // Clear CSV highlighting
        highlightSelectedRun('');
        
        // Reset stats
        t0 = null; 
        sampleCount = 0;
        if (latestPressureEl) latestPressureEl.textContent = '0 N';
        if (sampleCountEl) sampleCountEl.textContent = '0';
        if (durationEl) durationEl.textContent = '0s';
      } else {
        // Switch to historical mode - reset dropdown to no selection
        liveMode = false;
        updateRunButton();
        if (runSelector) {
          runSelector.value = '';
          highlightSelectedRun('');
        }
      }
    });
  }
  
  // Run selector - load run when selected
  if (runSelector) {
    runSelector.addEventListener('change', async (e) => {
      const selected = e.target.value;
      if (selected) {
        await loadAndPlotCSV(selected);
        highlightSelectedRun(selected);
      } else {
        highlightSelectedRun('');
      }
    });
  }
  
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
  
  // Load active profile and populate run selector
  loadActiveProfileAndRuns();

  // Fallback wiring for Customize modal if ui-layout.js isn't active
  // Customize modal removed
});

// Customize modal removed

// ---------- Run loading and plotting ----------

async function listRuns() {
  try {
    const resp = await fetch('/api/runs'); // ESP32 API endpoint
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const names = Array.isArray(data) ? data : [];
    populateRuns(names);
    console.log(`Runs: ${names.join(', ')}`);
  } catch (e) {
    console.log(`Failed to list runs: ${e}`);
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
    console.log('Select a run first.');
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
    console.log(`Failed to load run: ${e}`);
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
  tryLoadBikeModel('MODELS/BIKE/bike.glb.gz');
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

// Update bike rotation based on IMU angles
function updateBikeRotation(roll, pitch) {
  if (!bikePivot) return;
  
  // Convert degrees to radians and apply rotation
  // Roll: rotation around Z axis (bike tilting left/right)
  // Pitch: rotation around X axis (bike tilting forward/backward)
  oriRoll = roll * (Math.PI / 180);
  oriPitch = pitch * (Math.PI / 180);
}

function tryLoadBikeModel(modelFileName = 'MODELS/BIKE/bike.glb.gz') {
  // In production on device; if not available, just render the rest of the page
  if (location.protocol === 'file:') {
    return;
  }
  
  const loader = (window.THREE && THREE.GLTFLoader) ? new THREE.GLTFLoader() : (window.GLTFLoader ? new GLTFLoader() : null);
  if (!loader) { 
    console.log('GLTFLoader not found.'); 
    return; 
  }
  
  // Configure DRACOLoader for compressed models
  const dracoLoader = (window.THREE && THREE.DRACOLoader) ? new THREE.DRACOLoader() : (window.DRACOLoader ? new DRACOLoader() : null);
  if (dracoLoader) {
    // Use local Draco decoder files from SD card
    dracoLoader.setDecoderPath('/draco/');
    dracoLoader.setDecoderConfig({ type: 'wasm' });
    dracoLoader.preload();
    loader.setDRACOLoader(dracoLoader);
    console.log('DRACOLoader configured (offline mode)');
  } else {
    console.log('Warning: DRACOLoader not available, compressed models may not load');
  }
  
  // Load GLB model from SD card (full path should be provided)
  const modelPath = modelFileName;
  const displayName = modelFileName.split('/').pop().replace('.glb', '').replace(/_/g, ' ');
  console.log(`Loading 3D model: ${modelPath}`);
  
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
        console.log('GLB has no scene'); 
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
      
      // Position camera to view the bike from the side
      if (threeCamera) {
        const box = new THREE.Box3().setFromObject(pivot);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z);
        const fov = threeCamera.fov * (Math.PI / 180);
        const fitDist = (maxDim / 2) / Math.tan(fov / 2);
        // Place camera to the side of the bike (-90° angle on X axis) to view it from the left side
        // Position on negative X axis, slightly above center, closer to model
        threeCamera.position.set(center.x - fitDist * 0.7, center.y + maxDim * 0.1, center.z);
        threeCamera.near = Math.max(0.01, fitDist / 100);
        threeCamera.far = fitDist * 100;
        threeCamera.updateProjectionMatrix();
        threeCamera.lookAt(center);
      }
      
      console.log(`3D model loaded: ${displayName}`);
    },
    (xhr) => {
      // No progress UI in production
    },
    (error) => {
      // If model missing, do nothing; rest of page continues
      console.log(`Failed to load ${modelPath}: ${error && error.message ? error.message : error}`);
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

// ---------- Handlebar 3D with Heatmap ----------
let handlebarScene, handlebarCamera, handlebarRenderer, handlebarFrame;
let handlebarModel;
let sensorPressures = [0, 0, 0, 0, 0, 0, 0, 0]; // 8 sensors - current values
let sensorPressureHistory = [[], [], [], [], [], [], [], []]; // Store history for averaging
let sensorPressureAverages = [0, 0, 0, 0, 0, 0, 0, 0]; // Averaged values for heatmap
let useAveragePressure = true; // Toggle between current and average
let hoverTime = null; // Time value when hovering over graph
let handlebarRotation = { x: 0, y: 0 };
let handlebarZoom = 2;
let handlebarCenter = new THREE.Vector3(0, 0, 0);
let handlebarMouseDown = false;
let handlebarLastMouse = { x: 0, y: 0 };

function initHandlebar() {
  const container = document.getElementById('handlebar_container');
  if (!container) return;
  
  // Scene setup with transparent background to let card show through
  handlebarScene = new THREE.Scene();
  handlebarScene.background = null;
  
  // Camera
  const w = Math.max(1, container.clientWidth);
  const h = Math.max(1, container.clientHeight);
  handlebarCamera = new THREE.PerspectiveCamera(50, w / h, 0.01, 1000);
  handlebarCamera.position.set(0, 0.5, 0.4);
  handlebarCamera.lookAt(0, 0, 0);
  
  // Renderer with alpha so the card background is visible
  handlebarRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  handlebarRenderer.setClearColor(0x000000, 0);
  handlebarRenderer.setSize(w, h);
  container.appendChild(handlebarRenderer.domElement);
  
  // Lights
  const amb = new THREE.AmbientLight(0xffffff, 0.6);
  handlebarScene.add(amb);
  const dir = new THREE.DirectionalLight(0xffffff, 0.8);
  dir.position.set(2, 3, 1);
  handlebarScene.add(dir);
  
  // Load handlebar GLB model
  loadHandlebarModel('MODELS/HBAR/hbar.glb.gz');
  
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
    const zoomFactor = e.deltaY > 0 ? 1.1 : 0.9;
    handlebarZoom *= zoomFactor;
    // Use dynamic limits if available, otherwise fallback to reasonable defaults
    const minZoom = handlebarZoom.min || 0.5;
    const maxZoom = handlebarZoom.max || 50;
    handlebarZoom = Math.max(minZoom, Math.min(maxZoom, handlebarZoom));
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
  // In production: if not available, just render rest of page
  if (location.protocol === 'file:') {
    return;
  }
  
  const loader = (window.THREE && THREE.GLTFLoader) ? new THREE.GLTFLoader() : (window.GLTFLoader ? new GLTFLoader() : null);
  if (!loader) {
    console.log('GLTFLoader not found for handlebar.');
    return;
  }
  
  // Configure DRACOLoader for compressed models (offline mode)
  const dracoLoader = (window.THREE && THREE.DRACOLoader) ? new THREE.DRACOLoader() : (window.DRACOLoader ? new DRACOLoader() : null);
  if (dracoLoader) {
    dracoLoader.setDecoderPath('/draco/');
    dracoLoader.setDecoderConfig({ type: 'wasm' });
    dracoLoader.preload();
    loader.setDRACOLoader(dracoLoader);
  }
  
  const modelPath = modelFileName;
  loader.load(modelPath, (gltf) => {
    if (handlebarModel) handlebarScene.remove(handlebarModel);
    handlebarModel = gltf.scene;
    handlebarScene.add(handlebarModel);
    
    // Frame the handlebar in the view
    frameHandlebar(handlebarModel);
    
    // Initialize vertex colors for heatmap
    updateHandlebarHeatmap();
    
    console.log(`Loaded handlebar model: ${modelFileName}`);
  }, undefined, (err) => {
    // If missing, do nothing; rest of page continues
    console.log(`Failed to load handlebar model: ${err}`);
  });
}


function frameHandlebar(object3D) {
  if (!handlebarCamera) return;
  const box = new THREE.Box3().setFromObject(object3D);
  const size = box.getSize(new THREE.Vector3());
  handlebarCenter = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  
  // Scale the model to a reasonable size (target max dimension of ~2 units)
  const targetSize = 2.0;
  if (maxDim > 0.01) {
    const scale = targetSize / maxDim;
    object3D.scale.set(scale, scale, scale);
    // Recalculate box after scaling
    box.setFromObject(object3D);
    box.getSize(size);
    box.getCenter(handlebarCenter);
  }
  
  const fov = handlebarCamera.fov * (Math.PI / 180);
  const fitDist = (Math.max(size.x, size.y, size.z) / 2) / Math.tan(fov / 2);
  
  // Set initial zoom and rotation based on model size
  handlebarZoom = fitDist * 1.5; // Start a bit further back
  handlebarRotation.x = 0.5; // Slight tilt down
  handlebarRotation.y = 3.1415; // Front view
  
  // Store zoom limits for this model
  handlebarZoom.min = fitDist * 0.3;
  handlebarZoom.max = fitDist * 5;
  
  handlebarCamera.near = Math.max(0.01, fitDist / 100);
  handlebarCamera.far = fitDist * 100;
  handlebarCamera.updateProjectionMatrix();
  
  updateHandlebarCamera();
}

function updateHandlebarHeatmap() {
  if (!handlebarModel) return;
  
  // Determine which pressure values to use
  let pressuresToUse;
  
  if (hoverTime !== null) {
    // Use pressures at the hovered time
    pressuresToUse = [];
    for (let i = 0; i < 8; i++) {
      // Find the closest sample to the hover time
      const history = sensorPressureHistory[i];
      if (history.length === 0) {
        pressuresToUse[i] = 0;
        continue;
      }
      
      // Binary search or simple find closest
      let closest = history[0];
      let minDiff = Math.abs(history[0].time - hoverTime);
      for (let j = 1; j < history.length; j++) {
        const diff = Math.abs(history[j].time - hoverTime);
        if (diff < minDiff) {
          minDiff = diff;
          closest = history[j];
        }
      }
      pressuresToUse[i] = closest.pressure;
    }
  } else if (liveMode) {
    // In live mode, always use current/latest values (no averaging)
    pressuresToUse = sensorPressures;
  } else if (useAveragePressure) {
    // Use averaged values (for CSV mode)
    pressuresToUse = sensorPressureAverages;
  } else {
    // Use current/latest values
    pressuresToUse = sensorPressures;
  }
  
  // Use fixed voltage range for consistent color mapping
  const maxPressure = 3.3;  // Max voltage
  const minPressure = 0.0;  // Min voltage
  
  // Update legend with fixed voltage range
  const legendMin = document.getElementById('legend_min');
  const legendMax = document.getElementById('legend_max');
  if (legendMin) legendMin.textContent = '0.00 [V]';
  if (legendMax) legendMax.textContent = '3.30 [V]';
  
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
    
    // Each grip has 4 sensors positioned as:
    // Top half: 2 sensors (left and right)
    // Bottom half: 2 sensors (left and right)
    // Add gap between sensors for visual separation
    const gapRatio = 0.05; // 5% gap between sensors
    
    // Map sensors to positions on the grip
    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i);
      const y = position.getY(i);
      const z = position.getZ(i);
      
      // Normalize positions (0 to 1) - try X axis for horizontal division
      const yNorm = (y - bbox.min.y) / (bbox.max.y - bbox.min.y || 1);
      const xNorm = (x - bbox.min.x) / (bbox.max.x - bbox.min.x || 1);
      
      // Check if vertex is in the gap area (center strip between sensors)
      const inYGap = Math.abs(yNorm - 0.5) < gapRatio;
      const inXGap = Math.abs(xNorm - 0.5) < gapRatio;
      
      // If in gap, use neutral color
      if (inYGap || inXGap) {
        colors[i * 3] = 0.2;     // Dark gray for gaps
        colors[i * 3 + 1] = 0.2;
        colors[i * 3 + 2] = 0.2;
        continue;
      }
      
      // Determine which of the 4 quadrants this vertex belongs to
      // Y axis: vertical (top/bottom)
      // X axis: horizontal (left/right or front/back)
      const isTop = yNorm >= 0.5;
      const isRight_XAxis = xNorm >= 0.5;
      
      let sensorIndex = 0;
      
      if (isRight) {
        // Right grip: sensors 1-4
        if (isTop && isRight_XAxis) sensorIndex = 0;        // Sensor 1
        else if (isTop && !isRight_XAxis) sensorIndex = 1;  // Sensor 2
        else if (!isTop && isRight_XAxis) sensorIndex = 2;  // Sensor 3
        else sensorIndex = 3;                                // Sensor 4
      } else {
        // Left grip: sensors 5-8
        if (isTop && isRight_XAxis) sensorIndex = 4;        // Sensor 5
        else if (isTop && !isRight_XAxis) sensorIndex = 5;  // Sensor 6
        else if (!isTop && isRight_XAxis) sensorIndex = 6;  // Sensor 7
        else sensorIndex = 7;                                // Sensor 8
      }
      
      const pressure = pressuresToUse[sensorIndex];
      
      // Normalize pressure (0-1) using min and max range
      const normalized = Math.min(Math.max((pressure - minPressure) / (maxPressure - minPressure), 0), 1);
      
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
    right_handle: 'Right',
    left_handle: 'Left',
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
    start_run: 'Start run',
    stop_run: 'Stop run',
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
    right_handle: 'Droite',
    left_handle: 'Gauche',
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
    start_run: 'Démarrer le run',
    stop_run: 'Arrêter le run',
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
    right_handle: 'Rechts',
    left_handle: 'Links',
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
    start_run: 'Lauf starten',
    stop_run: 'Lauf stoppen',
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

function t(key) {
  const dict = I18N[currentLang] || I18N.en;
  return dict[key] || I18N.en[key] || key;
}

function setLanguage(lang) {
  if (!I18N[lang]) lang = 'en';
  currentLang = lang;
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

  updateRunButton();
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
    .catch(e => console.log(`Filter failed: ${e}`));
}

async function renameSelectedRun() {
  if (!runSelect || !runSelect.value || !renameInput || !renameInput.value) {
    console.log('Select a run and enter a new name.');
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
    console.log(`Renamed ${oldName} -> ${newName}`);
    await listRuns();
    setSelected(runSelect, newName);
  } catch (e) {
    console.log(`Rename failed: ${e}`);
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
    // If filename contains '/', it's a profile run (PROFILE/FILE.CSV)
    // Otherwise it's an unsorted run (FILE.CSV)
    const url = filename.includes('/') 
      ? `/api/runs/${encodeURIComponent(filename)}` // For profile: /api/runs/PROFILE%2FFILE.CSV becomes /sdcard/PROFILE/FILE.CSV on server
      : `/api/runs/${encodeURIComponent(filename)}`; // For unsorted: /api/runs/FILE.CSV becomes /sdcard/FILE.CSV on server
    
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const csvText = await resp.text();
    
    // Parse CSV
    const lines = csvText.trim().split('\n');
    if (lines.length < 2) throw new Error('CSV file is empty');
    
    const header = lines[0].split(',').map(s => s.trim());
    
    // Detect format by checking header
    const isNewFormat = header.length >= 11 && header[0].toLowerCase().includes('time');
    const isOldFormat = header.length >= 4 && header.some(h => h.toLowerCase().includes('capteur'));
    
    // Group data by sensor
    const sensorData = {};
    for (let i = 1; i <= 8; i++) {
      sensorData[i] = { x: [], y: [] };
    }
    
    if (isNewFormat) {
      // New format: Time(ms), Roll(deg), Pitch(deg), FSR_B0, FSR_B1, FSR_B2, FSR_B3, FSR_A0, FSR_A1, FSR_A2, FSR_A3
      // FSR values are 12-bit ADC values (0-4095), need to convert to voltage (0-3.3V) and multiply by 7
      for (let i = 1; i < lines.length; i++) {
        const parts = lines[i].split(',').map(s => s.trim());
        if (parts.length < 11) continue;
        
        const timeMs = parseFloat(parts[0]);
        const timeS = timeMs / 1000; // Convert to seconds
        
        // FSR_B0-B3 (Right grip: sensors 1-4)
        for (let j = 0; j < 4; j++) {
          const adcValue = parseInt(parts[3 + j]);
          const voltage = ((adcValue * 3.3) / 4095) * 7; // Convert 12-bit ADC to voltage and multiply by 7
          sensorData[j + 1].x.push(timeS);
          sensorData[j + 1].y.push(voltage);
        }
        
        // FSR_A0-A3 (Left grip: sensors 5-8)
        for (let j = 0; j < 4; j++) {
          const adcValue = parseInt(parts[7 + j]);
          const voltage = ((adcValue * 3.3) / 4095) * 7; // Convert 12-bit ADC to voltage and multiply by 7
          sensorData[j + 5].x.push(timeS);
          sensorData[j + 5].y.push(voltage);
        }
      }
    } else if (isOldFormat) {
      // Old format: run,time_run_ms,capteur,value_V
      for (let i = 1; i < lines.length; i++) {
        const parts = lines[i].split(',').map(s => s.trim());
        if (parts.length < 4) continue;
        
        const timeMs = parseFloat(parts[1]);
        const sensor = parseInt(parts[2]);
        const voltage = parseFloat(parts[3]);
        
        if (sensor >= 1 && sensor <= 8) {
          sensorData[sensor].x.push(timeMs / 1000); // Convert to seconds
          sensorData[sensor].y.push(voltage);
        }
      }
    } else {
      throw new Error('Unknown CSV format');
    }
    
    // Stop live mode and clear charts
    isPlottingCSV = true;
    liveMode = false;
    if (liveModeChk) liveModeChk.checked = false;
    stopHttpPolling();
    
    // Store data in history for hover functionality
    sensorPressureHistory = [[], [], [], [], [], [], [], []];
    for (let sensor = 1; sensor <= 8; sensor++) {
      const data = sensorData[sensor];
      if (data) {
        for (let i = 0; i < data.x.length; i++) {
          const voltage = data.y[i];
          // Store as voltage (0-3.3V) not percentage
          sensorPressureHistory[sensor - 1].push({ time: data.x[i], pressure: voltage });
        }
      }
    }
    
    // Calculate averages
    for (let i = 0; i < 8; i++) {
      if (sensorPressureHistory[i].length > 0) {
        const sum = sensorPressureHistory[i].reduce((acc, item) => acc + item.pressure, 0);
        sensorPressureAverages[i] = sum / sensorPressureHistory[i].length;
      }
    }
    
    // Update heatmap with averages
    updateHandlebarHeatmap();
    
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
    
    // Add hover events to update heatmap based on cursor position
    chartDivRight.on('plotly_hover', (data) => {
      if (data.points && data.points[0]) {
        hoverTime = data.points[0].x;
        updateHandlebarHeatmap();
      }
    });
    chartDivLeft.on('plotly_hover', (data) => {
      if (data.points && data.points[0]) {
        hoverTime = data.points[0].x;
        updateHandlebarHeatmap();
      }
    });
    
    // Reset to average when not hovering
    chartDivRight.on('plotly_unhover', () => {
      hoverTime = null;
      updateHandlebarHeatmap();
    });
    chartDivLeft.on('plotly_unhover', () => {
      hoverTime = null;
      updateHandlebarHeatmap();
    });
    
    console.log(`Loaded ${filename} with ${lines.length - 1} samples`);
    
    // Update KPIs if elements exist
    if (lines.length > 1) {
      const maxTime = Math.max(...Object.values(sensorData).flatMap(d => d.x));
      if (durationEl) durationEl.textContent = `${maxTime.toFixed(1)}s`;
      if (sampleCountEl) sampleCountEl.textContent = `${lines.length - 1}`;
    }
  } catch (e) {
    alert('Failed to load CSV: ' + e.message);
    console.log(`CSV load error: ${e}`);
  }
}